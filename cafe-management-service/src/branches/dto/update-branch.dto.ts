import { IsString, IsOptional, IsInt, Min, IsNumber, IsIn, IsUUID } from 'class-validator';
import { GPU_MODEL_OPTIONS, GpuModel } from '../../common/constants/gpu.constants';

export class UpdateBranchDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  cafeId?: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  totalSeats?: number;

  @IsString()
  @IsIn(GPU_MODEL_OPTIONS)
  @IsOptional()
  defaultGpuModel?: GpuModel;

  @IsUUID('all')
  @IsOptional()
  adminId?: string | null;

  @IsUUID('all')
  @IsOptional()
  cafeOwnerId?: string | null;

  @IsUUID('all')
  @IsOptional()
  managerId?: string | null;

  @IsNumber()
  @Min(0)
  @IsOptional()
  hourlyRate?: number;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  dailySpendLimit?: number | null;
}
