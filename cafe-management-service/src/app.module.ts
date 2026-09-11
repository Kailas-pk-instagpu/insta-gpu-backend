import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module';
import { BranchesModule } from './branches/branches.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { SettlementsModule } from './settlements/settlements.module';
import { HealthController } from './common/utils/health.controller';

import { RedisModule } from './common/redis/redis.module';
import { SeatsModule } from './seats/seats.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DbModule,
    RedisModule,
    BranchesModule,
    SeatsModule,
    DashboardModule,
    SettlementsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
