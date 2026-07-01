import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../db/db.module';

@Injectable()
export class EventsService {
  constructor(@Inject(REDIS) private redis: Redis) {}
  publish(channel: string, payload: any) {
    return this.redis.publish(channel, JSON.stringify(payload));
  }
  setActive(sessionId: string, data: any) {
    return this.redis.set(`session:active:${sessionId}`, JSON.stringify(data), 'EX', 6 * 3600);
  }
  delActive(sessionId: string) {
    return this.redis.del(`session:active:${sessionId}`);
  }
}
