import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import Redis from 'ioredis';

export const AUTH_POOL = 'AUTH_POOL';
export const SESSION_POOL = 'SESSION_POOL';
export const REDIS = 'REDIS';

@Global()
@Module({
  providers: [
    { provide: AUTH_POOL, useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL }) },
    { provide: SESSION_POOL, useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL }) },
    { provide: REDIS, useFactory: () => new Redis(process.env.REDIS_URL) },
  ],
  exports: [AUTH_POOL, SESSION_POOL, REDIS],
})
export class DbModule {}
