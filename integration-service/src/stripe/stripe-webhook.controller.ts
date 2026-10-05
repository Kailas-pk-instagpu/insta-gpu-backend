import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { StripeService } from './stripe.service';

/**
 * Public Stripe webhook (auth = Stripe-Signature, not internal token).
 * Must receive the raw request body for signature verification.
 */
@Controller('webhooks')
export class StripeWebhookController {
  constructor(private readonly stripeService: StripeService) {}

  @Post('stripe')
  @HttpCode(200)
  async handleStripeWebhook(
    @Req() req: any,
    @Headers('stripe-signature') signature?: string,
  ) {
    if (!signature) {
      throw new UnauthorizedException('Missing stripe-signature header');
    }

    const rawBody: Buffer | undefined =
      req.rawBody ||
      (Buffer.isBuffer(req.body) ? req.body : undefined);

    if (!rawBody) {
      throw new BadRequestException(
        'Raw body unavailable for Stripe signature verification',
      );
    }

    try {
      const result = await this.stripeService.handleWebhook(rawBody, signature);
      return result;
    } catch (err: any) {
      if (err?.message?.includes('signature') || err?.type === 'StripeSignatureVerificationError') {
        throw new UnauthorizedException('Invalid Stripe signature');
      }
      throw err;
    }
  }
}
