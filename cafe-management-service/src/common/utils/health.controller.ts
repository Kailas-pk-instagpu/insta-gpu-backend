import { Controller, Get } from '@nestjs/common';
import { ApiResponse } from './response.util';

/** Service liveness check. */
@Controller('health')
export class HealthController {
  @Get()
  check() {
    const data = { status: 'ok', service: 'cafe-mgmt-service', timestamp: new Date().toISOString() };
    return new ApiResponse(data, 'Cafe management service is healthy');
  }
}
