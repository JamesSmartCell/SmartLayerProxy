import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TelemetryService } from '../service/TelemetryService';
import { createRouter } from '../api/routes';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB_PATH = './test-dedup-telemetry.db';

describe('Telemetry Deduplication', () => {
  let app: express.Application;
  let mockService: any;
  let mockTcpService: any;

  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    TelemetryService.resetInstance();
    TelemetryService.getInstance(TEST_DB_PATH, 30);

    app = express();
    app.use(express.json());
    
    // Mock UDP service
    mockService = {
      checkServices: vi.fn(),
      getResponse: vi.fn(),
      getDeviceAddress: vi.fn(),
    };
    
    // Mock TCP service
    mockTcpService = {
      getResponse: vi.fn(),
      getDeviceAddress: vi.fn(),
      handleDeviceConnection: vi.fn(),
      getLoginChallenge: vi.fn(),
    };
    
    app.use('/api', createRouter(mockService, mockTcpService));
  });

  afterEach(() => {
    const telemetry = TelemetryService.getInstance();
    telemetry.close();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  describe('Single Event Recording', () => {
    it('should record exactly one event when TCP succeeds', async () => {
      const device = '0xabc123';
      const method = 'getValue';
      
      // UDP returns "No device found", TCP succeeds
      mockService.getResponse.mockResolvedValue('No device found');
      mockTcpService.getResponse.mockResolvedValue('42');
      
      await request(app)
        .get(`/api/${device}/${method}`)
        .expect(201);
      
      const telemetry = TelemetryService.getInstance();
      const events = telemetry.getEvents({ device, limit: 100, offset: 0 });
      
      // Should have exactly one api_call event
      const apiCallEvents = events.events.filter(e => e.eventType === 'api_call');
      expect(apiCallEvents).toHaveLength(1);
      
      // Should be a success
      expect(apiCallEvents[0].apiMethod).toBe(method);
      expect(apiCallEvents[0].apiSuccess).toBe(true);
      expect(apiCallEvents[0].apiResponseTime).toBeGreaterThanOrEqual(0);
    });

    it('should record exactly one event when UDP succeeds', async () => {
      const device = '0xdef456';
      const method = 'setValue';
      
      // UDP succeeds, TCP returns "No device found"
      mockService.getResponse.mockResolvedValue('OK');
      mockTcpService.getResponse.mockResolvedValue('No device found');
      
      await request(app)
        .get(`/api/${device}/${method}`)
        .expect(201);
      
      const telemetry = TelemetryService.getInstance();
      const events = telemetry.getEvents({ device, limit: 100, offset: 0 });
      
      // Should have exactly one api_call event
      const apiCallEvents = events.events.filter(e => e.eventType === 'api_call');
      expect(apiCallEvents).toHaveLength(1);
      
      // Should be a success
      expect(apiCallEvents[0].apiMethod).toBe(method);
      expect(apiCallEvents[0].apiSuccess).toBe(true);
      expect(apiCallEvents[0].apiResponseTime).toBeGreaterThanOrEqual(0);
    });

    it('should record exactly one failure event when device not found', async () => {
      const device = '0xffffff';
      const method = 'test';
      
      // Both services return "No device found"
      mockService.getResponse.mockResolvedValue('No device found');
      mockTcpService.getResponse.mockResolvedValue('No device found');
      
      await request(app)
        .get(`/api/${device}/${method}`)
        .expect(201);
      
      const telemetry = TelemetryService.getInstance();
      const events = telemetry.getEvents({ device, limit: 100, offset: 0 });
      
      // Should have exactly one api_call event
      const apiCallEvents = events.events.filter(e => e.eventType === 'api_call');
      expect(apiCallEvents).toHaveLength(1);
      
      // Should be a failure
      expect(apiCallEvents[0].apiMethod).toBe(method);
      expect(apiCallEvents[0].apiSuccess).toBe(false);
      expect(apiCallEvents[0].apiResponseTime).toBeGreaterThanOrEqual(0);
    });

    it('should record exactly one failure event on timeout', async () => {
      const device = '0x123456';
      const method = 'slowMethod';
      
      // Both services timeout
      mockService.getResponse.mockResolvedValue('Timed out');
      mockTcpService.getResponse.mockResolvedValue('Timed out');
      
      await request(app)
        .get(`/api/${device}/${method}`)
        .expect(201);
      
      const telemetry = TelemetryService.getInstance();
      const events = telemetry.getEvents({ device, limit: 100, offset: 0 });
      
      // Should have exactly one api_call event
      const apiCallEvents = events.events.filter(e => e.eventType === 'api_call');
      expect(apiCallEvents).toHaveLength(1);
      
      // Should be a failure
      expect(apiCallEvents[0].apiMethod).toBe(method);
      expect(apiCallEvents[0].apiSuccess).toBe(false);
      expect(apiCallEvents[0].apiResponseTime).toBeGreaterThanOrEqual(0);
    });

    it('should record exactly one failure event on API send error', async () => {
      const device = '0x789abc';
      const method = 'failMethod';
      
      // UDP has send error, TCP not found
      mockService.getResponse.mockResolvedValue('API send error');
      mockTcpService.getResponse.mockResolvedValue('No device found');
      
      await request(app)
        .get(`/api/${device}/${method}`)
        .expect(201);
      
      const telemetry = TelemetryService.getInstance();
      const events = telemetry.getEvents({ device, limit: 100, offset: 0 });
      
      // Should have exactly one api_call event
      const apiCallEvents = events.events.filter(e => e.eventType === 'api_call');
      expect(apiCallEvents).toHaveLength(1);
      
      // Should be a failure
      expect(apiCallEvents[0].apiMethod).toBe(method);
      expect(apiCallEvents[0].apiSuccess).toBe(false);
    });
  });

  describe('Multiple Calls', () => {
    it('should record exactly one event per call for multiple calls', async () => {
      const device = '0xmulti';
      const methods = ['method1', 'method2', 'method3'];
      
      mockService.getResponse.mockResolvedValue('No device found');
      mockTcpService.getResponse.mockResolvedValue('response');
      
      for (const method of methods) {
        await request(app)
          .get(`/api/${device}/${method}`)
          .expect(201);
      }
      
      const telemetry = TelemetryService.getInstance();
      const events = telemetry.getEvents({ device, limit: 100, offset: 0 });
      
      // Should have exactly 3 api_call events (one per call)
      const apiCallEvents = events.events.filter(e => e.eventType === 'api_call');
      expect(apiCallEvents).toHaveLength(3);
      
      // All should be successes
      apiCallEvents.forEach(event => {
        expect(event.apiSuccess).toBe(true);
      });
    });
  });

  describe('Response Time Measurement', () => {
    it('should record non-zero response time for successful calls', async () => {
      const device = '0xtiming';
      const method = 'timedMethod';
      
      // Simulate some delay
      mockService.getResponse.mockImplementation(() => 
        new Promise(resolve => setTimeout(() => resolve('No device found'), 10))
      );
      mockTcpService.getResponse.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve('success'), 20))
      );
      
      await request(app)
        .get(`/api/${device}/${method}`)
        .expect(201);
      
      const telemetry = TelemetryService.getInstance();
      const events = telemetry.getEvents({ device, limit: 100, offset: 0 });
      
      const apiCallEvents = events.events.filter(e => e.eventType === 'api_call');
      expect(apiCallEvents).toHaveLength(1);
      
      // Response time should reflect the actual call duration
      expect(apiCallEvents[0].apiResponseTime).toBeGreaterThanOrEqual(20);
    });

    it('should record response time even for failures', async () => {
      const device = '0xfailtime';
      const method = 'failMethod';
      
      mockService.getResponse.mockImplementation(() => 
        new Promise(resolve => setTimeout(() => resolve('No device found'), 15))
      );
      mockTcpService.getResponse.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve('No device found'), 15))
      );
      
      await request(app)
        .get(`/api/${device}/${method}`)
        .expect(201);
      
      const telemetry = TelemetryService.getInstance();
      const events = telemetry.getEvents({ device, limit: 100, offset: 0 });
      
      const apiCallEvents = events.events.filter(e => e.eventType === 'api_call');
      expect(apiCallEvents).toHaveLength(1);
      
      expect(apiCallEvents[0].apiSuccess).toBe(false);
      expect(apiCallEvents[0].apiResponseTime).toBeGreaterThanOrEqual(15);
    });
  });
});
