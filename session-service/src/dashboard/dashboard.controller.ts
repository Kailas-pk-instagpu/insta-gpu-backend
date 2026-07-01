import { Controller, Get, Headers } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service';
import { ApiResponse } from '../common/response.util';

@Controller('dashboard')
export class DashboardController {
  constructor(private svc: SessionsService) {}

  /** Manager dashboard KPIs for a single branch. */
  @Get('manager')
  async manager(@Headers('x-user-branch') branchId: string) {
    const data = await this.svc.dashboard(branchId);
    return new ApiResponse(data, 'Manager dashboard data fetched successfully');
  }
}
