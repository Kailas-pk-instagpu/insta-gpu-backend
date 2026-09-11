import {
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { AUTH_POOL } from '../common/interfaces/types';
import { UpdateSeatDto } from './dto/update-seat.dto';
import { RedisService } from '../common/redis/redis.service';
import { assertBranchAccess, getUserContext } from '../common/utils/rbac.util';
import { GPU_MODEL_OPTIONS } from '../common/constants/gpu.constants';

@Injectable()
export class SeatsService {
  constructor(
    @Inject(AUTH_POOL) private auth: Pool,
    private redis: RedisService,
  ) {}

  getGpuModels() {
    return GPU_MODEL_OPTIONS;
  }

  /**
   * Update seat label, gpuModel, or status.
   * Enforces: changing status away from 'occupied' clears playerName/startTime/endTime.
   * Writes a server-side audit row in seat_activity_logs for each changed field.
   */
  async updateSeat(seatId: string, dto: UpdateSeatDto, userId: string, role: string) {
    const user = await getUserContext(this.auth, userId, role);

    const { rows: seatRows } = await this.auth.query(`SELECT * FROM seats WHERE id = $1`, [seatId]);
    if (!seatRows.length) {
      throw new NotFoundException(`Seat not found`);
    }

    const currentSeat = seatRows[0];
    await assertBranchAccess(this.auth, user, currentSeat.branch_id);

    const newLabel = dto.label !== undefined ? dto.label : currentSeat.label;
    const newGpu = dto.gpuModel !== undefined ? dto.gpuModel : currentSeat.gpu_model;
    const newStatus = dto.status !== undefined ? dto.status : currentSeat.status;

    let newPlayerName: string | null = null;
    let newStartTime: string | null = null;
    let newEndTime: string | null = null;

    if (newStatus === 'occupied') {
      newPlayerName = dto.playerName !== undefined ? dto.playerName : (currentSeat.player_name || 'Guest');
      newStartTime = dto.startTime !== undefined ? dto.startTime : (currentSeat.start_time || new Date().toISOString());
      newEndTime = dto.endTime !== undefined ? dto.endTime : currentSeat.end_time;
    } else {
      // Enforce: changing away from occupied clears session/player info
      newPlayerName = null;
      newStartTime = null;
      newEndTime = null;
    }

    const client = await this.auth.connect();
    try {
      await client.query('BEGIN');

      // Check differences and insert audit logs
      if (dto.label !== undefined && dto.label !== currentSeat.label) {
        await client.query(
          `INSERT INTO seat_activity_logs (seat_id, seat_number, branch_id, field, from_value, to_value, actor_id, actor_role)
           VALUES ($1, $2, $3, 'label', $4, $5, $6, $7)`,
          [currentSeat.id, currentSeat.seat_number, currentSeat.branch_id, currentSeat.label, dto.label, user.id, user.role],
        );
      }

      if (dto.gpuModel !== undefined && dto.gpuModel !== currentSeat.gpu_model) {
        await client.query(
          `INSERT INTO seat_activity_logs (seat_id, seat_number, branch_id, field, from_value, to_value, actor_id, actor_role)
           VALUES ($1, $2, $3, 'gpuModel', $4, $5, $6, $7)`,
          [currentSeat.id, currentSeat.seat_number, currentSeat.branch_id, currentSeat.gpu_model, dto.gpuModel, user.id, user.role],
        );
      }

      if (dto.status !== undefined && dto.status !== currentSeat.status) {
        await client.query(
          `INSERT INTO seat_activity_logs (seat_id, seat_number, branch_id, field, from_value, to_value, actor_id, actor_role)
           VALUES ($1, $2, $3, 'status', $4, $5, $6, $7)`,
          [currentSeat.id, currentSeat.seat_number, currentSeat.branch_id, currentSeat.status, dto.status, user.id, user.role],
        );
      }

      // Update seat
      const { rows: updatedRows } = await client.query(
        `UPDATE seats
         SET label = $1,
             gpu_model = $2,
             status = $3,
             player_name = $4,
             start_time = $5,
             end_time = $6,
             updated_at = now()
         WHERE id = $7
         RETURNING *`,
        [newLabel, newGpu, newStatus, newPlayerName, newStartTime, newEndTime, seatId],
      );

      await client.query('COMMIT');

      const updated = updatedRows[0];

      // Publish Redis event on status change
      if (dto.status !== undefined && dto.status !== currentSeat.status) {
        await this.redis.publish('seat.status_changed', {
          seat_id: seatId,
          branch_id: currentSeat.branch_id,
          old_status: currentSeat.status,
          new_status: dto.status,
          timestamp: new Date().toISOString(),
        });
      }

      return {
        id: updated.id,
        branchId: updated.branch_id,
        number: updated.seat_number,
        label: updated.label,
        gpuModel: updated.gpu_model,
        status: updated.status,
        playerName: updated.player_name,
        startTime: updated.start_time ? new Date(updated.start_time).toISOString() : null,
        endTime: updated.end_time ? new Date(updated.end_time).toISOString() : null,
        createdAt: updated.created_at ? new Date(updated.created_at).toISOString() : null,
        updatedAt: updated.updated_at ? new Date(updated.updated_at).toISOString() : null,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Activity log for one seat.
   */
  async getSeatActivity(seatId: string, userId: string, role: string, page = 1, limit = 50) {
    const user = await getUserContext(this.auth, userId, role);

    const { rows: seatRows } = await this.auth.query(`SELECT * FROM seats WHERE id = $1`, [seatId]);
    if (!seatRows.length) {
      throw new NotFoundException(`Seat not found`);
    }
    await assertBranchAccess(this.auth, user, seatRows[0].branch_id);

    const offset = (page - 1) * limit;

    const { rows: totalRow } = await this.auth.query(
      `SELECT COUNT(*)::int AS c FROM seat_activity_logs WHERE seat_id = $1`,
      [seatId],
    );

    const { rows } = await this.auth.query(
      `SELECT id, seat_id, seat_number, branch_id, field, from_value, to_value, actor_id, actor_role, created_at
       FROM seat_activity_logs
       WHERE seat_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [seatId, limit, offset],
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
