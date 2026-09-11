import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { AUTH_POOL, SESSION_POOL } from '../common/interfaces/types';

import { MigrationService } from './migration.service';

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
    MigrationService,
  ],
  exports: [AUTH_POOL, SESSION_POOL, MigrationService],
})
export class DbModule {}
