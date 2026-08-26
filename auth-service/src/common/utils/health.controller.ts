import { Controller, Get } from '@nestjs/common';
import { Public } from './public.decorator';
import { ApiResponse } from './response.util';

/** Service liveness check. */
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check() {
    const data = { status: 'ok', service: 'auth', timestamp: new Date().toISOString() };
    return new ApiResponse(data, 'Auth service is healthy');
  }
}
