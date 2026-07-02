import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(4) password: string;
}

export class Verify2faDto {
  @IsString() tempToken: string;
  @IsString() @MinLength(6) code: string;
}

export class UpdateProfileDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() avatar_url?: string;
}

export class Toggle2faDto {
  @IsBoolean() enable: boolean;
}
