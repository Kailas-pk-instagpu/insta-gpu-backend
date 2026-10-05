"""Settlement worker — confirms payment, daily invoicing, retries, session.ended subscriber."""
import asyncio
import os
import json
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from fastapi import FastAPI, Request, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Literal
import asyncpg
import httpx
import redis.asyncio as aioredis

DATABASE_URL = os.environ["DATABASE_URL"]
REDIS_URL = os.environ["REDIS_URL"]
INTERNAL_API_TOKEN = os.environ.get("INTERNAL_API_TOKEN")
INTEGRATION_SERVICE_URL = os.environ.get("INTEGRATION_SERVICE_URL", "http://integration-service:3004")
MAX_CHARGE_ATTEMPTS = int(os.environ.get("MAX_CHARGE_ATTEMPTS", "3"))
RETRY_INTERVAL_HOURS = int(os.environ.get("RETRY_INTERVAL_HOURS", "2"))

state = {}


def require_internal_token(request: Request) -> None:
    """Optional shared-secret gate for service-to-service callbacks."""
    if not INTERNAL_API_TOKEN:
        return
    token = request.headers.get("x-internal-token") or ""
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        token = token or auth[7:].strip()
    if token != INTERNAL_API_TOKEN:
        raise HTTPException(401, "Invalid or missing internal token")


def calculate_cost(started_at, ended_at, cost_per_hour):
    """Return (duration_minutes, total_cost) given session timestamps."""
    delta = (ended_at - started_at).total_seconds()
    duration_minutes = round(delta / 60)
    total_cost = round((duration_minutes / 60) * float(cost_per_hour), 2)
    return duration_minutes, total_cost


def invoice_idempotency_key(branch_id, invoice_date: date) -> str:
    """Stable key for a branch+date invoice charge (same key on every retry)."""
    if isinstance(invoice_date, datetime):
        invoice_date = invoice_date.date()
    return f"{branch_id}:{invoice_date.isoformat()}"


def serialize_invoice(row) -> dict:
    return {
        "id": str(row["id"]),
        "branch_id": str(row["branch_id"]),
        "date": row["date"].isoformat() if hasattr(row["date"], "isoformat") else str(row["date"]),
        "total_amount": f"{float(row['total_amount']):.2f}",
        "currency": row["currency"],
        "status": row["status"],
        "attempt_count": row["attempt_count"],
        "last_error": row["last_error"],
        "stripe_payment_intent_id": row["stripe_payment_intent_id"],
        "last_attempted_at": row["last_attempted_at"].isoformat() if row.get("last_attempted_at") else None,
        "paid_at": row["paid_at"].isoformat() if row.get("paid_at") else None,
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
    }


async def check_daily_spend_limit(branch_id: str) -> dict | None:
    """
    After a session ends: if today's completed-session spend crosses
    branches.daily_spend_limit, notify once per branch per day (deduped).
    Distinct from invoice.missed / invoice.needs_reauth alerts.
    """
    today = datetime.now(timezone.utc).date()
    async with state["pg"].acquire() as conn:
        branch = await conn.fetchrow(
            """
            SELECT b.id, b.name, b.daily_spend_limit, b.currency,
                   COALESCE(b.owner_id, b.cafe_owner_id) AS owner_id,
                   u.email AS owner_email
              FROM branches b
              LEFT JOIN users u ON u.id = COALESCE(b.owner_id, b.cafe_owner_id)
             WHERE b.id = $1::uuid
            """,
            branch_id,
        )
        if not branch or branch["daily_spend_limit"] is None:
            return None

        limit = Decimal(str(branch["daily_spend_limit"]))
        if limit <= 0:
            return None

        running = await conn.fetchval(
            """
            SELECT COALESCE(SUM(total_cost), 0)
              FROM sessions
             WHERE branch_id = $1::uuid
               AND status = 'completed'
               AND (ended_at AT TIME ZONE 'UTC')::date = $2
            """,
            branch_id,
            today,
        )
        running_total = Decimal(str(running or 0))
        if running_total < limit:
            return {
                "crossed": False,
                "running_total": float(running_total),
                "daily_spend_limit": float(limit),
            }

        # Dedup insert — UNIQUE(branch_id, alert_date) makes this once-per-day
        alert = await conn.fetchrow(
            """
            INSERT INTO spend_limit_alerts
              (branch_id, alert_date, daily_spend_limit, running_total, currency)
            VALUES ($1::uuid, $2, $3, $4, $5)
            ON CONFLICT (branch_id, alert_date) DO NOTHING
            RETURNING *
            """,
            branch_id,
            today,
            limit,
            running_total,
            branch["currency"] or "USD",
        )
        if not alert:
            return {
                "crossed": True,
                "notified": False,
                "deduped": True,
                "running_total": float(running_total),
                "daily_spend_limit": float(limit),
            }

        await notify_owner(
            owner_id=str(branch["owner_id"]) if branch["owner_id"] else None,
            owner_email=branch["owner_email"],
            event_type="spend_limit.crossed",
            title="Daily spend limit reached",
            body=(
                f"{branch['name']} has reached its daily spend limit "
                f"({branch['currency']} {float(limit):.2f}). "
                f"Today's running total is {branch['currency']} {float(running_total):.2f}."
            ),
            data={
                "branch_id": str(branch_id),
                "branch_name": branch["name"],
                "alert_date": today.isoformat(),
                "daily_spend_limit": f"{float(limit):.2f}",
                "running_total": f"{float(running_total):.2f}",
                "currency": branch["currency"],
                "alert_id": str(alert["id"]),
                # Distinct from invoice.missed / invoice.needs_reauth
                "notification_category": "spend_limit",
                "channel": "spend_limit_alert",
                "action_required": "review_spend",
            },
        )
        return {
            "crossed": True,
            "notified": True,
            "deduped": False,
            "running_total": float(running_total),
            "daily_spend_limit": float(limit),
            "alert_id": str(alert["id"]),
        }


async def subscribe_session_ended():
    pubsub = state["redis"].pubsub()
    await pubsub.subscribe("session.ended")
    async for msg in pubsub.listen():
        if msg["type"] != "message":
            continue
        try:
            data = json.loads(msg["data"])
            print(
                f"[settlement-worker] session.ended received: "
                f"session_id={data.get('session_id')} amount={data.get('total_cost')}"
            )
            branch_id = data.get("branch_id")
            if branch_id:
                result = await check_daily_spend_limit(str(branch_id))
                if result and result.get("notified"):
                    print(
                        f"[settlement-worker] spend_limit.crossed branch={branch_id} "
                        f"total={result.get('running_total')} limit={result.get('daily_spend_limit')}"
                    )
        except Exception as e:
            print("session.ended handler error:", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    state["pg"] = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
    state["redis"] = aioredis.from_url(REDIS_URL, decode_responses=True)
    state["http"] = httpx.AsyncClient(timeout=30.0)
    task = asyncio.create_task(subscribe_session_ended())
    yield
    task.cancel()
    await state["http"].aclose()
    await state["pg"].close()
    await state["redis"].aclose()


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class SuccessResponse(BaseModel):
    success: bool = True
    data: dict | list | None
    message: str | None
    timestamp: str
    path: str


class ErrorResponse(BaseModel):
    success: bool = False
    error: dict
    timestamp: str
    path: str


@app.exception_handler(Exception)
async def all_errors(request: Request, exc: Exception):
    status = 500
    code = "INTERNAL_ERROR"
    msg = str(exc)
    if isinstance(exc, HTTPException):
        status = exc.status_code
        msg = exc.detail
        code = {
            400: "VALIDATION_ERROR",
            401: "UNAUTHORIZED",
            403: "FORBIDDEN",
            404: "NOT_FOUND",
            409: "CONFLICT",
            429: "RATE_LIMITED",
            503: "SERVICE_UNAVAILABLE",
        }.get(status, "INTERNAL_ERROR")

    return JSONResponse(
        status_code=status,
        content=ErrorResponse(
            error={"code": code, "message": msg, "details": None},
            timestamp=datetime.now(timezone.utc).isoformat(),
            path=request.url.path,
        ).model_dump(),
    )


def success_response(request: Request, data: any, message: str = None):
    return SuccessResponse(
        data=data,
        message=message,
        timestamp=datetime.now(timezone.utc).isoformat(),
        path=request.url.path,
    )


class ConfirmBody(BaseModel):
    session_id: str


class InvoiceResultBody(BaseModel):
    status: Literal["succeeded", "failed"]
    paymentIntentId: str | None = None
    error: str | None = None


@app.get("/health")
async def health(request: Request):
    """Liveness probe."""
    return success_response(request, {"status": "ok", "service": "settlement-worker"})


async def get_branch_owner(conn: asyncpg.Connection, branch_id) -> dict | None:
    return await conn.fetchrow(
        """
        SELECT b.id AS branch_id, b.name AS branch_name,
               COALESCE(b.owner_id, b.cafe_owner_id) AS owner_id,
               u.email AS owner_email, u.name AS owner_name
          FROM branches b
          LEFT JOIN users u ON u.id = COALESCE(b.owner_id, b.cafe_owner_id)
         WHERE b.id = $1
        """,
        branch_id,
    )


async def notify_owner(
    *,
    owner_id: str | None,
    owner_email: str | None,
    event_type: str,
    title: str,
    body: str,
    data: dict,
) -> None:
    """Push via Redis (realtime) + integration notification gateway."""
    payload = {
        "type": event_type,
        "user_id": owner_id,
        "title": title,
        "body": body,
        "data": data,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    try:
        await state["redis"].publish("push.notify", json.dumps(payload))
    except Exception as e:
        print(f"[settlement-worker] redis push.notify failed: {e}")

    if not owner_email:
        return
    try:
        headers = {"Content-Type": "application/json"}
        if INTERNAL_API_TOKEN:
            headers["X-Internal-Token"] = INTERNAL_API_TOKEN
        await state["http"].post(
            f"{INTEGRATION_SERVICE_URL.rstrip('/')}/integration/notifications/send",
            json={"recipient": owner_email, "message": f"{title}: {body}", "channel": "email"},
            headers=headers,
        )
    except Exception as e:
        print(f"[settlement-worker] notification send failed: {e}")


async def mark_invoice_missed(conn: asyncpg.Connection, invoice_id: str, reason: str) -> dict | None:
    updated = await conn.fetchrow(
        """
        UPDATE invoices
           SET status = 'missed',
               last_error = $2
         WHERE id = $1 AND status IN ('failed', 'charging', 'pending')
     RETURNING *
        """,
        invoice_id,
        reason,
    )
    if not updated:
        return None

    owner = await get_branch_owner(conn, updated["branch_id"])
    await notify_owner(
        owner_id=str(owner["owner_id"]) if owner and owner["owner_id"] else None,
        owner_email=owner["owner_email"] if owner else None,
        event_type="invoice.missed",
        title="Payment missed",
        body=(
            f"Invoice for {owner['branch_name'] if owner else 'your branch'} "
            f"on {updated['date']} ({updated['currency']} {float(updated['total_amount']):.2f}) "
            f"could not be charged after {MAX_CHARGE_ATTEMPTS} attempts. Please pay manually."
        ),
        data={
            "invoice_id": str(updated["id"]),
            "branch_id": str(updated["branch_id"]),
            "amount": f"{float(updated['total_amount']):.2f}",
            "currency": updated["currency"],
            "date": updated["date"].isoformat(),
            "status": "missed",
            "action_required": "manual_pay",
            "notification_category": "invoice",
            "channel": "invoice_missed",
        },
    )
    return updated


async def mark_invoice_needs_reauth(
    conn: asyncpg.Connection,
    invoice_id: str,
    error: str | None,
    payment_intent_id: str | None,
) -> dict | None:
    """Owner must re-confirm card (3DS) — never put on the silent retry queue."""
    updated = await conn.fetchrow(
        """
        UPDATE invoices
           SET status = 'needs_reauth',
               last_error = $2,
               last_attempted_at = now(),
               stripe_payment_intent_id = COALESCE($3, stripe_payment_intent_id)
         WHERE id = $1 AND status <> 'paid'
     RETURNING *
        """,
        invoice_id,
        error or "Card authentication required",
        payment_intent_id,
    )
    if not updated:
        return None

    owner = await get_branch_owner(conn, updated["branch_id"])
    await notify_owner(
        owner_id=str(owner["owner_id"]) if owner and owner["owner_id"] else None,
        owner_email=owner["owner_email"] if owner else None,
        event_type="invoice.needs_reauth",
        title="Card re-authentication required",
        body=(
            f"Your card needs to be re-confirmed for {owner['branch_name'] if owner else 'your branch'} "
            f"invoice on {updated['date']} ({updated['currency']} {float(updated['total_amount']):.2f}). "
            f"Open the app to complete 3D Secure — this will not retry automatically."
        ),
        data={
            "invoice_id": str(updated["id"]),
            "branch_id": str(updated["branch_id"]),
            "amount": f"{float(updated['total_amount']):.2f}",
            "currency": updated["currency"],
            "date": updated["date"].isoformat(),
            "status": "needs_reauth",
            "action_required": "reauth_card",
            "priority": "high",
            "notification_category": "invoice",
            "channel": "invoice_needs_reauth",
        },
    )
    return updated


async def call_stripe_charge(
    *,
    invoice_id: str,
    branch_id: str,
    owner_id: str,
    amount: float,
    currency: str,
    idempotency_key: str,
) -> dict:
    headers = {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotency_key,
    }
    if INTERNAL_API_TOKEN:
        headers["X-Internal-Token"] = INTERNAL_API_TOKEN

    url = f"{INTEGRATION_SERVICE_URL.rstrip('/')}/internal/stripe/charge"
    response = await state["http"].post(
        url,
        headers=headers,
        json={
            "branchId": str(branch_id),
            "invoiceId": str(invoice_id),
            "ownerId": str(owner_id),
            "amount": float(amount),
            "currency": currency,
        },
    )
    response.raise_for_status()
    payload = response.json()
    # Nest wraps in { success, data }
    return payload.get("data") or payload


async def charge_invoice(conn: asyncpg.Connection, invoice, *, allow_missed: bool = False) -> dict:
    """Call integration Stripe charge for one invoice; update status from sync response."""
    if allow_missed and invoice["status"] == "missed":
        await conn.execute(
            """
            UPDATE invoices
               SET status = 'failed',
                   last_error = COALESCE(last_error, 'Manual pay-now after missed')
             WHERE id = $1 AND status = 'missed'
            """,
            invoice["id"],
        )
        invoice = await conn.fetchrow("SELECT * FROM invoices WHERE id=$1", invoice["id"])

    owner = await get_branch_owner(conn, invoice["branch_id"])
    if not owner or not owner["owner_id"]:
        await conn.execute(
            """
            UPDATE invoices
               SET status = 'failed',
                   last_error = $2,
                   attempt_count = attempt_count + 1,
                   last_attempted_at = now()
             WHERE id = $1
            """,
            invoice["id"],
            "Branch has no owner to charge",
        )
        refreshed = await conn.fetchrow("SELECT * FROM invoices WHERE id=$1", invoice["id"])
        if refreshed and refreshed["attempt_count"] >= MAX_CHARGE_ATTEMPTS:
            missed = await mark_invoice_missed(conn, str(invoice["id"]), "Exhausted retries: no owner")
            return {
                "invoice_id": str(invoice["id"]),
                "outcome": "missed",
                "invoice": serialize_invoice(missed or refreshed),
            }
        return {"invoice_id": str(invoice["id"]), "outcome": "failed", "error": "no owner"}

    idem_key = invoice_idempotency_key(invoice["branch_id"], invoice["date"])

    await conn.execute(
        """
        UPDATE invoices
           SET status = 'charging',
               last_attempted_at = now()
         WHERE id = $1 AND status IN ('pending', 'failed')
        """,
        invoice["id"],
    )

    try:
        result = await call_stripe_charge(
            invoice_id=str(invoice["id"]),
            branch_id=str(invoice["branch_id"]),
            owner_id=str(owner["owner_id"]),
            amount=float(invoice["total_amount"]),
            currency=invoice["currency"],
            idempotency_key=idem_key,
        )
    except Exception as e:
        await conn.execute(
            """
            UPDATE invoices
               SET status = 'failed',
                   last_error = $2,
                   attempt_count = attempt_count + 1,
                   last_attempted_at = now()
             WHERE id = $1 AND status <> 'paid'
            """,
            invoice["id"],
            f"Charge request failed: {e}",
        )
        refreshed = await conn.fetchrow("SELECT * FROM invoices WHERE id=$1", invoice["id"])
        if refreshed and refreshed["attempt_count"] >= MAX_CHARGE_ATTEMPTS:
            missed = await mark_invoice_missed(
                conn, str(invoice["id"]), f"Exhausted retries after charge error: {e}"
            )
            return {
                "invoice_id": str(invoice["id"]),
                "outcome": "missed",
                "invoice": serialize_invoice(missed or refreshed),
            }
        return {"invoice_id": str(invoice["id"]), "outcome": "failed", "error": str(e)}

    status = (result or {}).get("status")
    pi_id = (result or {}).get("paymentIntentId")

    if status == "processing":
        updated = await conn.fetchrow(
            """
            UPDATE invoices
               SET status = 'charging',
                   stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
                   last_attempted_at = now(),
                   last_error = NULL
             WHERE id = $1
         RETURNING *
            """,
            invoice["id"],
            pi_id,
        )
        return {
            "invoice_id": str(invoice["id"]),
            "outcome": "processing",
            "payment_intent_id": pi_id,
            "idempotency_key": idem_key,
            "invoice": serialize_invoice(updated),
        }

    if status in ("needs_reauth", "no_card"):
        err = (result or {}).get("error") or (
            "No card on file" if status == "no_card" else "Authentication required"
        )
        updated = await mark_invoice_needs_reauth(conn, str(invoice["id"]), err, pi_id)
        return {
            "invoice_id": str(invoice["id"]),
            "outcome": "needs_reauth",
            "payment_intent_id": pi_id,
            "invoice": serialize_invoice(updated) if updated else None,
        }

    # status == error (or unknown)
    err = (result or {}).get("error") or "Stripe charge error"
    updated = await conn.fetchrow(
        """
        UPDATE invoices
           SET status = 'failed',
               last_error = $2,
               attempt_count = attempt_count + 1,
               last_attempted_at = now(),
               stripe_payment_intent_id = COALESCE($3, stripe_payment_intent_id)
         WHERE id = $1 AND status <> 'paid'
     RETURNING *
        """,
        invoice["id"],
        err,
        pi_id,
    )
    if updated and updated["attempt_count"] >= MAX_CHARGE_ATTEMPTS:
        missed = await mark_invoice_missed(conn, str(invoice["id"]), f"Exhausted retries: {err}")
        return {
            "invoice_id": str(invoice["id"]),
            "outcome": "missed",
            "invoice": serialize_invoice(missed or updated),
        }
    return {
        "invoice_id": str(invoice["id"]),
        "outcome": "failed",
        "error": err,
        "invoice": serialize_invoice(updated) if updated else None,
    }


async def apply_invoice_result(
    conn: asyncpg.Connection,
    invoice_id: str,
    body: InvoiceResultBody,
) -> dict:
    """
    Apply Stripe charge outcome: update invoice status and, on success,
    insert one settlements row per still-unsettled session for that invoice day.
    Idempotent if invoice is already paid.
    """
    invoice = await conn.fetchrow("SELECT * FROM invoices WHERE id=$1", invoice_id)
    if not invoice:
        raise HTTPException(404, "Invoice not found")

    if invoice["status"] == "paid":
        return {
            "invoice_id": str(invoice["id"]),
            "status": "paid",
            "already_processed": True,
            "settlements_created": 0,
        }

    # needs_reauth is owner-driven — webhook failed should not clobber it into silent retry
    if invoice["status"] == "needs_reauth" and body.status == "failed":
        return {
            "invoice_id": str(invoice["id"]),
            "status": "needs_reauth",
            "already_processed": True,
            "settlements_created": 0,
        }

    pi_id = body.paymentIntentId

    if body.status == "succeeded":
        async with conn.transaction():
            updated = await conn.fetchrow(
                """
                UPDATE invoices
                   SET status = 'paid',
                       paid_at = now(),
                       stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
                       last_error = NULL
                 WHERE id = $1 AND status <> 'paid'
             RETURNING *
                """,
                invoice_id,
                pi_id,
            )
            if not updated:
                return {
                    "invoice_id": invoice_id,
                    "status": "paid",
                    "already_processed": True,
                    "settlements_created": 0,
                }

            settlements = await conn.fetch(
                """
                INSERT INTO settlements (session_id, branch_id, amount, payment_method, invoice_id)
                SELECT s.id, s.branch_id, s.total_cost, 'card', $1
                  FROM sessions s
                 WHERE s.branch_id = $2
                   AND s.status = 'completed'
                   AND (s.ended_at AT TIME ZONE 'UTC')::date = $3
                   AND NOT EXISTS (
                         SELECT 1 FROM settlements st WHERE st.session_id = s.id
                       )
                ON CONFLICT (session_id) WHERE session_id IS NOT NULL DO NOTHING
                RETURNING id, session_id, amount
                """,
                updated["id"],
                updated["branch_id"],
                updated["date"],
            )

        return {
            "invoice_id": str(updated["id"]),
            "status": "paid",
            "already_processed": False,
            "settlements_created": len(settlements),
            "payment_intent_id": updated["stripe_payment_intent_id"],
        }

    # failed via webhook
    updated = await conn.fetchrow(
        """
        UPDATE invoices
           SET status = 'failed',
               last_error = $2,
               attempt_count = attempt_count + 1,
               last_attempted_at = now(),
               stripe_payment_intent_id = COALESCE($3, stripe_payment_intent_id)
         WHERE id = $1 AND status NOT IN ('paid', 'needs_reauth', 'missed')
     RETURNING *
        """,
        invoice_id,
        body.error or "Payment failed",
        pi_id,
    )
    if not updated:
        current = await conn.fetchrow("SELECT * FROM invoices WHERE id=$1", invoice_id)
        return {
            "invoice_id": invoice_id,
            "status": current["status"] if current else "unknown",
            "already_processed": True,
            "settlements_created": 0,
        }

    if updated["attempt_count"] >= MAX_CHARGE_ATTEMPTS:
        missed = await mark_invoice_missed(
            conn,
            invoice_id,
            body.error or f"Exhausted {MAX_CHARGE_ATTEMPTS} charge attempts",
        )
        return {
            "invoice_id": str(updated["id"]),
            "status": "missed",
            "already_processed": False,
            "settlements_created": 0,
            "last_error": (missed or updated)["last_error"],
            "attempt_count": updated["attempt_count"],
            "payment_intent_id": updated["stripe_payment_intent_id"],
        }

    return {
        "invoice_id": str(updated["id"]),
        "status": "failed",
        "already_processed": False,
        "settlements_created": 0,
        "last_error": updated["last_error"],
        "attempt_count": updated["attempt_count"],
        "payment_intent_id": updated["stripe_payment_intent_id"],
    }


@app.post("/settlement/invoices/{invoice_id}/result")
async def invoice_result(request: Request, invoice_id: str, body: InvoiceResultBody):
    """
    Stripe outcome callback from integration-service webhook.
    Settlement owns invoice status updates and card settlement row inserts.
    """
    require_internal_token(request)
    async with state["pg"].acquire() as conn:
        result = await apply_invoice_result(conn, invoice_id, body)
    return success_response(
        request,
        result,
        message=f"Invoice {invoice_id} marked {result['status']}",
    )


async def retry_failed_invoices(conn: asyncpg.Connection) -> dict:
    """
    Re-attempt failed invoices (not needs_reauth) up to MAX_CHARGE_ATTEMPTS,
    at least RETRY_INTERVAL_HOURS apart, using the same Idempotency-Key.
    Exhausted invoices → missed + owner push notification.
    """
    interval = timedelta(hours=RETRY_INTERVAL_HOURS)
    cutoff = datetime.now(timezone.utc) - interval

    # Promote exhausted failures to missed (safety net)
    exhausted = await conn.fetch(
        """
        SELECT id FROM invoices
         WHERE status = 'failed' AND attempt_count >= $1
        """,
        MAX_CHARGE_ATTEMPTS,
    )
    marked_missed = []
    for row in exhausted:
        missed = await mark_invoice_missed(
            conn,
            str(row["id"]),
            f"Exhausted {MAX_CHARGE_ATTEMPTS} charge attempts",
        )
        if missed:
            marked_missed.append(serialize_invoice(missed))

    # Eligible retries — explicitly exclude needs_reauth
    candidates = await conn.fetch(
        """
        SELECT i.*
          FROM invoices i
         WHERE i.status = 'failed'
           AND i.attempt_count < $1
           AND (i.last_attempted_at IS NULL OR i.last_attempted_at <= $2)
         ORDER BY i.last_attempted_at NULLS FIRST, i.created_at
        """,
        MAX_CHARGE_ATTEMPTS,
        cutoff,
    )

    retried = []
    skipped_needs_reauth_count = await conn.fetchval(
        "SELECT COUNT(*)::int FROM invoices WHERE status = 'needs_reauth'"
    )

    for invoice in candidates:
        outcome = await charge_invoice(conn, invoice)
        retried.append(outcome)

    return {
        "max_attempts": MAX_CHARGE_ATTEMPTS,
        "retry_interval_hours": RETRY_INTERVAL_HOURS,
        "retried_count": len(retried),
        "retried": retried,
        "marked_missed_count": len(marked_missed),
        "marked_missed": marked_missed,
        "needs_reauth_open_count": skipped_needs_reauth_count,
        "note": (
            "needs_reauth invoices are never silently retried — "
            "owner must re-confirm the card via the frontend (3DS)."
        ),
    }


@app.post("/settlement/retry-failed")
async def retry_failed(request: Request):
    """
    External-scheduler retry job: failed invoices only, up to N attempts / 2h apart.
    needs_reauth is excluded — owner UI must handle those.
    """
    async with state["pg"].acquire() as conn:
        result = await retry_failed_invoices(conn)
    return success_response(request, result, message="Failed-invoice retry run complete")


@app.post("/settlement/invoices/{invoice_id}/pay-now")
async def pay_now(request: Request, invoice_id: str):
    """
    Manual owner pay-now.
    - needs_reauth → return Stripe client_secret for browser 3DS (no silent charge)
    - failed / missed / pending → same /internal/stripe/charge path as cron retries
    """
    require_internal_token(request)
    async with state["pg"].acquire() as conn:
        invoice = await conn.fetchrow("SELECT * FROM invoices WHERE id=$1", invoice_id)
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        if invoice["status"] == "paid":
            raise HTTPException(409, "Invoice is already paid")
        if invoice["status"] == "charging":
            raise HTTPException(409, "Invoice charge already in progress")

        if invoice["status"] == "needs_reauth":
            owner = await get_branch_owner(conn, invoice["branch_id"])
            if not owner or not owner["owner_id"]:
                raise HTTPException(400, "Branch has no owner for reauth")
            headers = {"Content-Type": "application/json"}
            if INTERNAL_API_TOKEN:
                headers["X-Internal-Token"] = INTERNAL_API_TOKEN
            url = f"{INTEGRATION_SERVICE_URL.rstrip('/')}/internal/stripe/reauth-intent"
            try:
                resp = await state["http"].post(
                    url,
                    headers=headers,
                    json={
                        "invoiceId": str(invoice["id"]),
                        "branchId": str(invoice["branch_id"]),
                        "ownerId": str(owner["owner_id"]),
                        "amount": float(invoice["total_amount"]),
                        "currency": invoice["currency"],
                        "paymentIntentId": invoice["stripe_payment_intent_id"],
                    },
                )
                resp.raise_for_status()
                payload = resp.json()
                data = payload.get("data") or payload
            except Exception as e:
                raise HTTPException(502, f"Failed to create reauth intent: {e}") from e

            if data.get("paymentIntentId"):
                await conn.execute(
                    """
                    UPDATE invoices
                       SET stripe_payment_intent_id = $2,
                           last_attempted_at = now()
                     WHERE id = $1
                    """,
                    invoice["id"],
                    data["paymentIntentId"],
                )

            return success_response(
                request,
                {
                    "mode": "reauth",
                    "invoice_id": str(invoice["id"]),
                    "status": "needs_reauth",
                    "clientSecret": data.get("clientSecret"),
                    "paymentIntentId": data.get("paymentIntentId"),
                    "invoice": serialize_invoice(invoice),
                },
                message="Complete 3D Secure in the browser using clientSecret",
            )

        if invoice["status"] not in ("failed", "missed", "pending"):
            raise HTTPException(
                409,
                f"Invoice status '{invoice['status']}' cannot be paid via pay-now",
            )

        outcome = await charge_invoice(
            conn, invoice, allow_missed=(invoice["status"] == "missed")
        )
        return success_response(
            request,
            {
                "mode": "charge",
                **outcome,
            },
            message=f"Pay-now charge outcome: {outcome.get('outcome')}",
        )


@app.get("/settlement/invoices/actionable")
async def list_actionable_invoices(
    request: Request,
    owner_id: str = Query(..., description="Cafe owner user id"),
):
    """
    Owner-facing: missed (manual pay) + needs_reauth (3DS / re-confirm card).
    needs_reauth is listed separately and prominently for UI treatment.
    """
    async with state["pg"].acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT i.*, b.name AS branch_name
              FROM invoices i
              JOIN branches b ON b.id = i.branch_id
             WHERE COALESCE(b.owner_id, b.cafe_owner_id) = $1::uuid
               AND i.status IN ('needs_reauth', 'missed')
             ORDER BY
               CASE i.status WHEN 'needs_reauth' THEN 0 ELSE 1 END,
               i.date DESC
            """,
            owner_id,
        )

    needs_reauth = []
    missed = []
    for r in rows:
        item = serialize_invoice(r)
        item["branch_name"] = r["branch_name"]
        item["action_required"] = (
            "reauth_card" if r["status"] == "needs_reauth" else "manual_pay"
        )
        item["ui_priority"] = "high" if r["status"] == "needs_reauth" else "normal"
        if r["status"] == "needs_reauth":
            needs_reauth.append(item)
        else:
            missed.append(item)

    return success_response(
        request,
        {
            "needs_reauth": needs_reauth,
            "missed": missed,
            "needs_reauth_count": len(needs_reauth),
            "missed_count": len(missed),
        },
        message="Actionable invoices fetched",
    )


async def create_daily_invoices(conn: asyncpg.Connection, billing_date: date) -> dict:
    """
    For each active branch, sum billable completed sessions for billing_date
    (exclude sessions that already have a settlements row) and insert one
    invoices row. ON CONFLICT (branch_id, date) DO NOTHING — re-runs are no-ops
    for branches already invoiced. Skips zero-amount branches.
    """
    rows = await conn.fetch(
        """
        SELECT
          b.id AS branch_id,
          b.currency,
          COALESCE(SUM(s.total_cost), 0) AS total_amount
        FROM branches b
        LEFT JOIN sessions s
          ON s.branch_id = b.id
         AND s.status = 'completed'
         AND (s.ended_at AT TIME ZONE 'UTC')::date = $1
         AND NOT EXISTS (
               SELECT 1 FROM settlements st WHERE st.session_id = s.id
             )
        WHERE b.status = 'active'
        GROUP BY b.id, b.currency
        """,
        billing_date,
    )

    created: list[dict] = []
    skipped_zero: list[str] = []
    skipped_existing: list[str] = []

    for row in rows:
        total_amount = row["total_amount"]
        if total_amount is None or Decimal(str(total_amount)) <= 0:
            skipped_zero.append(str(row["branch_id"]))
            continue

        invoice = await conn.fetchrow(
            """
            INSERT INTO invoices (branch_id, date, total_amount, currency, status)
            VALUES ($1, $2, $3, $4, 'pending')
            ON CONFLICT (branch_id, date) DO NOTHING
            RETURNING id, branch_id, date, total_amount, currency, status
            """,
            row["branch_id"],
            billing_date,
            total_amount,
            row["currency"],
        )

        if invoice:
            created.append(
                {
                    "id": str(invoice["id"]),
                    "branch_id": str(invoice["branch_id"]),
                    "date": invoice["date"].isoformat(),
                    "total_amount": f"{float(invoice['total_amount']):.2f}",
                    "currency": invoice["currency"],
                    "status": invoice["status"],
                }
            )
        else:
            skipped_existing.append(str(row["branch_id"]))

    return {
        "billing_date": billing_date.isoformat(),
        "created": created,
        "created_count": len(created),
        "skipped_zero_count": len(skipped_zero),
        "skipped_existing_count": len(skipped_existing),
        "skipped_zero": skipped_zero,
        "skipped_existing": skipped_existing,
    }


@app.post("/settlement/run-daily")
async def run_daily(request: Request):
    """
    Midnight daily billing job (triggered by external scheduler).
    Creates one pending invoice per active branch for the previous UTC day.
    Safe to re-run: existing (branch_id, date) invoices are left untouched.
    """
    billing_date = datetime.now(timezone.utc).date() - timedelta(days=1)
    async with state["pg"].acquire() as conn:
        result = await create_daily_invoices(conn, billing_date)
    return success_response(
        request,
        result,
        message=f"Daily settlement run complete for {result['billing_date']}",
    )


@app.post("/settlements/confirm")
async def confirm(request: Request, body: ConfirmBody):
    """Insert a settlement row for a completed session and publish settlement.done."""
    async with state["pg"].acquire() as conn:
        session = await conn.fetchrow("SELECT * FROM sessions WHERE id=$1", body.session_id)
        if not session:
            raise HTTPException(404, "Session not found")
        if session["status"] != "completed":
            raise HTTPException(409, "Session is not completed")
        existing = await conn.fetchrow("SELECT id FROM settlements WHERE session_id=$1", body.session_id)
        if existing:
            raise HTTPException(409, "Settlement already exists for this session")
        row = await conn.fetchrow(
            """INSERT INTO settlements (session_id, branch_id, amount, payment_method)
               VALUES ($1,$2,$3,'cash') RETURNING *""",
            session["id"], session["branch_id"], session["total_cost"],
        )
    payload = {
        "settlement_id": str(row["id"]),
        "session_id": str(row["session_id"]),
        "branch_id": str(row["branch_id"]),
        "amount": f"{float(row['amount']):.2f}",
        "settled_at": row["settled_at"].isoformat(),
    }
    await state["redis"].publish("settlement.done", json.dumps(payload))
    data = {**payload, "payment_method": row["payment_method"]}
    return success_response(request, data, message="Settlement confirmed successfully")


@app.get("/settlements/{branch_id}")
async def list_settlements(request: Request, branch_id: str, page: int = 1, limit: int = 10):
    """Paginated settlement history for a branch, newest first."""
    page = max(1, page)
    limit = min(100, max(1, limit))
    offset = (page - 1) * limit
    async with state["pg"].acquire() as conn:
        total = await conn.fetchval(
            "SELECT COUNT(*) FROM settlements WHERE branch_id=$1", branch_id
        )
        rows = await conn.fetch(
            """SELECT id, session_id, amount, payment_method, settled_at
               FROM settlements WHERE branch_id=$1
               ORDER BY settled_at DESC LIMIT $2 OFFSET $3""",
            branch_id, limit, offset,
        )
    data = {
        "items": [
            {
                "id": str(r["id"]),
                "session_id": str(r["session_id"]),
                "amount": f"{float(r['amount']):.2f}",
                "payment_method": r["payment_method"],
                "settled_at": r["settled_at"].isoformat(),
            }
            for r in rows
        ],
        "total": total,
        "page": page,
        "limit": limit,
    }
    return success_response(request, data)
