import { Controller, Get, Param, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { AUTH_POOL, SESSION_POOL } from '../db/db.module';
import { ApiResponse } from '../common/response.util';

@Controller('seats')
export class SeatsController {
  constructor(
    @Inject(AUTH_POOL) private auth: Pool,
    @Inject(SESSION_POOL) private session: Pool,
  ) {}

  /** Return all seats for a branch with live session data on occupied seats. */
  @Get(':branchId')
  async list(@Param('branchId') branchId: string) {
    const { rows: seats } = await this.auth.query(
      `SELECT id, seat_number, gpu_model, status FROM seats WHERE branch_id=$1 ORDER BY seat_number`,
      [branchId],
    );
    const occupiedIds = seats.filter((s) => s.status === 'occupied').map((s) => s.id);
    let activeMap = new Map<string, any>();
    if (occupiedIds.length) {
      const { rows: active } = await this.session.query(
        `SELECT seat_id, player_name, started_at, cost_per_hour
         FROM sessions WHERE status='active' AND seat_id = ANY($1::uuid[])`,
        [occupiedIds],
      );
      for (const a of active) {
        const elapsed = Math.round((Date.now() - new Date(a.started_at).getTime()) / 60000);
        const cost = Math.round((elapsed / 60) * Number(a.cost_per_hour) * 100) / 100;
        activeMap.set(a.seat_id, {
          player_name: a.player_name,
          started_at: new Date(a.started_at).toISOString(),
          elapsed_minutes: elapsed,
          live_cost: cost.toFixed(2),
        });
      }
    }
    const data = seats.map((s) => ({
      ...s,
      ...(activeMap.has(s.id) ? { active_session: activeMap.get(s.id) } : {}),
    }));
    return new ApiResponse(data, 'Seats fetched successfully');
  }
}
