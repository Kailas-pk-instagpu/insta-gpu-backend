import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Length } from 'class-validator';

export class ReauthIntentDto {
  @IsUUID()
  @IsNotEmpty()
  invoiceId: string;

  @IsUUID()
  @IsNotEmpty()
  branchId: string;

  @IsUUID()
  @IsNotEmpty()
  ownerId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @IsString()
  @IsNotEmpty()
  @Length(3, 3)
  currency: string;

  @IsOptional()
  @IsString()
  paymentIntentId?: string;
}
