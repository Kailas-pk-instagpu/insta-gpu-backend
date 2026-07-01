# Insta GPU backend

Microservice backend for the Cloud GPU SaaS, targeting two roles: **Cafe Owner** and **Manager**.
Frontend is the existing React app in the repo root; this folder is a self-contained backend you run with Docker.

## One-command startup

```bash
cd cloud-gpu-poc
docker-compose up --build
```

All services come up with seeded data. First boot takes ~2 min while images build.

## Demo credentials

Password for every user: **`Demo@1234`**

| Role        | Email               | Name        |
| ----------- | ------------------- | ----------- |
| Cafe Owner  | owner@demo.com      | Alex Rivera |
| Manager 1   | manager1@demo.com   | Sam Lee     |
| Manager 2   | manager2@demo.com   | Jordan Kim  |

## Port reference

| Service             | Port | Type     |
| ------------------- | ---- | -------- |
| API Gateway         | 3000 | NestJS   |
| Auth Service        | 3001 | NestJS   |
| Session Service     | 3002 | NestJS   |
| Cafe Mgmt Service   | 3003 | NestJS   |
| GPU Metrics Worker  | 8000 | FastAPI  |
| Settlement Worker   | 8001 | FastAPI  |
| insta-db (Postgres) | 5432 | Postgres |
| Redis               | 6379 | Redis    |

Every service exposes `GET /health`.

## 5-minute demo script

All calls go through the gateway at `http://localhost:3000`.

1. **Login as manager**
   ```bash
   curl -X POST localhost:3000/api/auth/login \
     -H 'content-type: application/json' \
     -d '{"email":"manager1@demo.com","password":"Demo@1234"}'
   ```
   Save the returned `token` as `$MGR`.

2. **View seat grid** (12 seats at Alpha Lounge)
   ```bash
   curl localhost:3000/api/branches -H "Authorization: Bearer $MGR"
   # grab the branch id, then:
   curl localhost:3000/api/seats/<branch_id> -H "Authorization: Bearer $MGR"
   ```

3. **Assign a seat / start a session** (pick any available seat id)
   ```bash
   curl -X POST localhost:3000/api/sessions/start \
     -H "Authorization: Bearer $MGR" -H 'content-type: application/json' \
     -d '{"seat_id":"<seat_id>","player_name":"Demo Player"}'
   ```

4. **End the session** (returns settlement preview)
   ```bash
   curl -X POST localhost:3000/api/sessions/<session_id>/end \
     -H "Authorization: Bearer $MGR"
   ```

5. **Confirm settlement** (settlement-worker writes the payment row)
   ```bash
   curl -X POST localhost:8001/settlements/confirm \
     -H 'content-type: application/json' \
     -d '{"session_id":"<session_id>"}'
   ```

6. **Login as cafe owner & review dashboard**
   ```bash
   curl -X POST localhost:3000/api/auth/login \
     -H 'content-type: application/json' \
     -d '{"email":"owner@demo.com","password":"Demo@1234"}'
   # save token as $OWNER, then:
   curl localhost:3000/api/dashboard/owner -H "Authorization: Bearer $OWNER"
   curl 'localhost:3000/api/settlements?page=1&limit=10' -H "Authorization: Bearer $OWNER"
   ```

## Architecture

```
            ┌──────────────┐
            │   Gateway    │  :3000  JWT + role guards + WS /live
            └──────┬───────┘
       ┌──────────┼──────────────┬─────────────┐
       ▼          ▼              ▼             ▼
   Auth Svc   Session Svc   Cafe-Mgmt Svc   Settlement
   :3001      :3002         :3003           Worker :8001
       │          │              │             │
       ▼          ▼              ▼             ▼
    auth-db   auth-db +       auth-db +     session-db
              session-db      session-db
                        ▲
                        │   GPU Metrics Worker :8000
                        │   polls auth-db every 60s
                        ▼
                      Redis  (pub/sub + live cache)
```

## Redis channels

- `session.started`  — new session
- `session.ended`    — session completed (settlement-worker logs it)
- `settlement.done`  — payment recorded
- `seat.status_changed` — direct seat-status mutation

## Error format

Every service returns:

```json
{ "error": true, "message": "Human readable", "code": "SNAKE_CASE_CODE" }
```

## Notes / POC simplifications

- JWT access token only, no refresh, 12h expiry.
- 2FA accepts any 6-digit numeric code.
- Login also accepts the literal `Demo@1234` password to avoid bcrypt seed-hash drift across Postgres versions.
- All monetary values returned as strings to 2 decimals.
- All timestamps returned as ISO 8601.
