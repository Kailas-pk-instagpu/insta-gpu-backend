import { IsNotEmpty, IsNumber, IsPositive, IsString, IsUUID, Length } from 'class-validator';

export class ChargeDto {
  @IsUUID()
  @IsNotEmpty()
  branchId: string;

  @IsUUID()
  @IsNotEmpty()
  invoiceId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @IsString()
  @IsNotEmpty()
  @Length(3, 3)
  currency: string;

  @IsUUID()
  @IsNotEmpty()
  ownerId: string;
}
