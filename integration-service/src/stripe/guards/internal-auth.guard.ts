import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Protects /internal/* routes with a shared service token.
 * Accepts `X-Internal-Token` or `Authorization: Bearer <token>`.
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.INTERNAL_API_TOKEN;
    if (!expected) {
      throw new UnauthorizedException('INTERNAL_API_TOKEN is not configured');
    }

    const request = context.switchToHttp().getRequest();
    const headers = request.headers || {};
    const bearer = headers.authorization || headers.Authorization;
    const headerToken =
      headers['x-internal-token'] ||
      headers['X-Internal-Token'] ||
      (typeof bearer === 'string' && /^Bearer\s+/i.test(bearer)
        ? bearer.replace(/^Bearer\s+/i, '').trim()
        : undefined);

    if (!headerToken || headerToken !== expected) {
      throw new UnauthorizedException('Invalid or missing internal token');
    }
    return true;
  }
}
