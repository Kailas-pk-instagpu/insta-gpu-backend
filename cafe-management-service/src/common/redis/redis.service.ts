import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private isConnected = false;

  onModuleInit() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.client = new Redis(redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => {
          if (times > 3) return null; // stop reconnecting if down
          return Math.min(times * 200, 1000);
        },
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        this.logger.log('Redis connected successfully.');
      });

      this.client.on('error', (err: any) => {
        this.isConnected = false;
        // Don't spam stack traces for connection refused
        if (err?.code === 'ECONNREFUSED') {
          this.logger.debug(`Redis connection refused at ${redisUrl}. Running in standalone mode.`);
        } else {
          this.logger.warn(`Redis warning: ${err.message}`);
        }
      });

      this.client.connect().catch(() => {
        this.isConnected = false;
      });
    } catch (e: any) {
      this.logger.warn(`Redis init failed: ${e.message}`);
    }
  }

  async publish(channel: string, data: any): Promise<void> {
    if (!this.isConnected || !this.client) return;
    try {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      await this.client.publish(channel, payload);
    } catch (err: any) {
      this.logger.warn(`Failed to publish to channel ${channel}: ${err.message}`);
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.isConnected || !this.client) return null;
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.isConnected || !this.client) return;
    try {
      if (ttlSeconds) {
        await this.client.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, value);
      }
    } catch {}
  }

  async del(key: string): Promise<void> {
    if (!this.isConnected || !this.client) return;
    try {
      await this.client.del(key);
    } catch {}
  }

  async onModuleDestroy() {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {}
    }
  }
}
