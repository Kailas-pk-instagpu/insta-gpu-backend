import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { AUTH_POOL, SESSION_POOL } from '../common/interfaces/types';

@Injectable()
export class BranchesService {
  constructor(
    @Inject(AUTH_POOL) private auth: Pool,
    @Inject(SESSION_POOL) private session: Pool,
  ) {}

  async listBranches(userId: string, role: string) {
    let branches: any[];
    if (role === 'cafe_owner') {
      ({ rows: branches } = await this.auth.query(
        `SELECT * FROM branches WHERE owner_id=$1`, [userId]));
    } else {
      const { rows: u } = await this.auth.query(`SELECT branch_id FROM users WHERE id=$1`, [userId]);
      if (!u[0]?.branch_id) return [];
      ({ rows: branches } = await this.auth.query(`SELECT * FROM branches WHERE id=$1`, [u[0].branch_id]));
    }

    const out = [];
    for (const b of branches) {
      const { rows: sc } = await this.auth.query(`SELECT COUNT(*)::int AS c FROM seats WHERE branch_id=$1`, [b.id]);
      const { rows: ac } = await this.session.query(
        `SELECT COUNT(*)::int AS c FROM sessions WHERE status='active' AND branch_id=$1`, [b.id]);
      const { rows: rev } = await this.session.query(
        `SELECT COALESCE(SUM(amount),0)::numeric(10,2) AS r
         FROM settlements WHERE branch_id=$1 AND settled_at::date=CURRENT_DATE`, [b.id]);
      out.push({
        id: b.id, name: b.name, location: b.location, status: b.status,
        seat_count: sc[0].c, active_session_count: ac[0].c,
        revenue_today: Number(rev[0].r).toFixed(2),
      });
    }
    return out;
  }

  async listSeats(branchId: string) {
    const { rows: seats } = await this.auth.query(
      `SELECT id, seat_number, gpu_model, status FROM seats WHERE branch_id=$1 ORDER BY seat_number`,
      [branchId],
    );
    const occupiedIds = seats.filter(s => s.status === 'occupied').map(s => s.id);
    let active = new Map<string, any>();
    if (occupiedIds.length) {
      const { rows } = await this.session.query(
        `SELECT seat_id, player_name, started_at, cost_per_hour
         FROM sessions WHERE status='active' AND seat_id = ANY($1::uuid[])`, [occupiedIds]);
      for (const r of rows) {
        const elapsed = Math.round((Date.now() - new Date(r.started_at).getTime()) / 60000);
        const cost = Math.round((elapsed / 60) * Number(r.cost_per_hour) * 100) / 100;
        active.set(r.seat_id, {
          player_name: r.player_name,
          started_at: new Date(r.started_at).toISOString(),
          elapsed_minutes: elapsed, live_cost: cost.toFixed(2),
        });
      }
    }
    return seats.map(s => ({ ...s, ...(active.has(s.id) ? { active_session: active.get(s.id) } : {}) }));
  }
}
