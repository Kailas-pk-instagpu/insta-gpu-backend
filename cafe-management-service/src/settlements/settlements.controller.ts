import { Controller, Get, Headers, Query } from '@nestjs/common';
import { SettlementsService } from './settlements.service';
import { ApiResponse } from '../common/utils/response.util';

@Controller('settlements')
export class SettlementsController {
  constructor(private readonly settlementsService: SettlementsService) {}

  /** Paginated settlements, scoped by role. */
  @Get()
  async list(
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
    @Headers('x-user-branch') branchHeader: string,
    @Query('page') pageStr = '1',
    @Query('limit') limitStr = '10',
  ) {
    const data = await this.settlementsService.listSettlements(
      userId,
      role,
      branchHeader,
      pageStr,
      limitStr,
    );
    return new ApiResponse(data, 'Settlements fetched successfully');
  }
}
