import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto, Verify2faDto } from '../dtos/auth.dto';
import { LoginResponse, Verify2faResponse } from '../interface/auth.interface';
import { Public } from '../utils/public.decorator';
import { ApiResponse } from '../utils/response.util';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) { }

  /** Authenticate user with email and password. */
  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto): Promise<ApiResponse<LoginResponse>> {
    const data = await this.auth.login(dto.email, dto.password);
    return new ApiResponse(data, 'Login successful');
  }

  /** Exchange short-lived temp token + 6-digit code for a full session token. */
  @Public()
  @Post('verify-2fa')
  async verify(@Body() dto: Verify2faDto): Promise<ApiResponse<Verify2faResponse>> {
    const data = await this.auth.verify2fa(dto.tempToken, dto.code);
    return new ApiResponse(data, '2FA verification successful');
  }

  /** Stateless logout (no server-side token blocklist for POC). */
  @Post('logout')
  async logout() {
    await this.auth.logout();
    return new ApiResponse(null, 'Logout successful');
  }
}
