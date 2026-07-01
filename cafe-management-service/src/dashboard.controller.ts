import { Controller, Get, Headers, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { AUTH_POOL, SESSION_POOL } from './types';
import { ApiResponse } from './response.util';

@Controller('dashboard')
export class DashboardController {
  constructor(
    @Inject(AUTH_POOL) private auth: Pool,
    @Inject(SESSION_POOL) private session: Pool,
  ) {}

  /** Cafe-owner dashboard: aggregate KPIs across owned branches. */
  @Get('owner')
  async owner(@Headers('x-user-id') ownerId: string) {
    const { rows: branches } = await this.auth.query(
      `SELECT * FROM branches WHERE owner_id=$1`, [ownerId]);
    const branchIds = branches.map(b => b.id);
    if (!branchIds.length) {
      const emptyData = {
        total_revenue_today: '0.00', total_revenue_week: '0.00',
        active_sessions: 0, total_sessions_today: 0, branches: [],
      };
      return new ApiResponse(emptyData, 'No branches found for owner');
    }

    const { rows: today } = await this.session.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(10,2) AS r
       FROM settlements WHERE branch_id = ANY($1::uuid[]) AND settled_at::date=CURRENT_DATE`,
      [branchIds]);
    const { rows: week } = await this.session.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(10,2) AS r
       FROM settlements WHERE branch_id = ANY($1::uuid[]) AND settled_at >= now() - interval '7 days'`,
      [branchIds]);
    const { rows: act } = await this.session.query(
      `SELECT COUNT(*)::int AS c FROM sessions WHERE status='active' AND branch_id = ANY($1::uuid[])`,
      [branchIds]);
    const { rows: tot } = await this.session.query(
      `SELECT COUNT(*)::int AS c FROM sessions WHERE branch_id = ANY($1::uuid[]) AND started_at::date=CURRENT_DATE`,
      [branchIds]);

    const perBranch = [];
    for (const b of branches) {
      const { rows: bAct } = await this.session.query(
        `SELECT COUNT(*)::int AS c FROM sessions WHERE status='active' AND branch_id=$1`, [b.id]);
      const { rows: bRev } = await this.session.query(
        `SELECT COALESCE(SUM(amount),0)::numeric(10,2) AS r
         FROM settlements WHERE branch_id=$1 AND settled_at::date=CURRENT_DATE`, [b.id]);
      const { rows: seatCounts } = await this.auth.query(
        `SELECT status, COUNT(*)::int AS c FROM seats WHERE branch_id=$1 GROUP BY status`, [b.id]);
      let occupied = 0, total = 0;
      for (const r of seatCounts) { total += r.c; if (r.status === 'occupied') occupied = r.c; }
      perBranch.push({
        id: b.id, name: b.name, active_sessions: bAct[0].c,
        revenue_today: Number(bRev[0].r).toFixed(2),
        occupied_seats: occupied, total_seats: total,
      });
    }

    const data = {
      total_revenue_today: Number(today[0].r).toFixed(2),
      total_revenue_week: Number(week[0].r).toFixed(2),
      active_sessions: act[0].c,
      total_sessions_today: tot[0].c,
      branches: perBranch,
    };
    return new ApiResponse(data, 'Owner dashboard data fetched successfully');
  }
}
