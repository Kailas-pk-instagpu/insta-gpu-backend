import { Inject, Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { AUTH_POOL } from '../common/interfaces/types';
import { assertBranchAccess, getUserContext } from '../common/utils/rbac.util';

@Injectable()
export class BillingService {
  private readonly settlementUrl =
    process.env.SETTLEMENT_WORKER_URL || 'http://settlement-worker:8001';
  private readonly internalToken = process.env.INTERNAL_API_TOKEN || '';

  constructor(@Inject(AUTH_POOL) private readonly pool: Pool) {}

  async listInvoices(
    userId: string,
    role: string,
    branchId: string,
    opts: {
      page?: string;
      limit?: string;
      status?: string;
      from?: string;
      to?: string;
    },
  ) {
    const user = await getUserContext(this.pool, userId, role);
    await assertBranchAccess(this.pool, user, branchId);

    const page = Math.max(1, Number(opts.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(opts.limit) || 20));
    const offset = (page - 1) * limit;

    const statuses = (opts.status || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const params: any[] = [branchId];
    const where: string[] = ['i.branch_id = $1'];

    if (statuses.length) {
      params.push(statuses);
      where.push(`i.status = ANY($${params.length}::text[])`);
    }
    if (opts.from) {
      params.push(opts.from);
      where.push(`i.date >= $${params.length}::date`);
    }
    if (opts.to) {
      params.push(opts.to);
      where.push(`i.date <= $${params.length}::date`);
    }

    const whereSql = where.join(' AND ');

    const countRes = await this.pool.query(
      `SELECT COUNT(*)::int AS c FROM invoices i WHERE ${whereSql}`,
      params,
    );

    params.push(limit, offset);
    const { rows } = await this.pool.query(
      `SELECT i.id, i.branch_id, i.date, i.total_amount, i.currency, i.status,
              i.stripe_payment_intent_id, i.attempt_count, i.last_error,
              i.last_attempted_at, i.created_at, i.paid_at,
              b.name AS branch_name
         FROM invoices i
         JOIN branches b ON b.id = i.branch_id
        WHERE ${whereSql}
        ORDER BY i.date DESC, i.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      items: rows.map((r) => this.serializeInvoice(r)),
      total: countRes.rows[0].c,
      page,
      limit,
      filters: {
        status: statuses.length ? statuses : null,
        from: opts.from || null,
        to: opts.to || null,
      },
    };
  }

  async payNow(userId: string, role: string, invoiceId: string) {
    const user = await getUserContext(this.pool, userId, role);

    const { rows } = await this.pool.query(
      `SELECT i.*, b.id AS branch_id
         FROM invoices i
         JOIN branches b ON b.id = i.branch_id
        WHERE i.id = $1`,
      [invoiceId],
    );
    if (!rows.length) {
      throw new BadRequestException('Invoice not found');
    }
    const invoice = rows[0];
    await assertBranchAccess(this.pool, user, invoice.branch_id);

    if (invoice.status === 'paid') {
      throw new ConflictException('Invoice is already paid');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.internalToken) {
      headers['X-Internal-Token'] = this.internalToken;
    }

    const url = `${this.settlementUrl.replace(/\/$/, '')}/settlement/invoices/${invoiceId}/pay-now`;
    const resp = await fetch(url, { method: 'POST', headers });
    const body = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const msg =
        body?.error?.message ||
        body?.message ||
        `Settlement pay-now failed (${resp.status})`;
      throw new BadRequestException(msg);
    }

    // Settlement wraps as { success, data }
    return body?.data ?? body;
  }

  private serializeInvoice(r: any) {
    return {
      id: r.id,
      branch_id: r.branch_id,
      branch_name: r.branch_name ?? null,
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
      total_amount: Number(r.total_amount).toFixed(2),
      currency: r.currency,
      status: r.status,
      attempt_count: r.attempt_count,
      last_error: r.last_error,
      stripe_payment_intent_id: r.stripe_payment_intent_id,
      last_attempted_at: r.last_attempted_at
        ? new Date(r.last_attempted_at).toISOString()
        : null,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
      paid_at: r.paid_at ? new Date(r.paid_at).toISOString() : null,
      action_required:
        r.status === 'needs_reauth'
          ? 'reauth_card'
          : r.status === 'missed' || r.status === 'failed'
            ? 'manual_pay'
            : null,
      ui_priority: r.status === 'needs_reauth' ? 'high' : 'normal',
    };
  }
}
