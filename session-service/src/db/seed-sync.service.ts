import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { AUTH_POOL, SESSION_POOL } from './db.module';

/**
 * On boot, hydrate the zero-UUID placeholders in session_db with real
 * seat_id / branch_id values from auth_db so seeded historic + active
 * sessions are linked to the real seeded branch.
 */
@Injectable()
export class SeedSyncService {
  constructor(
    @Inject(AUTH_POOL) private auth: Pool,
    @Inject(SESSION_POOL) private session: Pool,
  ) {}

  async syncOnce() {
    const { rows: branches } = await this.auth.query('SELECT id FROM branches LIMIT 1');
    if (!branches[0]) return;
    const branchId = branches[0].id;

    const { rows: seats } = await this.auth.query(
      `SELECT id, seat_number FROM seats WHERE branch_id=$1 ORDER BY seat_number`,
      [branchId],
    );
    const seatByNumber = new Map<number, string>();
    for (const s of seats) seatByNumber.set(s.seat_number, s.id);

    // Patch active sessions: bind Player A/B/C to seats 1/5/9.
    const playerToSeat: Record<string, number> = { 'Player A': 1, 'Player B': 5, 'Player C': 9 };
    for (const [player, num] of Object.entries(playerToSeat)) {
      const seatId = seatByNumber.get(num);
      if (!seatId) continue;
      await this.session.query(
        `UPDATE sessions SET seat_id=$1, branch_id=$2
         WHERE player_name=$3 AND seat_id='00000000-0000-0000-0000-000000000000'`,
        [seatId, branchId, player],
      );
    }

    // Patch historical sessions/settlements to the real branch (seat_id stays the zero placeholder
    // for historics — seat_number is looked up only for active joins).
    await this.session.query(
      `UPDATE sessions SET branch_id=$1
       WHERE branch_id='00000000-0000-0000-0000-000000000000'`,
      [branchId],
    );
    await this.session.query(
      `UPDATE settlements SET branch_id=$1
       WHERE branch_id='00000000-0000-0000-0000-000000000000'`,
      [branchId],
    );
  }
}
