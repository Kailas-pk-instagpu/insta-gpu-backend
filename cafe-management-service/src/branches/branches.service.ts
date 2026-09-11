import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { AUTH_POOL, SESSION_POOL } from '../common/interfaces/types';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { UpdateBranchStatusDto } from './dto/update-status.dto';
import { UpdateSpendLimitDto } from './dto/update-spend-limit.dto';
import { ProvisionSeatsDto } from '../seats/dto/provision-seats.dto';
import { ApplyGpuDto } from '../seats/dto/apply-gpu.dto';
import {
  assertBranchAccess,
  buildBranchRoleFilter,
  getUserContext,
} from '../common/utils/rbac.util';
import { GPU_MODEL_OPTIONS } from '../common/constants/gpu.constants';

@Injectable()
export class BranchesService {
  constructor(
    @Inject(AUTH_POOL) private auth: Pool,
    @Inject(SESSION_POOL) private session: Pool,
  ) { }

  getGpuModels() {
    return GPU_MODEL_OPTIONS;
  }

  /**
   * Helper to format a DB row into standard BranchResponse camelCase shape
   */
  private formatBranch(b: any, extra?: { activeSeats?: number; revenueToday?: string; activeSessions?: number }) {
    const activeSeats = extra?.activeSeats !== undefined ? extra.activeSeats : Number(b.active_seats ?? 0);
    return {
      id: b.id,
      name: b.name,
      address: b.address || b.location || '',
      location: b.location || b.address || '',
      cafeId: b.cafe_id ?? null,
      totalSeats: Number(b.total_seats ?? b.actual_seats ?? 0),
      activeSeats,
      seat_count: Number(b.total_seats ?? b.actual_seats ?? 0),
      active_session_count: extra?.activeSessions ?? activeSeats,
      revenue_today: extra?.revenueToday ?? '0.00',
      status: b.status,
      adminId: b.admin_id ?? null,
      cafeOwnerId: b.cafe_owner_id ?? b.owner_id ?? null,
      managerId: b.manager_id ?? null,
      billing: {
        hourlyRate: Number(b.hourly_rate ?? 5.0),
        currency: b.currency || 'USD',
        dailySpendLimit: b.daily_spend_limit !== null ? Number(b.daily_spend_limit) : null,
      },
      createdAt: b.created_at ? new Date(b.created_at).toISOString() : new Date().toISOString(),
      updatedAt: b.updated_at ? new Date(b.updated_at).toISOString() : new Date().toISOString(),
    };
  }

  /**
   * List branches scoped to caller role.
   */
  async listBranches(userId: string, role: string) {
    const user = await getUserContext(this.auth, userId, role);
    const filter = buildBranchRoleFilter(user);

    const query = `
      SELECT b.*,
             COUNT(s.id)::int AS actual_seats,
             COUNT(s.id) FILTER (WHERE s.status = 'occupied')::int AS active_seats
      FROM branches b
      LEFT JOIN seats s ON s.branch_id = b.id
      WHERE ${filter.clause}
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `;

    const { rows: branches } = await this.auth.query(query, filter.params);

    const result = [];
    for (const b of branches) {
      let revenueToday = '0.00';
      let activeSessions = 0;

      try {
        const { rows: ac } = await this.session.query(
          `SELECT COUNT(*)::int AS c FROM sessions WHERE status='active' AND branch_id=$1`,
          [b.id],
        );
        activeSessions = ac[0]?.c ?? 0;

        const { rows: rev } = await this.session.query(
          `SELECT COALESCE(SUM(amount),0)::numeric(10,2) AS r
           FROM settlements WHERE branch_id=$1 AND settled_at::date=CURRENT_DATE`,
          [b.id],
        );
        revenueToday = Number(rev[0]?.r ?? 0).toFixed(2);
      } catch {
        // Fallback gracefully if session/settlement db tables are not populated in dev
      }

      result.push(
        this.formatBranch(b, {
          activeSeats: Number(b.active_seats ?? 0),
          revenueToday,
          activeSessions,
        }),
      );
    }
    return result;
  }

  /**
   * Get single branch detail scoped to caller role.
   */
  async getBranch(id: string, userId: string, role: string) {
    const user = await getUserContext(this.auth, userId, role);
    await assertBranchAccess(this.auth, user, id);

    const { rows } = await this.auth.query(
      `SELECT b.*,
              COUNT(s.id)::int AS actual_seats,
              COUNT(s.id) FILTER (WHERE s.status = 'occupied')::int AS active_seats
       FROM branches b
       LEFT JOIN seats s ON s.branch_id = b.id
       WHERE b.id = $1
       GROUP BY b.id`,
      [id],
    );

    if (!rows.length) {
      throw new NotFoundException(`Branch not found`);
    }

    return this.formatBranch(rows[0]);
  }

  /**
   * Create branch and provision initial totalSeats.
   */
  async createBranch(dto: CreateBranchDto, userId: string, role: string) {
    const user = await getUserContext(this.auth, userId, role);
    if (user.role === 'manager') {
      throw new BadRequestException('Managers are not permitted to create branches');
    }

    const client = await this.auth.connect();
    try {
      await client.query('BEGIN');

      const ownerId = dto.cafeOwnerId || (user.role === 'cafe_owner' ? user.id : null);
      const totalSeats = dto.totalSeats ?? 0;
      const defaultGpu = dto.defaultGpuModel || 'RTX 4070';

      const insertBranchQuery = `
        INSERT INTO branches (
          name, address, location, cafe_id, total_seats, status,
          owner_id, cafe_owner_id, admin_id, manager_id,
          hourly_rate, currency, daily_spend_limit, updated_at
        )
        VALUES ($1, $2, $2, $3, $4, 'active', $5, $5, $6, $7, $8, $9, $10, now())
        RETURNING *
      `;

      const { rows: branchRows } = await client.query(insertBranchQuery, [
        dto.name,
        dto.address,
        dto.cafeId ?? user.cafeId ?? null,
        totalSeats,
        ownerId,
        dto.adminId ?? null,
        dto.managerId ?? null,
        dto.hourlyRate ?? 5.0,
        dto.currency ?? 'USD',
        dto.dailySpendLimit ?? null,
      ]);

      const newBranch = branchRows[0];

      // Provision initial seats if totalSeats > 0
      if (totalSeats > 0) {
        for (let i = 1; i <= totalSeats; i++) {
          await client.query(
            `INSERT INTO seats (branch_id, seat_number, gpu_model, status, label)
             VALUES ($1, $2, $3, 'available', $4)`,
            [newBranch.id, i, defaultGpu, `Seat-${i}`],
          );
        }
      }

      await client.query('COMMIT');
      return this.formatBranch(newBranch, { activeSeats: 0 });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Update branch details & sync seats count.
   */
  async updateBranch(id: string, dto: UpdateBranchDto, userId: string, role: string) {
    const user = await getUserContext(this.auth, userId, role);
    if (user.role === 'manager') {
      throw new BadRequestException('Managers cannot update branch settings');
    }
    const currentBranch = await assertBranchAccess(this.auth, user, id);

    const client = await this.auth.connect();
    try {
      await client.query('BEGIN');

      // 1. If totalSeats change requested, sync seats
      if (dto.totalSeats !== undefined && dto.totalSeats !== null) {
        const newTotal = dto.totalSeats;

        // Current seats breakdown
        const { rows: seatStats } = await client.query(
          `SELECT
             COUNT(*)::int AS total_count,
             COUNT(*) FILTER (WHERE status = 'occupied')::int AS occupied_count,
             COALESCE(MAX(seat_number), 0)::int AS max_number
           FROM seats WHERE branch_id = $1`,
          [id],
        );

        const currentTotal = seatStats[0].total_count;
        const occupiedCount = seatStats[0].occupied_count;
        let maxNumber = seatStats[0].max_number;

        if (newTotal < occupiedCount) {
          throw new BadRequestException(
            `Cannot reduce total seats to ${newTotal} because ${occupiedCount} seat(s) are currently occupied. Please end active sessions or reassign players first.`,
          );
        }

        if (newTotal > currentTotal) {
          const toAdd = newTotal - currentTotal;
          const gpu = dto.defaultGpuModel || 'RTX 4070';
          for (let i = 1; i <= toAdd; i++) {
            maxNumber += 1;
            await client.query(
              `INSERT INTO seats (branch_id, seat_number, gpu_model, status, label)
               VALUES ($1, $2, $3, 'available', $4)`,
              [id, maxNumber, gpu, `Seat-${maxNumber}`],
            );
          }
        } else if (newTotal < currentTotal) {
          const toRemove = currentTotal - newTotal;
          // Delete non-occupied seats from highest seat number downwards
          await client.query(
            `DELETE FROM seats
             WHERE id IN (
               SELECT id FROM seats
               WHERE branch_id = $1 AND status != 'occupied'
               ORDER BY seat_number DESC
               LIMIT $2
             )`,
            [id, toRemove],
          );
        }
      }

      // Update fields
      const { rows: updatedRows } = await client.query(
        `UPDATE branches
         SET name = COALESCE($1, name),
             address = COALESCE($2, address),
             location = COALESCE($2, location),
             cafe_id = COALESCE($3, cafe_id),
             total_seats = COALESCE($4, total_seats),
             admin_id = CASE WHEN $5::boolean THEN $6::uuid ELSE admin_id END,
             cafe_owner_id = CASE WHEN $7::boolean THEN $8::uuid ELSE cafe_owner_id END,
             manager_id = CASE WHEN $9::boolean THEN $10::uuid ELSE manager_id END,
             hourly_rate = COALESCE($11, hourly_rate),
             currency = COALESCE($12, currency),
             daily_spend_limit = CASE WHEN $13::boolean THEN $14::numeric ELSE daily_spend_limit END,
             updated_at = now()
         WHERE id = $15
         RETURNING *`,
        [
          dto.name ?? null,
          dto.address ?? null,
          dto.cafeId ?? null,
          dto.totalSeats !== undefined ? dto.totalSeats : null,
          dto.adminId !== undefined,
          dto.adminId ?? null,
          dto.cafeOwnerId !== undefined,
          dto.cafeOwnerId ?? null,
          dto.managerId !== undefined,
          dto.managerId ?? null,
          dto.hourlyRate ?? null,
          dto.currency ?? null,
          dto.dailySpendLimit !== undefined,
          dto.dailySpendLimit ?? null,
          id,
        ],
      );

      await client.query('COMMIT');

      // Fetch live active seats
      const { rows: activeRow } = await this.auth.query(
        `SELECT COUNT(*)::int AS c FROM seats WHERE branch_id = $1 AND status = 'occupied'`,
        [id],
      );

      return this.formatBranch(updatedRows[0], { activeSeats: activeRow[0]?.c ?? 0 });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Update status ('active' | 'inactive' | 'maintenance').
   */
  async updateStatus(id: string, dto: UpdateBranchStatusDto, userId: string, role: string) {
    const user = await getUserContext(this.auth, userId, role);
    if (user.role === 'manager') {
      throw new BadRequestException('Managers cannot toggle branch status');
    }
    await assertBranchAccess(this.auth, user, id);

    const { rows } = await this.auth.query(
      `UPDATE branches SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [dto.status, id],
    );

    const { rows: activeRow } = await this.auth.query(
      `SELECT COUNT(*)::int AS c FROM seats WHERE branch_id = $1 AND status = 'occupied'`,
      [id],
    );

    return this.formatBranch(rows[0], { activeSeats: activeRow[0]?.c ?? 0 });
  }

  /**
   * Set/update dailySpendLimit threshold for this branch.
   */
  async updateSpendLimit(id: string, dto: UpdateSpendLimitDto, userId: string, role: string) {
    const user = await getUserContext(this.auth, userId, role);
    if (user.role === 'manager') {
      throw new BadRequestException('Managers cannot update spend limit');
    }
    await assertBranchAccess(this.auth, user, id);

    const { rows } = await this.auth.query(
      `UPDATE branches SET daily_spend_limit = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [dto.dailySpendLimit, id],
    );

    const { rows: activeRow } = await this.auth.query(
      `SELECT COUNT(*)::int AS c FROM seats WHERE branch_id = $1 AND status = 'occupied'`,
      [id],
    );

    return this.formatBranch(rows[0], { activeSeats: activeRow[0]?.c ?? 0 });
  }

  /**
   * Delete branch — blocked if the branch contains any seats.
   */
  async deleteBranch(id: string, userId: string, role: string) {
    const user = await getUserContext(this.auth, userId, role);
    if (user.role === 'manager') {
      throw new BadRequestException('Managers cannot delete branches');
    }
    await assertBranchAccess(this.auth, user, id);

    const { rows: countRows } = await this.auth.query(
      `SELECT COUNT(*)::int AS c FROM seats WHERE branch_id = $1`,
      [id],
    );

    const seatCount = countRows[0]?.c ?? 0;
    if (seatCount > 0) {
      throw new BadRequestException(
        `Cannot delete branch because it still contains ${seatCount} seat(s). Please de-provision or remove all seats first.`,
      );
    }

    await this.auth.query(`DELETE FROM branches WHERE id = $1`, [id]);
    return { id, deleted: true };
  }

  /**
   * Bulk provision N seats for a branch.
   */
  async provisionSeats(branchId: string, dto: ProvisionSeatsDto, userId: string, role: string) {
    const user = await getUserContext(this.auth, userId, role);
    await assertBranchAccess(this.auth, user, branchId);

    const client = await this.auth.connect();
    try {
      await client.query('BEGIN');

      const { rows: maxRow } = await client.query(
        `SELECT COALESCE(MAX(seat_number), 0)::int AS m FROM seats WHERE branch_id = $1`,
        [branchId],
      );
      let currentMax = maxRow[0].m;

      const created = [];
      const prefix = dto.labelPrefix || 'Seat-';

      for (let i = 1; i <= dto.count; i++) {
        currentMax += 1;
        const label = `${prefix}${currentMax}`;
        const { rows } = await client.query(
          `INSERT INTO seats (branch_id, seat_number, gpu_model, status, label)
           VALUES ($1, $2, $3, 'available', $4)
           RETURNING *`,
          [branchId, currentMax, dto.gpuModel, label],
        );
        created.push(rows[0]);
      }

      // Update branch total_seats to reflect new count
      await client.query(
        `UPDATE branches
         SET total_seats = (SELECT COUNT(*)::int FROM seats WHERE branch_id = $1),
             updated_at = now()
         WHERE id = $1`,
        [branchId],
      );

      await client.query('COMMIT');

      return created.map((s) => ({
        id: s.id,
        branchId: s.branch_id,
        number: s.seat_number,
        label: s.label,
        gpuModel: s.gpu_model,
        status: s.status,
        playerName: s.player_name,
        startTime: s.start_time,
        endTime: s.end_time,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      }));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * List seats for a branch, joining live session data if occupied.
   */
  async listSeats(branchId: string, userId?: string, role?: string) {
    if (userId && role) {
      const user = await getUserContext(this.auth, userId, role);
      await assertBranchAccess(this.auth, user, branchId);
    }

    const { rows: seats } = await this.auth.query(
      `SELECT id, branch_id, seat_number, label, gpu_model, status, player_name, start_time, end_time, created_at, updated_at
       FROM seats WHERE branch_id = $1 ORDER BY seat_number ASC`,
      [branchId],
    );

    const occupiedIds = seats.filter((s) => s.status === 'occupied').map((s) => s.id);
    const activeMap = new Map<string, any>();

    if (occupiedIds.length) {
      try {
        const { rows } = await this.session.query(
          `SELECT seat_id, player_name, started_at, cost_per_hour
           FROM sessions WHERE status='active' AND seat_id = ANY($1::uuid[])`,
          [occupiedIds],
        );

        for (const r of rows) {
          const elapsed = Math.round((Date.now() - new Date(r.started_at).getTime()) / 60000);
          const cost = Math.round((elapsed / 60) * Number(r.cost_per_hour) * 100) / 100;
          activeMap.set(r.seat_id, {
            player_name: r.player_name,
            started_at: new Date(r.started_at).toISOString(),
            elapsed_minutes: elapsed,
            live_cost: cost.toFixed(2),
          });
        }
      } catch {
        // Fallback gracefully
      }
    }

    return seats.map((s) => {
      const sessionData = activeMap.get(s.id);
      return {
        id: s.id,
        branchId: s.branch_id,
        number: s.seat_number,
        label: s.label,
        gpuModel: s.gpu_model,
        status: s.status,
        playerName: sessionData?.player_name || s.player_name || null,
        startTime: sessionData?.started_at || (s.start_time ? new Date(s.start_time).toISOString() : null),
        endTime: s.end_time ? new Date(s.end_time).toISOString() : null,
        createdAt: s.created_at ? new Date(s.created_at).toISOString() : null,
        updatedAt: s.updated_at ? new Date(s.updated_at).toISOString() : null,
        ...(sessionData ? { activeSession: sessionData } : {}),
      };
    });
  }

  /**
   * Bulk-apply one GPU model to every non-occupied seat in the branch.
   */
  async applyGpuToBranch(branchId: string, dto: ApplyGpuDto, userId: string, role: string) {
    const user = await getUserContext(this.auth, userId, role);
    await assertBranchAccess(this.auth, user, branchId);

    const client = await this.auth.connect();
    try {
      await client.query('BEGIN');

      const { rows: eligibleSeats } = await client.query(
        `SELECT id, seat_number, gpu_model
         FROM seats
         WHERE branch_id = $1 AND status != 'occupied' AND gpu_model != $2`,
        [branchId, dto.gpuModel],
      );

      for (const s of eligibleSeats) {
        await client.query(`UPDATE seats SET gpu_model = $1, updated_at = now() WHERE id = $2`, [
          dto.gpuModel,
          s.id,
        ]);

        await client.query(
          `INSERT INTO seat_activity_logs (seat_id, seat_number, branch_id, field, from_value, to_value, actor_id, actor_role)
           VALUES ($1, $2, $3, 'gpuModel', $4, $5, $6, $7)`,
          [s.id, s.seat_number, branchId, s.gpu_model, dto.gpuModel, user.id, user.role],
        );
      }

      await client.query('COMMIT');
      return { updatedCount: eligibleSeats.length, gpuModel: dto.gpuModel };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get seat activity audit log for a branch.
   */
  async getBranchActivity(branchId: string, userId: string, role: string, page = 1, limit = 50) {
    const user = await getUserContext(this.auth, userId, role);
    await assertBranchAccess(this.auth, user, branchId);

    const offset = (page - 1) * limit;

    const { rows: totalRow } = await this.auth.query(
      `SELECT COUNT(*)::int AS c FROM seat_activity_logs WHERE branch_id = $1`,
      [branchId],
    );

    const { rows } = await this.auth.query(
      `SELECT id, seat_id, seat_number, branch_id, field, from_value, to_value, actor_id, actor_role, created_at
       FROM seat_activity_logs
       WHERE branch_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [branchId, limit, offset],
    );

    return {
      items: rows.map((r) => ({
        id: r.id,
        seatId: r.seat_id,
        seatNumber: r.seat_number,
        branchId: r.branch_id,
        field: r.field,
        fromValue: r.from_value,
        toValue: r.to_value,
        actorId: r.actor_id,
        actorRole: r.actor_role,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      })),
      total: totalRow[0]?.c ?? 0,
      page,
      limit,
    };
  }
}
