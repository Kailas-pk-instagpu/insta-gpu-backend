import { Controller, Get, Headers } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { ApiResponse } from '../common/utils/response.util';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /** Cafe-owner dashboard: aggregate KPIs across owned branches. */
  @Get('owner')
  async owner(@Headers('x-user-id') ownerId: string) {
    const data = await this.dashboardService.getOwnerDashboard(ownerId);
    return new ApiResponse(data, 'Owner dashboard data fetched successfully');
  }
}
