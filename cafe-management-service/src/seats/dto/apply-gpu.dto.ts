import { IsString, IsIn } from 'class-validator';
import { GPU_MODEL_OPTIONS, GpuModel } from '../../common/constants/gpu.constants';

export class ApplyGpuDto {
  @IsString()
  @IsIn(GPU_MODEL_OPTIONS)
  gpuModel: GpuModel;
}
