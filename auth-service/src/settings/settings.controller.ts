import { Body, Controller, Post, Req } from '@nestjs/common';
import { ProfileService } from '../profile/profile.service';
import { Toggle2faDto } from '../auth/dto';
import { ApiResponse } from '../common/response.util';

@Controller('settings/2fa')
export class SettingsController {
  constructor(private svc: ProfileService) {}

  /** Enable or disable 2FA for the current user. */
  @Post('toggle')
  async toggle(@Req() req: any, @Body() dto: Toggle2faDto) {
    const userId = req.user.sub;
    const data = await this.svc.toggle2fa(userId, !!dto.enable);
    return new ApiResponse(data, '2FA settings updated successfully');
  }
}
