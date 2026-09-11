import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { BranchesService } from './branches.service';
import { ApiResponse } from '../common/utils/response.util';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { UpdateBranchStatusDto } from './dto/update-status.dto';
import { UpdateSpendLimitDto } from './dto/update-spend-limit.dto';
import { ProvisionSeatsDto } from '../seats/dto/provision-seats.dto';
import { ApplyGpuDto } from '../seats/dto/apply-gpu.dto';

@Controller('branches')
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  /**
   * Return predefined list of GPU models matching frontend options.
   */
  @Get('gpu-models')
  async getGpuModels() {
    const data = this.branchesService.getGpuModels();
    return new ApiResponse(data, 'GPU models fetched successfully');
  }

  /**
   * Create branch & provision initial seats.
   */
  @Post()
  async create(
    @Body() dto: CreateBranchDto,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
  ) {
    const data = await this.branchesService.createBranch(dto, userId, role);
    return new ApiResponse(data, 'Branch created successfully');
  }

  /**
   * List branches scoped to caller role.
   */
  @Get()
  async list(
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
  ) {
    const data = await this.branchesService.listBranches(userId, role);
    return new ApiResponse(data, 'Branches fetched successfully');
  }

  /**
   * Get single branch detail scoped to caller role.
   */
  @Get(':id')
  async get(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
  ) {
    const data = await this.branchesService.getBranch(id, userId, role);
    return new ApiResponse(data, 'Branch fetched successfully');
  }

  /**
   * Update branch metadata & sync seat count.
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateBranchDto,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
  ) {
    const data = await this.branchesService.updateBranch(id, dto, userId, role);
    return new ApiResponse(data, 'Branch updated successfully');
  }

  /**
   * Toggle status ('active' | 'inactive' | 'maintenance').
   */
  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateBranchStatusDto,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
  ) {
    const data = await this.branchesService.updateStatus(id, dto, userId, role);
    return new ApiResponse(data, 'Branch status updated successfully');
  }

  /**
   * Set or update owner daily spend limit threshold.
   */
  @Patch(':id/spend-limit')
  async updateSpendLimit(
    @Param('id') id: string,
    @Body() dto: UpdateSpendLimitDto,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
  ) {
    const data = await this.branchesService.updateSpendLimit(id, dto, userId, role);
    return new ApiResponse(data, 'Spend limit updated successfully');
  }

  /**
   * Delete branch — blocked if any seats still exist.
   */
  @Delete(':id')
  async delete(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
  ) {
    const data = await this.branchesService.deleteBranch(id, userId, role);
    return new ApiResponse(data, 'Branch deleted successfully');
  }

  /**
   * Bulk provision seats for branch.
   */
  @Post(':branchId/seats/provision')
  async provisionSeats(
    @Param('branchId') branchId: string,
    @Body() dto: ProvisionSeatsDto,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
  ) {
    const data = await this.branchesService.provisionSeats(branchId, dto, userId, role);
    return new ApiResponse(data, 'Seats provisioned successfully');
  }

  /**
   * List seats for a branch.
   */
  @Get(':branchId/seats')
  async seats(
    @Param('branchId') branchId: string,
    @Headers('x-user-id') userId?: string,
    @Headers('x-user-role') role?: string,
  ) {
    const data = await this.branchesService.listSeats(branchId, userId, role);
    return new ApiResponse(data, 'Seats fetched successfully');
  }

  /**
   * Bulk apply GPU model to all non-occupied seats in a branch.
   */
  @Post(':branchId/seats/apply-gpu')
  async applyGpu(
    @Param('branchId') branchId: string,
    @Body() dto: ApplyGpuDto,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
  ) {
    const data = await this.branchesService.applyGpuToBranch(branchId, dto, userId, role);
    return new ApiResponse(data, 'GPU model applied successfully');
  }

  /**
   * Audit activity log for a branch's seats.
   */
  @Get(':branchId/seats/activity')
  async branchSeatActivity(
    @Param('branchId') branchId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
    @Query('page') pageStr = '1',
    @Query('limit') limitStr = '50',
  ) {
    const page = Math.max(1, Number(pageStr) || 1);
    const limit = Math.min(100, Math.max(1, Number(limitStr) || 50));
    const data = await this.branchesService.getBranchActivity(branchId, userId, role, page, limit);
    return new ApiResponse(data, 'Seat activity fetched successfully');
  }
}
