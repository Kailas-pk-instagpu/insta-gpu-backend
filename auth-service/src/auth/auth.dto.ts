import { IsEmail, IsString, MinLength, IsBoolean } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(4)
  password: string;
}

export class Verify2faDto {
  @IsString()
  tempToken: string;

  @IsString()
  @MinLength(6)
  code: string;
}

export class Toggle2faDto {
  @IsBoolean()
  enable: boolean;
}
