import { IsString, IsNotEmpty, IsOptional, IsInt, Min, IsNumber, IsIn, IsUUID } from 'class-validator';
import { GPU_MODEL_OPTIONS, GpuModel } from '../../common/constants/gpu.constants';

export class CreateBranchDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @IsOptional()
  cafeId?: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  totalSeats?: number = 0;

  @IsString()
  @IsIn(GPU_MODEL_OPTIONS)
  @IsOptional()
  defaultGpuModel?: GpuModel = 'RTX 4070';

  @IsNumber()
  @Min(0)
  @IsOptional()
  hourlyRate?: number = 5.0;

  @IsString()
  @IsOptional()
  currency?: string = 'USD';

  @IsNumber()
  @Min(0)
  @IsOptional()
  dailySpendLimit?: number | null = null;

  @IsUUID('all')
  @IsOptional()
  adminId?: string;

  @IsUUID('all')
  @IsOptional()
  cafeOwnerId?: string;

  @IsUUID('all')
  @IsOptional()
  managerId?: string;
}
