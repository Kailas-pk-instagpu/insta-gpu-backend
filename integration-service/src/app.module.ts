import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './common/health.controller';
import { IntegrationController } from './integration/integration.controller';
import { IntegrationService } from './integration/integration.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [HealthController, IntegrationController],
  providers: [IntegrationService],
})
export class AppModule {}
