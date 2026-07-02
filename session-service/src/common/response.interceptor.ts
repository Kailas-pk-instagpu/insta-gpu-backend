import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiResponse } from './response.util';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const method = request.method || request.raw?.method;
    const path = request.url || request.raw?.url;
    console.log(`[session-service] ${method} ${path}`);
    return next.handle().pipe(
      map((res) => ({
        success: true,
        data: res instanceof ApiResponse ? res.data : res,
        message: res instanceof ApiResponse ? res.message || null : null,
        timestamp: new Date().toISOString(),
        path,
      })),
    );
  }
}
