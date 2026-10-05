import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiResponse } from '../common/response.util';
import { ChargeDto } from './dto/charge.dto';
import { ReauthIntentDto } from './dto/reauth-intent.dto';
import { SetupIntentDto } from './dto/setup-intent.dto';
import { InternalAuthGuard } from './guards/internal-auth.guard';
import { StripeService } from './stripe.service';

@Controller('internal/stripe')
@UseGuards(InternalAuthGuard)
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  @Post('setup-intent')
  async setupIntent(@Body() body: SetupIntentDto) {
    const result = await this.stripeService.createSetupIntent(body.ownerId);
    return new ApiResponse(result, 'SetupIntent created');
  }

  @Post('charge')
  async charge(
    @Body() body: ChargeDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const result = await this.stripeService.charge({
      branchId: body.branchId,
      invoiceId: body.invoiceId,
      amount: body.amount,
      currency: body.currency,
      ownerId: body.ownerId,
      idempotencyKey: idempotencyKey.trim(),
    });

    return new ApiResponse(result, `Stripe charge status: ${result.status}`);
  }

  @Post('reauth-intent')
  async reauthIntent(@Body() body: ReauthIntentDto) {
    const result = await this.stripeService.createReauthIntent({
      invoiceId: body.invoiceId,
      branchId: body.branchId,
      ownerId: body.ownerId,
      amount: body.amount,
      currency: body.currency,
      paymentIntentId: body.paymentIntentId,
    });
    return new ApiResponse(result, 'Reauth PaymentIntent client secret ready');
  }
}
