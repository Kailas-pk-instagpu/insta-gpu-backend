import { Controller, Post, Get, Body, Param, BadRequestException } from '@nestjs/common';
import { IsNumber, IsString, IsNotEmpty, IsIn } from 'class-validator';
import { IntegrationService } from './integration.service';
import { ApiResponse } from '../common/response.util';

class ChargePaymentDto {
  @IsNumber()
  amount: number;

  @IsString()
  @IsNotEmpty()
  token: string;
}

class SendNotificationDto {
  @IsString()
  @IsNotEmpty()
  recipient: string;

  @IsString()
  @IsNotEmpty()
  message: string;

  @IsString()
  @IsIn(['email', 'sms', 'slack'])
  channel: string;
}

@Controller('integration')
export class IntegrationController {
  constructor(private readonly integrationService: IntegrationService) {}

  @Post('payment/charge')
  async chargePayment(@Body() body: ChargePaymentDto) {
    if (body.amount <= 0) {
      throw new BadRequestException('Amount must be greater than zero');
    }
    const result = await this.integrationService.processPayment(body.amount, body.token);
    return new ApiResponse(result, 'Payment processed successfully via third-party provider');
  }

  @Post('notifications/send')
  async sendNotification(@Body() body: SendNotificationDto) {
    const result = await this.integrationService.sendNotification(
      body.recipient,
      body.message,
      body.channel,
    );
    return new ApiResponse(result, 'Notification dispatched successfully via third-party provider');
  }

  @Get('gpu-status/:id')
  async getGpuStatus(@Param('id') id: string) {
    if (!id || id.trim() === '') {
      throw new BadRequestException('GPU ID must not be empty');
    }
    const result = await this.integrationService.getGpuStatus(id);
    return new ApiResponse(result, 'GPU telemetry retrieved successfully from third-party provider');
  }
}
