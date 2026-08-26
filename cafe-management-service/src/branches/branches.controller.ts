import { Controller, Get, Headers, Param } from '@nestjs/common';
import { BranchesService } from './branches.service';
import { ApiResponse } from '../common/utils/response.util';

@Controller('branches')
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  /** List branches scoped to caller role. */
  @Get()
  async list(@Headers('x-user-id') userId: string, @Headers('x-user-role') role: string) {
    const data = await this.branchesService.listBranches(userId, role);
    return new ApiResponse(data, 'Branches fetched successfully');
  }

  /** List seats for a branch, joining live session data. */
  @Get(':id/seats')
  async seats(@Param('id') branchId: string) {
    const data = await this.branchesService.listSeats(branchId);
    return new ApiResponse(data, 'Seats fetched successfully');
  }
}
