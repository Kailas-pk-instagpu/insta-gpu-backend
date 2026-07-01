import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { UpdateProfileDto } from '../auth/dto';
import { ApiResponse } from 'src/common/response.util';

@Controller('profile')
export class ProfileController {
  constructor(private profileService: ProfileService) { }

  /** Return current user profile with completion percentage. */
  @Get()
  async get(@Req() req: any) {
    const userId = req.user.sub;
    const data = await this.profileService.get(userId);
    return new ApiResponse(data, 'Profile fetched successfully');
  }

  /** Update editable profile fields. */
  @Patch()
  async update(@Req() req: any, @Body() dto: UpdateProfileDto) {
    const userId = req.user.sub;
    const data = await this.profileService.update(userId, dto as any);
    return new ApiResponse(data, 'Profile updated successfully');
  }
}
