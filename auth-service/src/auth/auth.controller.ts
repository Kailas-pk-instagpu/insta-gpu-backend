import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto, Verify2faDto } from './dto';
import { Public } from '../common/public.decorator';
import { ApiResponse } from '../common/response.util';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) { }

  /** Authenticate user with email and password. */
  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto) {
    const data = await this.auth.login(dto.email, dto.password);
    return new ApiResponse(data, 'Login successful');
  }

  /** Exchange short-lived temp token + 6-digit code for a full session token. */
  @Public()
  @Post('verify-2fa')
  async verify(@Body() dto: Verify2faDto) {
    const data = await this.auth.verify2fa(dto.tempToken, dto.code);
    return new ApiResponse(data, '2FA verification successful');
  }

  /** Stateless logout (no server-side token blocklist for POC). */
  @Post('logout')
  logout() {
    return { success: true };
  }
}
