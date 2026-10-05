import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import Stripe from 'stripe';
import axios from 'axios';
import { PG_POOL } from '../db/db.module';

export type ChargeStatus = 'processing' | 'no_card' | 'error' | 'needs_reauth';

export interface ChargeResult {
  status: ChargeStatus;
  paymentIntentId: string | null;
  error?: string;
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY is required');
    }
    this.stripe = new Stripe(key, { apiVersion: '2023-10-16' });
  }

  /**
   * Create or reuse a Stripe Customer for the cafe owner, then return a
   * SetupIntent client_secret for the frontend to save a card (off_session).
   */
  async createSetupIntent(ownerId: string): Promise<{
    customerId: string;
    setupIntentId: string;
    clientSecret: string;
  }> {
    const user = await this.pool.query(
      `SELECT id, email, name, stripe_customer_id, stripe_payment_method_id
       FROM users WHERE id = $1`,
      [ownerId],
    );
    if (user.rowCount === 0) {
      throw new NotFoundException(`Owner ${ownerId} not found`);
    }

    const row = user.rows[0];
    let customerId: string = row.stripe_customer_id;

    if (!customerId) {
      const customer = await this.stripe.customers.create({
        email: row.email,
        name: row.name || undefined,
        metadata: { ownerId, userId: ownerId },
      });
      customerId = customer.id;
      await this.pool.query(
        `UPDATE users SET stripe_customer_id = $1 WHERE id = $2`,
        [customerId, ownerId],
      );
      this.logger.log(`Created Stripe customer ${customerId} for owner ${ownerId}`);
    }

    const setupIntent = await this.stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: { ownerId },
    });

    if (!setupIntent.client_secret) {
      throw new Error('Stripe SetupIntent missing client_secret');
    }

    return {
      customerId,
      setupIntentId: setupIntent.id,
      clientSecret: setupIntent.client_secret,
    };
  }

  /**
   * Off-session charge using the owner's saved card.
   * Returns immediately — final paid/failed is handled by webhook.
   */
  async charge(params: {
    branchId: string;
    invoiceId: string;
    amount: number;
    currency: string;
    ownerId: string;
    idempotencyKey: string;
  }): Promise<ChargeResult> {
    const { branchId, invoiceId, amount, currency, ownerId, idempotencyKey } = params;

    const user = await this.pool.query(
      `SELECT id, email, stripe_customer_id, stripe_payment_method_id
       FROM users WHERE id = $1`,
      [ownerId],
    );
    if (user.rowCount === 0) {
      return { status: 'error', paymentIntentId: null, error: 'Owner not found' };
    }

    const row = user.rows[0];
    let customerId: string | null = row.stripe_customer_id;
    let paymentMethodId: string | null = row.stripe_payment_method_id;

    if (!customerId) {
      return { status: 'no_card', paymentIntentId: null };
    }

    if (!paymentMethodId) {
      paymentMethodId = await this.resolvePaymentMethod(customerId, ownerId);
    }

    if (!paymentMethodId) {
      return { status: 'no_card', paymentIntentId: null };
    }

    const amountInMinor = Math.round(Number(amount) * 100);
    if (amountInMinor <= 0) {
      return { status: 'error', paymentIntentId: null, error: 'Amount must be positive' };
    }

    try {
      const paymentIntent = await this.stripe.paymentIntents.create(
        {
          amount: amountInMinor,
          currency: currency.toLowerCase(),
          customer: customerId,
          payment_method: paymentMethodId,
          off_session: true,
          confirm: true,
          metadata: {
            branchId,
            invoiceId,
            ownerId,
            idempotencyKey,
          },
        },
        { idempotencyKey },
      );

      // Do not treat synchronous succeeded as final — Settlement waits on webhook.
      return {
        status: 'processing',
        paymentIntentId: paymentIntent.id,
      };
    } catch (err: any) {
      return this.mapChargeError(err);
    }
  }

  /**
   * Return a client_secret so the owner's browser can complete 3DS for a
   * needs_reauth invoice. Prefers an existing requires_* PaymentIntent;
   * otherwise creates a new on-session (confirm: false) PaymentIntent.
   */
  async createReauthIntent(params: {
    invoiceId: string;
    branchId: string;
    ownerId: string;
    amount: number;
    currency: string;
    paymentIntentId?: string;
  }): Promise<{ clientSecret: string; paymentIntentId: string }> {
    const { invoiceId, branchId, ownerId, amount, currency, paymentIntentId } = params;

    if (paymentIntentId) {
      try {
        const existing = await this.stripe.paymentIntents.retrieve(paymentIntentId);
        const actionable = [
          'requires_action',
          'requires_confirmation',
          'requires_payment_method',
        ];
        if (existing.client_secret && actionable.includes(existing.status)) {
          return {
            clientSecret: existing.client_secret,
            paymentIntentId: existing.id,
          };
        }
      } catch (err: any) {
        this.logger.warn(
          `Could not reuse PaymentIntent ${paymentIntentId}: ${err.message}`,
        );
      }
    }

    const user = await this.pool.query(
      `SELECT id, stripe_customer_id, stripe_payment_method_id FROM users WHERE id = $1`,
      [ownerId],
    );
    if (user.rowCount === 0) {
      throw new NotFoundException(`Owner ${ownerId} not found`);
    }

    const row = user.rows[0];
    let customerId: string | null = row.stripe_customer_id;
    let paymentMethodId: string | null = row.stripe_payment_method_id;

    if (!customerId) {
      throw new NotFoundException('Owner has no Stripe customer — run setup-intent first');
    }
    if (!paymentMethodId) {
      paymentMethodId = await this.resolvePaymentMethod(customerId, ownerId);
    }
    if (!paymentMethodId) {
      throw new NotFoundException('Owner has no saved payment method');
    }

    const amountInMinor = Math.round(Number(amount) * 100);
    const paymentIntent = await this.stripe.paymentIntents.create(
      {
        amount: amountInMinor,
        currency: currency.toLowerCase(),
        customer: customerId,
        payment_method: paymentMethodId,
        confirm: false,
        metadata: {
          invoiceId,
          branchId,
          ownerId,
          purpose: 'needs_reauth',
        },
      },
      { idempotencyKey: `${invoiceId}:reauth` },
    );

    if (!paymentIntent.client_secret) {
      throw new Error('Stripe PaymentIntent missing client_secret');
    }

    return {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    };
  }

  /**
   * Verify Stripe signature and handle payment_intent.succeeded / payment_failed.
   * Forwards outcome to Settlement worker — does not mutate invoices itself.
   */
  async handleWebhook(rawBody: Buffer | string, signature: string): Promise<{ received: boolean }> {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err: any) {
      this.logger.warn(`Stripe webhook signature verification failed: ${err.message}`);
      throw err;
    }

    if (
      event.type !== 'payment_intent.succeeded' &&
      event.type !== 'payment_intent.payment_failed'
    ) {
      this.logger.debug(`Ignoring Stripe event type ${event.type}`);
      return { received: true };
    }

    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const outcome = event.type === 'payment_intent.succeeded' ? 'succeeded' : 'failed';
    const invoiceId = await this.resolveInvoiceId(paymentIntent);

    if (!invoiceId) {
      this.logger.error(
        `No invoiceId for PaymentIntent ${paymentIntent.id} — cannot notify Settlement`,
      );
      throw new Error(`Missing invoiceId for PaymentIntent ${paymentIntent.id}`);
    }

    await this.notifySettlement(invoiceId, {
      status: outcome,
      paymentIntentId: paymentIntent.id,
      error:
        outcome === 'failed'
          ? paymentIntent.last_payment_error?.message || 'Payment failed'
          : undefined,
    });

    return { received: true };
  }

  private async resolveInvoiceId(paymentIntent: Stripe.PaymentIntent): Promise<string | null> {
    const fromMeta = paymentIntent.metadata?.invoiceId;
    if (fromMeta) {
      return fromMeta;
    }

    const found = await this.pool.query(
      `SELECT id FROM invoices WHERE stripe_payment_intent_id = $1 LIMIT 1`,
      [paymentIntent.id],
    );
    return found.rows[0]?.id ? String(found.rows[0].id) : null;
  }

  private async notifySettlement(
    invoiceId: string,
    body: { status: 'succeeded' | 'failed'; paymentIntentId: string; error?: string },
  ): Promise<void> {
    const baseUrl = process.env.SETTLEMENT_WORKER_URL;
    if (!baseUrl) {
      throw new Error('SETTLEMENT_WORKER_URL is not configured');
    }

    const url = `${baseUrl.replace(/\/$/, '')}/settlement/invoices/${invoiceId}/result`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = process.env.INTERNAL_API_TOKEN;
    if (token) {
      headers['X-Internal-Token'] = token;
    }

    this.logger.log(
      `Notifying Settlement ${url} status=${body.status} pi=${body.paymentIntentId}`,
    );

    const response = await axios.post(url, body, { headers, timeout: 15000 });
    if (response.status >= 400) {
      throw new Error(`Settlement callback failed with HTTP ${response.status}`);
    }
  }

  /** Prefer DB value; else Stripe default / first attached card; backfill DB. */
  private async resolvePaymentMethod(
    customerId: string,
    ownerId: string,
  ): Promise<string | null> {
    try {
      const customer = await this.stripe.customers.retrieve(customerId);
      if ((customer as Stripe.DeletedCustomer).deleted) {
        return null;
      }

      const activeCustomer = customer as Stripe.Customer;
      const defaultPm = activeCustomer.invoice_settings?.default_payment_method;
      let paymentMethodId =
        typeof defaultPm === 'string' ? defaultPm : defaultPm?.id || null;

      if (!paymentMethodId) {
        const list = await this.stripe.paymentMethods.list({
          customer: customerId,
          type: 'card',
          limit: 1,
        });
        paymentMethodId = list.data[0]?.id || null;
      }

      if (paymentMethodId) {
        await this.pool.query(
          `UPDATE users SET stripe_payment_method_id = $1 WHERE id = $2`,
          [paymentMethodId, ownerId],
        );
      }

      return paymentMethodId;
    } catch (err: any) {
      this.logger.warn(
        `Failed to resolve payment method for customer ${customerId}: ${err.message}`,
      );
      return null;
    }
  }

  private mapChargeError(err: any): ChargeResult {
    const paymentIntentId =
      err?.payment_intent?.id ||
      err?.raw?.payment_intent?.id ||
      null;

    const code = err?.code || err?.raw?.code;
    const declineCode = err?.decline_code || err?.raw?.decline_code;
    const message = err?.message || 'Stripe charge failed';

    // SCA / card requires customer presence — Settlement marks needs_reauth
    if (
      code === 'authentication_required' ||
      declineCode === 'authentication_required'
    ) {
      this.logger.warn(`Stripe authentication_required: ${message}`);
      return {
        status: 'needs_reauth',
        paymentIntentId,
        error: message,
      };
    }

    this.logger.error(`Stripe charge error [${code || 'unknown'}]: ${message}`);
    return {
      status: 'error',
      paymentIntentId,
      error: message,
    };
  }
}
