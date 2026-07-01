import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

const FIELDS = ['name', 'email', 'phone', 'address', 'avatar_url'] as const;

@Injectable()
export class ProfileService {
  constructor(@Inject(PG_POOL) private pool: Pool) {}

  private completion(user: any): number {
    let filled = 0;
    for (const f of FIELDS) if (user[f]) filled++;
    if (user.two_fa_enabled) filled++;
    return Math.round((filled / 6) * 100);
  }

  async get(userId: string) {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE id=$1', [userId]);
    if (!rows[0]) throw new NotFoundException('User not found');
    const u = rows[0];
    delete u.password_hash;
    return { ...u, profile_completion_percentage: this.completion(u) };
  }

  async update(userId: string, patch: Partial<Record<string, string>>) {
    const allowed = ['name', 'phone', 'address', 'avatar_url'];
    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    for (const k of allowed) {
      if (patch[k] !== undefined) {
        sets.push(`${k}=$${i++}`);
        vals.push(patch[k]);
      }
    }
    if (sets.length) {
      vals.push(userId);
      await this.pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id=$${i}`, vals);
    }
    return this.get(userId);
  }

  async toggle2fa(userId: string, enable: boolean) {
    if (enable) {
      await this.pool.query(
        `UPDATE users SET two_fa_enabled=true, two_fa_secret='DEMO_SECRET' WHERE id=$1`,
        [userId],
      );
      return { qrPlaceholder: 'otpauth://demo/cloudgpu' };
    }
    await this.pool.query(
      `UPDATE users SET two_fa_enabled=false, two_fa_secret=NULL WHERE id=$1`,
      [userId],
    );
    return { success: true };
  }
}
