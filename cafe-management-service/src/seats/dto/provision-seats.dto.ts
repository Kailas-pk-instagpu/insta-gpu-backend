import { IsInt, Min, IsString, IsIn, IsOptional } from 'class-validator';
import { GPU_MODEL_OPTIONS, GpuModel } from '../../common/constants/gpu.constants';

export class ProvisionSeatsDto {
  @IsInt()
  @Min(1)
  count: number;

  @IsString()
  @IsIn(GPU_MODEL_OPTIONS)
  gpuModel: GpuModel;

  @IsString()
  @IsOptional()
  labelPrefix?: string;
}
