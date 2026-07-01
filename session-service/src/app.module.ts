import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module';
import { SeatsController } from './seats/seats.controller';
import { SessionsController } from './sessions/sessions.controller';
import { SessionsService } from './sessions/sessions.service';
import { DashboardController } from './dashboard/dashboard.controller';
import { EventsService } from './events/events.service';
import { HealthController } from './common/health.controller';
import { SeedSyncService } from './db/seed-sync.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DbModule],
  controllers: [SeatsController, SessionsController, DashboardController, HealthController],
  providers: [SessionsService, EventsService, SeedSyncService],
})
export class AppModule {}
