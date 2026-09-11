-- ============================================================
-- insta_gpu unified schema + seed
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- From auth_db
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT CHECK (role IN ('super_admin', 'admin', 'cafe_owner', 'manager')) NOT NULL,
  name TEXT,
  phone TEXT,
  address TEXT,
  avatar_url TEXT,
  two_fa_enabled BOOLEAN DEFAULT false,
  two_fa_secret TEXT,
  branch_id UUID,
  cafe_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  location TEXT,
  address TEXT,
  cafe_id TEXT,
  total_seats INT DEFAULT 0,
  status TEXT CHECK (status IN ('active', 'inactive', 'maintenance')) DEFAULT 'active',
  owner_id UUID REFERENCES users(id),
  admin_id UUID REFERENCES users(id),
  cafe_owner_id UUID REFERENCES users(id),
  manager_id UUID REFERENCES users(id),
  hourly_rate NUMERIC(10,2) DEFAULT 5.00,
  currency TEXT DEFAULT 'USD',
  daily_spend_limit NUMERIC(10,2) NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
  seat_number INT NOT NULL,
  label TEXT,
  gpu_model TEXT NOT NULL,
  status TEXT CHECK (status IN ('available', 'occupied', 'maintenance')) DEFAULT 'available',
  player_name TEXT,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_seats_branch_number UNIQUE (branch_id, seat_number)
);

CREATE TABLE IF NOT EXISTS seat_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id UUID REFERENCES seats(id) ON DELETE SET NULL,
  seat_number INT NOT NULL,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  field TEXT CHECK (field IN ('label', 'gpuModel', 'status')) NOT NULL,
  from_value TEXT,
  to_value TEXT,
  actor_id TEXT,
  actor_role TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- From session_db
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  player_name TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ,
  duration_minutes INT,
  cost_per_hour NUMERIC(10,2) DEFAULT 5.00,
  total_cost NUMERIC(10,2),
  status TEXT CHECK (status IN ('active','completed')) DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id),
  branch_id UUID NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  payment_method TEXT DEFAULT 'cash',
  settled_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seed_seat_map (
  seat_number INT PRIMARY KEY,
  seat_id UUID NOT NULL,
  branch_id UUID NOT NULL
);

-- ============================================================
-- Seed
-- ============================================================
DO $$
DECLARE
  v_owner UUID;
  v_mgr1  UUID;
  v_mgr2  UUID;
  v_branch UUID;
  v_hash TEXT := '$2b$10$E9p3oKj7d2fT8bQ1zVw1Z.6sxv8YqQyP4U8m2lkLs1y0E9Y6XK8/e';
  v_zero UUID := '00000000-0000-0000-0000-000000000000';
BEGIN
  -- Users & Branches
  INSERT INTO users (email, password_hash, role, name)
  VALUES ('owner@demo.com', v_hash, 'cafe_owner', 'Alex Rivera')
  RETURNING id INTO v_owner;

  INSERT INTO branches (name, location, status, owner_id)
  VALUES ('Alpha Lounge', 'Downtown', 'active', v_owner)
  RETURNING id INTO v_branch;

  INSERT INTO users (email, password_hash, role, name, branch_id)
  VALUES ('manager1@demo.com', v_hash, 'manager', 'Sam Lee', v_branch)
  RETURNING id INTO v_mgr1;

  INSERT INTO users (email, password_hash, role, name, branch_id)
  VALUES ('manager2@demo.com', v_hash, 'manager', 'Jordan Kim', v_branch)
  RETURNING id INTO v_mgr2;

  -- Seats
  INSERT INTO seats (branch_id, seat_number, gpu_model, status) VALUES
    (v_branch, 1,  'RTX 4070', 'occupied'),
    (v_branch, 2,  'RTX 4070', 'available'),
    (v_branch, 3,  'RTX 4070', 'available'),
    (v_branch, 4,  'RTX 4070', 'available'),
    (v_branch, 5,  'RTX 4070', 'occupied'),
    (v_branch, 6,  'RTX 4070', 'available'),
    (v_branch, 7,  'RTX 4080', 'available'),
    (v_branch, 8,  'RTX 4080', 'available'),
    (v_branch, 9,  'RTX 4080', 'occupied'),
    (v_branch, 10, 'RTX 4080', 'available'),
    (v_branch, 11, 'RTX 4080', 'maintenance'),
    (v_branch, 12, 'RTX 4080', 'available');

  -- Active Sessions
  INSERT INTO sessions (id, seat_id, branch_id, player_name, started_at, cost_per_hour, status)
  VALUES
    (gen_random_uuid(), v_zero, v_zero, 'Player A', now() - interval '45 minutes', 5.00, 'active'),
    (gen_random_uuid(), v_zero, v_zero, 'Player B', now() - interval '30 minutes', 5.00, 'active'),
    (gen_random_uuid(), v_zero, v_zero, 'Player C', now() - interval '20 minutes', 5.00, 'active');

  -- Historical Settlements
  FOR i IN 1..7 LOOP
    WITH s AS (
      INSERT INTO sessions (seat_id, branch_id, player_name, started_at, ended_at, duration_minutes, cost_per_hour, total_cost, status)
      VALUES (v_zero, v_zero, 'Historic Player ' || i,
              now() - (i || ' days')::interval - interval '2 hours',
              now() - (i || ' days')::interval - interval '1 hour',
              60, 5.00, (3 + (i * 1.5))::numeric(10,2), 'completed')
      RETURNING id, total_cost, branch_id
    )
    INSERT INTO settlements (session_id, branch_id, amount, payment_method, settled_at)
    SELECT id, branch_id, total_cost, 'cash', now() - (i || ' days')::interval FROM s;
  END LOOP;

  RAISE NOTICE 'Seed completed for insta_gpu';
END $$;
