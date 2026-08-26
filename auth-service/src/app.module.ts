import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { DbModule } from './db/db.module';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { ProfileController } from './profile/profile.controller';
import { ProfileService } from './profile/profile.service';
import { SettingsController } from './settings/settings.controller';
import { HealthController } from './common/utils/health.controller';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './common/utils/auth.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '12h' },
    }),
    DbModule,
  ],
  controllers: [AuthController, ProfileController, SettingsController, HealthController],
  providers: [
    AuthService,
    ProfileService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class AppModule { }
