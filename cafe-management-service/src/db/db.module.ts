import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { AUTH_POOL, SESSION_POOL } from '../common/interfaces/types';

@Global()
@Module({
  providers: [
    {
      provide: AUTH_POOL,
      useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL }),
    },
    {
      provide: SESSION_POOL,
      useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL }),
    },
  ],
  exports: [AUTH_POOL, SESSION_POOL],
})
export class DbModule {}
