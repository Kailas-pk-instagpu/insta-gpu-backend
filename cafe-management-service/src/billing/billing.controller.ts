import { Controller, Get, Post, Param, Query, Headers } from '@nestjs/common';
import { BillingService } from './billing.service';
import { ApiResponse } from '../common/utils/response.util';

@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  /**
   * Full invoice history for a branch (paginated).
   * Missed & due: ?status=failed,missed,needs_reauth
   */
  @Get('branches/:id/invoices')
  async listInvoices(
    @Param('id') branchId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const data = await this.billingService.listInvoices(userId, role, branchId, {
      page,
      limit,
      status,
      from,
      to,
    });
    return new ApiResponse(data, 'Invoices fetched successfully');
  }

  /**
   * Manual pay-now — proxies to Settlement which uses the same
   * /internal/stripe/charge path as the cron (or reauth client_secret for 3DS).
   */
  @Post('invoices/:id/pay-now')
  async payNow(
    @Param('id') invoiceId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
  ) {
    const data = await this.billingService.payNow(userId, role, invoiceId);
    return new ApiResponse(data, 'Pay-now initiated');
  }
}
