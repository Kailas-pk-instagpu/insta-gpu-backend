import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class SetupIntentDto {
  @IsUUID()
  @IsNotEmpty()
  ownerId: string;
}
