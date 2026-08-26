import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { AUTH_POOL, SESSION_POOL } from '../common/interfaces/types';

@Injectable()
export class SettlementsService {
  constructor(
    @Inject(AUTH_POOL) private auth: Pool,
    @Inject(SESSION_POOL) private session: Pool,
  ) {}

  async listSettlements(
    userId: string,
    role: string,
    branchHeader: string,
    pageStr = '1',
    limitStr = '10',
  ) {
    const page = Math.max(1, Number(pageStr) || 1);
    const limit = Math.min(100, Math.max(1, Number(limitStr) || 10));
    const offset = (page - 1) * limit;

    let branchIds: string[];
    if (role === 'cafe_owner') {
      const { rows } = await this.auth.query(`SELECT id FROM branches WHERE owner_id=$1`, [userId]);
      branchIds = rows.map(r => r.id);
    } else {
      branchIds = branchHeader ? [branchHeader] : [];
    }
    if (!branchIds.length) {
      return { items: [], total: 0, page, limit };
    }

    const { rows: totalRow } = await this.session.query(
      `SELECT COUNT(*)::int AS c FROM settlements WHERE branch_id = ANY($1::uuid[])`,
      [branchIds]);
    const { rows } = await this.session.query(
      `SELECT s.id, s.session_id, s.amount, s.payment_method, s.settled_at,
              se.player_name, se.duration_minutes, se.seat_id
       FROM settlements s
       JOIN sessions se ON se.id = s.session_id
       WHERE s.branch_id = ANY($1::uuid[])
       ORDER BY s.settled_at DESC
       LIMIT $2 OFFSET $3`,
      [branchIds, limit, offset]);

    const seatIds = rows.map(r => r.seat_id).filter(Boolean);
    const seatMap = new Map<string, number>();
    if (seatIds.length) {
      const { rows: seats } = await this.auth.query(
        `SELECT id, seat_number FROM seats WHERE id = ANY($1::uuid[])`, [seatIds]);
      for (const s of seats) seatMap.set(s.id, s.seat_number);
    }

    return {
      items: rows.map(r => ({
        id: r.id, session_id: r.session_id,
        amount: Number(r.amount).toFixed(2),
        payment_method: r.payment_method,
        settled_at: new Date(r.settled_at).toISOString(),
        seat_number: seatMap.get(r.seat_id) ?? null,
        player_name: r.player_name,
        duration_minutes: r.duration_minutes,
      })),
      total: totalRow[0].c,
      page,
      limit,
    };
  }
}
