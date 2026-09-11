import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { SeatsService } from './seats.service';
import { ApiResponse } from '../common/utils/response.util';
import { UpdateSeatDto } from './dto/update-seat.dto';

@Controller('seats')
export class SeatsController {
  constructor(private readonly seatsService: SeatsService) {}

  /**
   * Predefined GPU models list (alias under /seats).
   */
  @Get('gpu-models')
  async getGpuModels() {
    const data = this.seatsService.getGpuModels();
    return new ApiResponse(data, 'GPU models fetched successfully');
  }

  /**
   * Update seat label, gpuModel, or status.
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSeatDto,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
  ) {
    const data = await this.seatsService.updateSeat(id, dto, userId, role);
    return new ApiResponse(data, 'Seat updated successfully');
  }

  /**
   * Activity log for a specific seat.
   */
  @Get(':id/activity')
  async activity(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') role: string,
    @Query('page') pageStr = '1',
    @Query('limit') limitStr = '50',
  ) {
    const page = Math.max(1, Number(pageStr) || 1);
    const limit = Math.min(100, Math.max(1, Number(limitStr) || 50));
    const data = await this.seatsService.getSeatActivity(id, userId, role, page, limit);
    return new ApiResponse(data, 'Seat activity fetched successfully');
  }
}
