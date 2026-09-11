import { IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateSpendLimitDto {
  @IsNumber()
  @Min(0)
  @IsOptional()
  dailySpendLimit: number | null;
}
