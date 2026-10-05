import { Module } from '@nestjs/common';
import { StripeController } from './stripe.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeService } from './stripe.service';
import { InternalAuthGuard } from './guards/internal-auth.guard';

@Module({
  controllers: [StripeController, StripeWebhookController],
  providers: [StripeService, InternalAuthGuard],
  exports: [StripeService],
})
export class StripeModule {}
