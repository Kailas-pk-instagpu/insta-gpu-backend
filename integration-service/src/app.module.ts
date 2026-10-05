import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './common/health.controller';
import { IntegrationController } from './integration/integration.controller';
import { IntegrationService } from './integration/integration.service';
import { DbModule } from './db/db.module';
import { StripeModule } from './stripe/stripe.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DbModule, StripeModule],
  controllers: [HealthController, IntegrationController],
  providers: [IntegrationService],
})
export class AppModule {}
