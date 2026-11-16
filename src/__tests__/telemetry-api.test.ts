import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TelemetryService } from '../service/TelemetryService';
import { createRouter } from '../api/routes';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB_PATH = './test-api-telemetry.db';
const TEST_API_KEY = 'test-api-key-12345';

describe('Telemetry API', () => {
  let app: express.Application;

  beforeAll(() => {
    process.env.TELEMETRY_API_KEY = TEST_API_KEY;
  });

  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    TelemetryService.resetInstance();
    TelemetryService.getInstance(TEST_DB_PATH, 30);

    app = express();
    app.use(express.json());
    
    const mockService = {
      checkServices: vi.fn(),
      getResponse: vi.fn(),
      getDeviceAddress: vi.fn(),
    } as any;
    
    const mockTcpService = {
      getResponse: vi.fn(),
      getDeviceAddress: vi.fn(),
      handleDeviceConnection: vi.fn(),
      getLoginChallenge: vi.fn(),
    } as any;
    
    app.use('/api', createRouter(mockService, mockTcpService));
  });

  afterEach(() => {
    const telemetry = TelemetryService.getInstance();
    telemetry.close();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  afterAll(() => {
    delete process.env.TELEMETRY_API_KEY;
  });

  describe('Authentication', () => {
    it('should reject requests without API key', async () => {
      const response = await request(app)
        .get('/api/telemetry/system')
        .expect(401);

      expect(response.body.error).toBe('Unauthorized');
    });

    it('should reject requests with invalid API key', async () => {
      const response = await request(app)
        .get('/api/telemetry/system')
        .set('Authorization', 'Bearer wrong-key')
        .expect(401);

      expect(response.body.error).toBe('Unauthorized');
    });

    it('should accept requests with valid API key', async () => {
      await request(app)
        .get('/api/telemetry/system')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);
    });

    it('should return 503 when API key is not configured', async () => {
      delete process.env.TELEMETRY_API_KEY;
      
      const response = await request(app)
        .get('/api/telemetry/system')
        .expect(503);

      expect(response.body.error).toBe('Telemetry endpoints are disabled');
      
      process.env.TELEMETRY_API_KEY = TEST_API_KEY;
    });
  });

  describe('GET /api/telemetry/system', () => {
    it('should return system metrics', async () => {
      const telemetry = TelemetryService.getInstance();
      telemetry.recordDeviceConnection('0xabc123', 'UDP');
      telemetry.recordApiCall('0xabc123', 'getValue', true, 50);

      const response = await request(app)
        .get('/api/telemetry/system')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(response.body).toHaveProperty('totalDevices');
      expect(response.body).toHaveProperty('totalApiCalls');
      expect(response.body).toHaveProperty('totalFailedCalls');
      expect(response.body).toHaveProperty('activeDevices');
      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('startTime');
      expect(response.body.totalDevices).toBe(1);
      expect(response.body.totalApiCalls).toBe(1);
    });

    it('should support time-windowed queries', async () => {
      const telemetry = TelemetryService.getInstance();
      telemetry.recordApiCall('0xabc123', 'getValue', true, 50);

      await new Promise(resolve => setTimeout(resolve, 100));
      const since = new Date(Date.now() - 50).toISOString();

      const response = await request(app)
        .get(`/api/telemetry/system?since=${since}`)
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(response.body.totalApiCalls).toBe(0);
    });

    it('should reject invalid since timestamp', async () => {
      const response = await request(app)
        .get('/api/telemetry/system?since=invalid')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(400);

      expect(response.body.error).toBe('Invalid since timestamp');
    });
  });

  describe('GET /api/telemetry/devices', () => {
    it('should return all device metrics', async () => {
      const telemetry = TelemetryService.getInstance();
      telemetry.recordDeviceConnection('0xabc123', 'UDP');
      telemetry.recordDeviceConnection('0xdef456', 'TCP');

      const response = await request(app)
        .get('/api/telemetry/devices')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(2);
    });

    it('should support time-windowed queries', async () => {
      const telemetry = TelemetryService.getInstance();
      telemetry.recordDeviceConnection('0xabc123', 'UDP');

      await new Promise(resolve => setTimeout(resolve, 100));
      const since = new Date().toISOString();

      const response = await request(app)
        .get(`/api/telemetry/devices?since=${since}`)
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(response.body).toHaveLength(0);
    });
  });

  describe('GET /api/telemetry/devices/:address', () => {
    it('should return specific device metrics', async () => {
      const telemetry = TelemetryService.getInstance();
      const device = '0xabc123';
      telemetry.recordDeviceConnection(device, 'UDP', '192.168.1.100');
      telemetry.recordApiCall(device, 'getValue', true, 50);

      const response = await request(app)
        .get(`/api/telemetry/devices/${device}`)
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(response.body.address).toBe(device);
      expect(response.body.connectionCount).toBe(1);
      expect(response.body.apiCalls).toBe(1);
      expect(response.body).toHaveProperty('uptimePercent');
      expect(response.body).toHaveProperty('disconnectsByReason');
    });

    it('should return 404 for non-existent device', async () => {
      const response = await request(app)
        .get('/api/telemetry/devices/0xnonexistent')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(404);

      expect(response.body.error).toBe('Device not found');
    });

    it('should normalize device addresses', async () => {
      const telemetry = TelemetryService.getInstance();
      telemetry.recordDeviceConnection('0xABC123', 'UDP');

      const response = await request(app)
        .get('/api/telemetry/devices/0xabc123')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(response.body.address).toBe('0xabc123');
    });
  });

  describe('GET /api/telemetry/methods', () => {
    it('should return top methods', async () => {
      const telemetry = TelemetryService.getInstance();
      telemetry.recordApiCall('0xabc123', 'getValue', true, 50);
      telemetry.recordApiCall('0xabc123', 'getValue', true, 60);
      telemetry.recordApiCall('0xabc123', 'setValue', true, 70);

      const response = await request(app)
        .get('/api/telemetry/methods')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(2);
      expect(response.body[0].method).toBe('getValue');
      expect(response.body[0].count).toBe(2);
    });

    it('should respect limit parameter', async () => {
      const telemetry = TelemetryService.getInstance();
      for (let i = 0; i < 20; i++) {
        telemetry.recordApiCall('0xabc123', `method${i}`, true, 50);
      }

      const response = await request(app)
        .get('/api/telemetry/methods?limit=5')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(response.body).toHaveLength(5);
    });
  });

  describe('GET /api/telemetry/events', () => {
    it('should return paginated events', async () => {
      const telemetry = TelemetryService.getInstance();
      const device = '0xabc123';
      telemetry.recordDeviceConnection(device, 'UDP');
      telemetry.recordApiCall(device, 'getValue', true, 50);
      telemetry.recordDeviceDisconnect(device, 'client_close');

      const response = await request(app)
        .get('/api/telemetry/events')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(response.body).toHaveProperty('events');
      expect(response.body).toHaveProperty('total');
      expect(Array.isArray(response.body.events)).toBe(true);
      expect(response.body.events.length).toBeGreaterThan(0);
      expect(response.body.total).toBe(3);
    });

    it('should filter events by device', async () => {
      const telemetry = TelemetryService.getInstance();
      telemetry.recordDeviceConnection('0xabc123', 'UDP');
      telemetry.recordDeviceConnection('0xdef456', 'TCP');

      const response = await request(app)
        .get('/api/telemetry/events?device=0xabc123')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(response.body.total).toBe(1);
      expect(response.body.events[0].device).toBe('0xabc123');
    });

    it('should support pagination', async () => {
      const telemetry = TelemetryService.getInstance();
      for (let i = 0; i < 10; i++) {
        telemetry.recordApiCall('0xabc123', `method${i}`, true, 50);
      }

      const page1 = await request(app)
        .get('/api/telemetry/events?limit=5&offset=0')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      const page2 = await request(app)
        .get('/api/telemetry/events?limit=5&offset=5')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(page1.body.events).toHaveLength(5);
      expect(page2.body.events).toHaveLength(5);
      expect(page1.body.total).toBe(10);
    });

    it('should reject invalid limit', async () => {
      const response = await request(app)
        .get('/api/telemetry/events?limit=2000')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(400);

      expect(response.body.error).toBe('Limit must be between 1 and 1000');
    });

    it('should include event details', async () => {
      const telemetry = TelemetryService.getInstance();
      const device = '0xabc123';
      telemetry.recordDeviceConnection(device, 'UDP', '192.168.1.100');
      telemetry.recordApiCall(device, 'getValue', true, 50);
      telemetry.recordDeviceDisconnect(device, 'timeout');

      const response = await request(app)
        .get('/api/telemetry/events')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      const events = response.body.events;
      const connectEvent = events.find((e: any) => e.eventType === 'connect');
      const apiEvent = events.find((e: any) => e.eventType === 'api_call');
      const disconnectEvent = events.find((e: any) => e.eventType === 'disconnect');

      expect(connectEvent).toBeDefined();
      expect(connectEvent.protocol).toBe('UDP');
      expect(connectEvent.ipAddress).toBe('192.168.1.100');

      expect(apiEvent).toBeDefined();
      expect(apiEvent.apiMethod).toBe('getValue');
      expect(apiEvent.apiSuccess).toBe(true);
      expect(apiEvent.apiResponseTime).toBe(50);

      expect(disconnectEvent).toBeDefined();
      expect(disconnectEvent.disconnectReason).toBe('timeout');
    });
  });
});
