import { Controller, Get } from '@nestjs/common';
import { ApiResponse } from './response.util';

@Controller('health')
export class HealthController {
  @Get() 
  health() { 
    const data = { status:'ok', service:'session-service', timestamp:new Date().toISOString() };
    return new ApiResponse(data, 'Session service is healthy');
  }
}
