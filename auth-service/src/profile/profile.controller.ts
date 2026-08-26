import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { UpdateProfileDto } from './profile.dto';
import { ProfileResponse } from './profile.interface';
import { ApiResponse } from 'src/common/utils/response.util';

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
}
