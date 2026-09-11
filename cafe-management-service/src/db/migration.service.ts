import { Inject, Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { AUTH_POOL } from '../common/interfaces/types';

@Injectable()
export class MigrationService implements OnModuleInit {
  private readonly logger = new Logger(MigrationService.name);

  constructor(@Inject(AUTH_POOL) private readonly pool: Pool) {}

  async onModuleInit() {
    await this.runMigrations();
  }

  async runMigrations() {
    try {
      this.logger.log('Checking and executing database schema migrations...');

      // 1. Users table updates
      await this.pool.query(`
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
        ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin', 'admin', 'cafe_owner', 'manager'));
        ALTER TABLE users ADD COLUMN IF NOT EXISTS cafe_id TEXT;
      `);

      // 2. Branches table updates
      await this.pool.query(`
        ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_status_check;
        ALTER TABLE branches ADD CONSTRAINT branches_status_check CHECK (status IN ('active', 'inactive', 'maintenance'));
        ALTER TABLE branches ADD COLUMN IF NOT EXISTS address TEXT;
        ALTER TABLE branches ADD COLUMN IF NOT EXISTS cafe_id TEXT;
        ALTER TABLE branches ADD COLUMN IF NOT EXISTS total_seats INT NOT NULL DEFAULT 0;
        ALTER TABLE branches ADD COLUMN IF NOT EXISTS admin_id UUID REFERENCES users(id) ON DELETE SET NULL;
        ALTER TABLE branches ADD COLUMN IF NOT EXISTS cafe_owner_id UUID REFERENCES users(id) ON DELETE SET NULL;
        ALTER TABLE branches ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES users(id) ON DELETE SET NULL;
        ALTER TABLE branches ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2) NOT NULL DEFAULT 5.00;
        ALTER TABLE branches ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
        ALTER TABLE branches ADD COLUMN IF NOT EXISTS daily_spend_limit NUMERIC(10,2) NULL;
        ALTER TABLE branches ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

        UPDATE branches SET cafe_owner_id = owner_id WHERE cafe_owner_id IS NULL AND owner_id IS NOT NULL;
        UPDATE branches SET address = location WHERE address IS NULL AND location IS NOT NULL;
      `);

      // 3. Seats table updates
      await this.pool.query(`
        ALTER TABLE seats ADD COLUMN IF NOT EXISTS label TEXT NULL;
        ALTER TABLE seats ADD COLUMN IF NOT EXISTS player_name TEXT NULL;
        ALTER TABLE seats ADD COLUMN IF NOT EXISTS start_time TIMESTAMPTZ NULL;
        ALTER TABLE seats ADD COLUMN IF NOT EXISTS end_time TIMESTAMPTZ NULL;
        ALTER TABLE seats ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
        CREATE UNIQUE INDEX IF NOT EXISTS idx_seats_branch_seat_number ON seats(branch_id, seat_number);
      `);

      // 4. Seat activity logs table
      await this.pool.query(`
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
        CREATE INDEX IF NOT EXISTS idx_seat_activity_logs_branch ON seat_activity_logs(branch_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_seat_activity_logs_seat ON seat_activity_logs(seat_id, created_at DESC);
      `);

      this.logger.log('Database schema migrations applied successfully.');
    } catch (err: any) {
      this.logger.error(`Migration error: ${err.message}`, err.stack);
    }
  }
}
