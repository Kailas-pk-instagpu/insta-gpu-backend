import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class IntegrationService {
  private readonly logger = new Logger(IntegrationService.name);

  async processPayment(amount: number, token: string): Promise<any> {
    this.logger.log(`Processing payment of ${amount} with token: ${token}`);
    
    // Simulate a third-party API request using HTTPBin
    const payload = {
      action: 'charge',
      amount,
      token,
      timestamp: new Date().toISOString(),
      provider: 'stripe_mock',
    };

    try {
      const response = await axios.post('https://httpbin.org/post', payload);
      const returnedData = response.data.json;
      
      return {
        transactionId: `txn_${Math.random().toString(36).substr(2, 9)}`,
        status: 'succeeded',
        amount: returnedData.amount,
        provider: returnedData.provider,
        processedAt: returnedData.timestamp,
      };
    } catch (error) {
      this.logger.error('Failed to connect to third-party payment provider:', error.message);
      throw new Error(`Payment processing gateway error: ${error.message}`);
    }
  }

  async sendNotification(recipient: string, message: string, channel: string): Promise<any> {
    this.logger.log(`Sending notification to ${recipient} via ${channel}: "${message}"`);
    
    // Simulate a third-party SMS/email/webhook API request using HTTPBin
    const payload = {
      action: 'send_notification',
      recipient,
      message,
      channel,
      timestamp: new Date().toISOString(),
      provider: 'notification_gateway_mock',
    };

    try {
      const response = await axios.post('https://httpbin.org/post', payload);
      const returnedData = response.data.json;

      return {
        notificationId: `notif_${Math.random().toString(36).substr(2, 9)}`,
        status: 'sent',
        channel: returnedData.channel,
        recipient: returnedData.recipient,
        sentAt: returnedData.timestamp,
      };
    } catch (error) {
      this.logger.error('Failed to send notification via third-party provider:', error.message);
      throw new Error(`Notification dispatch gateway error: ${error.message}`);
    }
  }

  async getGpuStatus(gpuId: string): Promise<any> {
    this.logger.log(`Fetching third-party GPU telemetry for device ID: ${gpuId}`);

    // Simulate query to third-party telemetry provider
    try {
      const response = await axios.get('https://httpbin.org/get', {
        params: {
          device_id: gpuId,
          metrics: 'hashrate,temp,power',
        },
      });

      const returnedParams = response.data.args;

      // Return mock stats layered with telemetry provider information
      return {
        deviceId: returnedParams.device_id,
        hashrateMh: parseFloat((70 + Math.random() * 20).toFixed(2)),
        temperatureC: Math.floor(65 + Math.random() * 15),
        powerDrawW: Math.floor(180 + Math.random() * 50),
        status: 'online',
        provider: 'telemetry_api_mock',
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Failed to fetch telemetry from third-party provider:', error.message);
      throw new Error(`Telemetry gateway connection error: ${error.message}`);
    }
  }
}
