import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe, Module, Global, Controller, Get } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Pool } from 'pg';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { BranchesController } from './branches.controller';
import { DashboardController } from './dashboard.controller';
import { SettlementsController } from './settlements.controller';
import { AUTH_POOL, SESSION_POOL } from './types';
import { ResponseInterceptor } from './response.interceptor';



@Global()
@Module({
  providers: [
    { provide: AUTH_POOL, useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL }) },
    { provide: SESSION_POOL, useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL }) },
  ],
  exports: [AUTH_POOL, SESSION_POOL],
})
class DbModule { }

@Controller('health')
class HealthController {
  @Get() h() { return { status: 'ok', service: 'cafe-mgmt-service', timestamp: new Date().toISOString() }; }
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DbModule],
  controllers: [BranchesController, DashboardController, SettlementsController, HealthController],
})
class AppModule { }

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  app.enableCors({ origin: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  const port = Number(process.env.PORT || 3003);
  await app.listen(port, '0.0.0.0');
  console.log(`[cafe-mgmt-service] listening on ${port}`);
}
bootstrap();
