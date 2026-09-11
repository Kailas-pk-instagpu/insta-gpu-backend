import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class UpdateBranchStatusDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['active', 'inactive', 'maintenance'])
  status: 'active' | 'inactive' | 'maintenance';
}
