import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { AUTH_POOL, SESSION_POOL } from '../db/db.module';
import { EventsService } from '../events/events.service';

function badge(elapsed: number) {
  if (elapsed < 60) return 'Normal';
  if (elapsed <= 90) return 'Warning';
  return 'Near limit';
}

@Injectable()
export class SessionsService {
  constructor(
    @Inject(AUTH_POOL) private auth: Pool,
    @Inject(SESSION_POOL) private session: Pool,
    private events: EventsService,
  ) {}

  async activeForBranch(branchId: string) {
    const { rows } = await this.session.query(
      `SELECT * FROM sessions WHERE status='active' AND branch_id=$1`,
      [branchId],
    );
    const seatIds = rows.map((r) => r.seat_id);
    let seatMap = new Map<string, any>();
    if (seatIds.length) {
      const { rows: seats } = await this.auth.query(
        `SELECT id, seat_number, gpu_model FROM seats WHERE id = ANY($1::uuid[])`,
        [seatIds],
      );
      for (const s of seats) seatMap.set(s.id, s);
    }
    return rows.map((r) => {
      const seat = seatMap.get(r.seat_id) || {};
      const elapsed = Math.round((Date.now() - new Date(r.started_at).getTime()) / 60000);
      const cost = Math.round((elapsed / 60) * Number(r.cost_per_hour) * 100) / 100;
      return {
        id: r.id,
        seat_number: seat.seat_number,
        gpu_model: seat.gpu_model,
        player_name: r.player_name,
        started_at: new Date(r.started_at).toISOString(),
        elapsed_minutes: elapsed,
        live_cost: cost.toFixed(2),
        status_badge: badge(elapsed),
      };
    });
  }

  async start(role: string, seatId: string, playerName: string) {
    if (role !== 'manager') throw new ForbiddenException('Manager role required');
    const { rows: seats } = await this.auth.query('SELECT * FROM seats WHERE id=$1', [seatId]);
    const seat = seats[0];
    if (!seat) throw new NotFoundException('Seat not found');
    if (seat.status !== 'available') throw new ConflictException('Seat not available');

    const { rows } = await this.session.query(
      `INSERT INTO sessions (seat_id, branch_id, player_name, cost_per_hour)
       VALUES ($1,$2,$3,5.00) RETURNING *`,
      [seat.id, seat.branch_id, playerName],
    );
    await this.auth.query(`UPDATE seats SET status='occupied' WHERE id=$1`, [seat.id]);
    const created = rows[0];

    await this.events.setActive(created.id, {
      player_name: created.player_name,
      started_at: created.started_at,
      cost_per_hour: created.cost_per_hour,
    });
    await this.events.publish('session.started', {
      session_id: created.id, seat_id: seat.id, seat_number: seat.seat_number,
      branch_id: seat.branch_id, player_name: created.player_name,
      started_at: new Date(created.started_at).toISOString(),
    });
    return created;
  }

  async end(role: string, sessionId: string) {
    if (role !== 'manager') throw new ForbiddenException('Manager role required');
    const { rows } = await this.session.query('SELECT * FROM sessions WHERE id=$1', [sessionId]);
    const s = rows[0];
    if (!s) throw new NotFoundException('Session not found');
    if (s.status !== 'active') throw new ConflictException('Session already ended');

    const endedAt = new Date();
    const duration = Math.round((endedAt.getTime() - new Date(s.started_at).getTime()) / 60000);
    const totalCost = Math.round((duration / 60) * Number(s.cost_per_hour) * 100) / 100;

    const { rows: updatedRows } = await this.session.query(
      `UPDATE sessions SET ended_at=$1, duration_minutes=$2, total_cost=$3, status='completed'
       WHERE id=$4 RETURNING *`,
      [endedAt, duration, totalCost, sessionId],
    );
    await this.auth.query(`UPDATE seats SET status='available' WHERE id=$1`, [s.seat_id]);
    await this.events.delActive(sessionId);
    await this.events.publish('session.ended', {
      session_id: sessionId, seat_id: s.seat_id, branch_id: s.branch_id,
      total_cost: totalCost.toFixed(2), duration_minutes: duration,
      ended_at: endedAt.toISOString(),
    });
    return {
      session: updatedRows[0],
      settlement_preview: {
        amount: totalCost.toFixed(2),
        duration_minutes: duration,
        formatted_cost: `$${totalCost.toFixed(2)}`,
      },
    };
  }

  async dashboard(branchId: string) {
    const { rows: br } = await this.auth.query('SELECT name FROM branches WHERE id=$1', [branchId]);
    const { rows: seats } = await this.auth.query(
      `SELECT status, COUNT(*)::int AS c FROM seats WHERE branch_id=$1 GROUP BY status`,
      [branchId],
    );
    const counts: Record<string, number> = { available: 0, occupied: 0, maintenance: 0 };
    for (const r of seats) counts[r.status] = r.c;

    const active = await this.activeForBranch(branchId);
    const liveTotal = active.reduce((sum, a) => sum + Number(a.live_cost), 0);

    const { rows: rev } = await this.session.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(10,2) AS rev
       FROM settlements WHERE branch_id=$1 AND settled_at::date = CURRENT_DATE`,
      [branchId],
    );

    return {
      branch_name: br[0]?.name,
      available_seats: counts.available,
      occupied_seats: counts.occupied,
      maintenance_seats: counts.maintenance,
      active_sessions: active.length,
      revenue_today: Number(rev[0].rev).toFixed(2),
      live_billing_banner: {
        active_count: active.length,
        total_live_cost: liveTotal.toFixed(2),
      },
    };
  }
}
