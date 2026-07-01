"""GPU metrics worker — seat/GPU telemetry and background polling."""
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
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL_SECONDS", "60"))

state = {}


async def poll_loop():
    while True:
        try:
            async with state["pg"].acquire() as conn:
                rows = await conn.fetch(
                    "SELECT branch_id, status, COUNT(*)::int AS c FROM seats GROUP BY branch_id, status"
                )
            per_branch: dict = {}
            for r in rows:
                b = str(r["branch_id"])
                per_branch.setdefault(b, {"available": 0, "occupied": 0, "maintenance": 0})
                per_branch[b][r["status"]] = r["c"]
            for branch_id, counts in per_branch.items():
                await state["redis"].set(
                    f"metrics:branch:{branch_id}", json.dumps(counts), ex=90
                )
        except Exception as e:
            print("poll error:", e)
        await asyncio.sleep(POLL_INTERVAL)


@asynccontextmanager
async def lifespan(app: FastAPI):
    state["pg"] = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
    state["redis"] = aioredis.from_url(REDIS_URL, decode_responses=True)
    task = asyncio.create_task(poll_loop())
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


class StatusUpdate(BaseModel):
    status: str


@app.get("/health")
async def health(request: Request):
    """Liveness probe."""
    return success_response(
        request, {"status": "ok", "service": "gpu-metrics-worker"}
    )


@app.get("/metrics/seats/{branch_id}")
async def seat_metrics(request: Request, branch_id: str):
    """Aggregate seat status counts and per-seat list for a branch."""
    async with state["pg"].acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, seat_number, gpu_model, status FROM seats WHERE branch_id=$1 ORDER BY seat_number",
            branch_id,
        )
    counts = {"available": 0, "occupied": 0, "maintenance": 0}
    for r in rows:
        counts[r["status"]] += 1
    total = len(rows)
    utilisation = round((counts["occupied"] / total) * 100, 2) if total else 0.0
    data = {
        "total": total,
        **counts,
        "utilisation_percent": utilisation,
        "seats": [dict(r) for r in rows],
    }
    return success_response(request, data)


@app.get("/metrics/gpu-nodes")
async def gpu_nodes(request: Request):
    """Mock GPU node health snapshot for POC."""
    data = [
        {"node_id": "node-1", "gpu_model": "RTX 4070", "status": "healthy", "utilisation_percent": 62, "temperature_c": 58, "vram_used_gb": 7, "vram_total_gb": 12},
        {"node_id": "node-2", "gpu_model": "RTX 4080", "status": "warning", "utilisation_percent": 88, "temperature_c": 76, "vram_used_gb": 14, "vram_total_gb": 16},
        {"node_id": "node-3", "gpu_model": "RTX 4080", "status": "offline", "utilisation_percent": 0, "temperature_c": 0, "vram_used_gb": 0, "vram_total_gb": 16},
    ]
    return success_response(request, data)


@app.post("/metrics/seat/{seat_id}/status")
async def update_seat_status(request: Request, seat_id: str, body: StatusUpdate):
    """Force-update a seat status and publish seat.status_changed."""
    if body.status not in ("available", "occupied", "maintenance"):
        raise HTTPException(400, "Invalid status")
    async with state["pg"].acquire() as conn:
        row = await conn.fetchrow("SELECT status, branch_id FROM seats WHERE id=$1", seat_id)
        if not row:
            raise HTTPException(404, "Seat not found")
        old_status = row["status"]
        await conn.execute("UPDATE seats SET status=$1 WHERE id=$2", body.status, seat_id)
        updated = await conn.fetchrow("SELECT id, seat_number, gpu_model, status, branch_id FROM seats WHERE id=$1", seat_id)
    await state["redis"].publish("seat.status_changed", json.dumps({
        "seat_id": seat_id, "branch_id": str(updated["branch_id"]),
        "old_status": old_status, "new_status": body.status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }))
    return success_response(request, dict(updated), message="Seat status updated successfully")
