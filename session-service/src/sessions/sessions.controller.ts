import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { ApiResponse } from '../common/response.util';

@Controller('sessions')
export class SessionsController {
  constructor(private svc: SessionsService) {}

  /** List active sessions for the caller's branch. */
  @Get('active')
  async active(@Headers('x-user-branch') branchId: string) {
    const data = await this.svc.activeForBranch(branchId);
    return new ApiResponse(data, 'Active sessions fetched successfully');
  }

  /** Start a session: validates seat availability and publishes session.started. */
  @Post('start')
  async start(@Headers('x-user-role') role: string, @Body() body: { seat_id: string; player_name: string }) {
    const data = await this.svc.start(role, body.seat_id, body.player_name);
    return new ApiResponse(data, 'Session started successfully');
  }

  /** End an active session and return the settlement preview. */
  @Post(':id/end')
  async end(@Headers('x-user-role') role: string, @Param('id') id: string) {
    const data = await this.svc.end(role, id);
    return new ApiResponse(data, 'Session ended successfully');
  }
}
