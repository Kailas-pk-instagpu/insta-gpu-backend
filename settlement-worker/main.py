"""Settlement worker — confirms payment + subscribes to session.ended."""
import asyncio
import os
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import asyncpg
import redis.asyncio as aioredis

DATABASE_URL = os.environ["DATABASE_URL"]
REDIS_URL = os.environ["REDIS_URL"]

state = {}


def calculate_cost(started_at, ended_at, cost_per_hour):
    """Return (duration_minutes, total_cost) given session timestamps."""
    delta = (ended_at - started_at).total_seconds()
    duration_minutes = round(delta / 60)
    total_cost = round((duration_minutes / 60) * float(cost_per_hour), 2)
    return duration_minutes, total_cost


async def subscribe_session_ended():
    pubsub = state["redis"].pubsub()
    await pubsub.subscribe("session.ended")
    async for msg in pubsub.listen():
        if msg["type"] != "message":
            continue
        try:
            data = json.loads(msg["data"])
            print(f"[settlement-worker] session.ended received: session_id={data.get('session_id')} amount={data.get('total_cost')}")
        except Exception as e:
            print("session.ended parse error:", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    state["pg"] = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
    state["redis"] = aioredis.from_url(REDIS_URL, decode_responses=True)
    task = asyncio.create_task(subscribe_session_ended())
    yield
    task.cancel()
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


@app.get("/health")
async def health(request: Request):
    """Liveness probe."""
    return success_response(request, {"status": "ok", "service": "settlement-worker"})


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
