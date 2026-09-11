import { IsString, IsOptional, IsIn, IsDateString } from 'class-validator';
import { GPU_MODEL_OPTIONS, GpuModel } from '../../common/constants/gpu.constants';

export class UpdateSeatDto {
  @IsString()
  @IsOptional()
  label?: string | null;

  @IsString()
  @IsIn(GPU_MODEL_OPTIONS)
  @IsOptional()
  gpuModel?: GpuModel;

  @IsString()
  @IsIn(['available', 'occupied', 'maintenance'])
  @IsOptional()
  status?: 'available' | 'occupied' | 'maintenance';

  @IsString()
  @IsOptional()
  playerName?: string | null;

  @IsDateString()
  @IsOptional()
  startTime?: string | null;

  @IsDateString()
  @IsOptional()
  endTime?: string | null;
}
