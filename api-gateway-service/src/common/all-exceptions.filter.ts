import { ExceptionFilter, Catch, ArgumentsHost, HttpException } from '@nestjs/common';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const errRes: any = exception instanceof HttpException ? exception.getResponse() : {};

    const error = {
      code: errRes.code || this.mapStatusToCode(status),
      message: errRes.message || exception.message || 'Internal Error',
      details: errRes.details || (Array.isArray(errRes.message) ? errRes.message : null),
    };
    if (Array.isArray(errRes.message)) error.message = 'Validation failed';

    response.status(status).send({
      success: false,
      error,
      timestamp: new Date().toISOString(),
      path: request.originalUrl || request.url,
    });
  }

  private mapStatusToCode(status: number): string {
    const codes = { 400:'VALIDATION_ERROR', 401:'UNAUTHORIZED', 403:'FORBIDDEN', 404:'NOT_FOUND', 409:'CONFLICT', 429:'RATE_LIMITED', 503:'SERVICE_UNAVAILABLE' };
    return codes[status as keyof typeof codes] || 'INTERNAL_ERROR';
  }
}
