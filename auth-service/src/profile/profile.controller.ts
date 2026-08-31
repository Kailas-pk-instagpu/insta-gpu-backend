import { Body, Controller, Get, Patch, Post, Req } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { UpdateProfileDto } from '../dtos/profile.dto';
import { ProfileResponse } from '../interface/profile.interface';
import { ApiResponse } from 'src/utils/response.util';
import { Toggle2faDto } from 'src/dtos/auth.dto';

@Controller('profile')
export class ProfileController {
  constructor(private profileService: ProfileService) { }

  /** Return current user profile with completion percentage. */
  @Get()
  async get(@Req() req: any): Promise<ApiResponse<ProfileResponse>> {
    const userId = req.user.userId;
    const data = await this.profileService.get(userId);
    return new ApiResponse(data, 'Profile fetched successfully');
  }

  /** Update editable profile fields. */
  @Patch()
  async update(@Req() req: any, @Body() dto: UpdateProfileDto): Promise<ApiResponse<ProfileResponse>> {
    const userId = req.user.userId;
    const data = await this.profileService.update(userId, dto as any);
    return new ApiResponse(data, 'Profile updated successfully');
  }

  /** Enable or disable 2FA for the current user. */
  @Post('toggle-2fa')
  async toggle2fa(@Req() req: any, @Body() dto: Toggle2faDto) {
    const userId = req.user.userId;
    const data = await this.profileService.toggle2fa(userId, dto.enable);
    return new ApiResponse(data, '2FA settings updated successfully');
  }
}
