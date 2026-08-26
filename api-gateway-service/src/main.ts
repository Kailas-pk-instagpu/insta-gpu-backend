import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import {
  Module,
  Controller,
  Get,
  All,
  Req,
  Res,
  UnauthorizedException,
  ForbiddenException,
  Injectable,
  SetMetadata,
  CanActivate,
  ExecutionContext,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { WebSocketGateway, WebSocketServer, OnGatewayInit } from '@nestjs/websockets';
import { Server } from 'socket.io';
import axios from 'axios';
import type { Request, Response } from 'express';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { ResponseInterceptor } from './common/response.interceptor';
import { ApiResponse } from './common/response.util';

const TARGETS: Record<string, string> = {
  '/api/auth': process.env.AUTH_SERVICE_URL,
  '/api/profile': process.env.AUTH_SERVICE_URL,
  '/api/settings': process.env.AUTH_SERVICE_URL,
  '/api/owner': process.env.CAFE_MGMT_SERVICE_URL,
  '/api/branches': process.env.CAFE_MGMT_SERVICE_URL,
  '/api/settlements': process.env.CAFE_MGMT_SERVICE_URL,
  '/api/dashboard/owner': process.env.CAFE_MGMT_SERVICE_URL,
};

const PUBLIC_PATHS = ['/api/auth/login', '/api/auth/verify-2fa', '/health'];

const ROLE_PREFIXES: { prefix: string; roles: string[] }[] = [
  { prefix: '/api/owner', roles: ['cafe_owner'] },
  { prefix: '/api/dashboard/owner', roles: ['cafe_owner'] },
];

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService) { }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<Request>();
    const url = request.originalUrl;

    if (isPublic || PUBLIC_PATHS.some((p) => url.startsWith(p))) {
      return true;
    }

    const auth = request.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing token');
    }

    let payload: any;
    try {
      payload = this.jwt.verify(auth.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    for (const g of ROLE_PREFIXES) {
      if (url.startsWith(g.prefix) && !g.roles.includes(payload.role)) {
        throw new ForbiddenException('Role not permitted');
      }
    }

    request['user'] = payload;
    return true;
  }
}

function resolveTarget(url: string): { base: string; downstream: string } | null {
  // Strip /api prefix and route /api/dashboard/* by full path.
  const path = url.split('?')[0];
  const keys = Object.keys(TARGETS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (path.startsWith(k)) {
      const downstream = path.replace(/^\/api/, '');
      return { base: TARGETS[k], downstream };
    }
  }
  return null;
}

@Injectable()
class ProxyService {
  constructor(private jwt: JwtService) { }

  async handle(req: Request, res: Response) {
    return this.forward(req, res, req['user'] || null);
  }

  private async forward(req: Request, res: Response, payload: any | null) {
    const target = resolveTarget(req.originalUrl);
    if (!target) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Route not found', details: null },
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
      });
      return;
    }

    const headers: Record<string, string> = {
      'content-type': req.headers['content-type'] as string || 'application/json',
      ...(req.headers['authorization'] ? { authorization: req.headers['authorization'] as string } : {}),
    };
    if (payload) {
      headers['x-user-id'] = payload.userId;
      headers['x-user-role'] = payload.role;
      if (payload.branchId) headers['x-user-branch'] = payload.branchId;
    }

    try {
      const result = await axios({
        method: req.method as any,
        url: target.base + target.downstream,
        data: req.body,
        headers,
        validateStatus: () => true,
      });
      res.status(result.status).json(result.data);
    } catch (error: any) {
      res.status(502).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Upstream error: ' + error.message, details: null },
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
      });
    }
  }
}

@Controller()
@UseGuards(AuthGuard)
class ProxyController {
  constructor(private svc: ProxyService) { }
  @Public()
  @Get('/health') health() {
    const data = { status: 'ok', service: 'gateway', timestamp: new Date().toISOString() };
    return new ApiResponse(data, 'Gateway is healthy');
  }
  @All('/api/*') all(@Req() req: Request, @Res() res: Response) { return this.svc.handle(req, res); }
}

@WebSocketGateway({ path: '/live', cors: { origin: '*' } })
class LiveGateway implements OnGatewayInit {
  @WebSocketServer() server: Server;
  afterInit() {
    setInterval(async () => {
      try {
        // Broadcast seat snapshot for the demo branch (first branch).
        const r = await axios.get(process.env.CAFE_MGMT_SERVICE_URL + '/branches', {
          headers: { 'x-user-role': 'cafe_owner', 'x-user-id': '00000000-0000-0000-0000-000000000000' },
          validateStatus: () => true,
        });
        this.server.emit('seat-grid-update', { timestamp: new Date().toISOString(), branches: r.data });
      } catch { }
    }, 30000);
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({ secret: process.env.JWT_SECRET }),
  ],
  controllers: [ProxyController],
  providers: [ProxyService, LiveGateway, AuthGuard],
})
class AppModule { }

async function bootstrap() {
  const app = await NestFactory.create(AppModule, new ExpressAdapter());
  app.enableCors({ origin: true });
  app.useWebSocketAdapter(new IoAdapter(app));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`[gateway] listening on ${port}`);
}
bootstrap();
