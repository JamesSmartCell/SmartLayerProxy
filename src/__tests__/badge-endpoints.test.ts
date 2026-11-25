import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRouter } from '../api/routes';
import { ASyncService } from '../service/ASyncService';
import { ASyncTCPService } from '../service/ASyncTCPService';
import { TelemetryService } from '../service/TelemetryService';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB_PATH = './test-badge-endpoints.db';

describe('Badge Endpoints', () => {
  let app: express.Application;
  let mockService: any;
  let mockTcpService: any;

  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    TelemetryService.resetInstance();
    TelemetryService.getInstance(TEST_DB_PATH, 30);

    mockService = {
      checkServices: vi.fn(),
      getResponse: vi.fn(),
      getDeviceAddress: vi.fn(),
      addressToClient: new Map(),
    };

    mockTcpService = {
      getResponse: vi.fn(),
      getDeviceAddress: vi.fn(),
      handleDeviceConnection: vi.fn(),
      getLoginChallenge: vi.fn(),
      getConnectedDevices: vi.fn().mockReturnValue([]),
    };

    app = express();
    app.use(express.json());
    app.use('/api', createRouter(mockService, mockTcpService));
  });

  afterEach(() => {
    const telemetry = TelemetryService.getInstance();
    telemetry.close();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  describe('GET /api/badge/version', () => {
    it('should return shields.io JSON schema', async () => {
      const response = await request(app)
        .get('/api/badge/version')
        .expect(200);

      expect(response.body).toMatchObject({
        schemaVersion: 1,
        label: 'version',
        message: expect.any(String),
        color: expect.any(String),
      });
    });

    it('should include package version in message', async () => {
      const response = await request(app)
        .get('/api/badge/version')
        .expect(200);

      const pkg = require('../../package.json');
      expect(response.body.message).toMatch(new RegExp(`^${pkg.version.replace(/\./g, '\\.')}`));
    });

    it('should set Cache-Control header', async () => {
      const response = await request(app)
        .get('/api/badge/version')
        .expect(200);

      expect(response.headers['cache-control']).toContain('max-age=60');
    });

    it('should set CORS headers', async () => {
      const response = await request(app)
        .get('/api/badge/version')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBe('*');
    });

    it('should not expose sensitive data', async () => {
      const response = await request(app)
        .get('/api/badge/version')
        .expect(200);

      const bodyStr = JSON.stringify(response.body);
      expect(bodyStr).not.toMatch(/password|secret|key|token/i);
    });

    it('should return cached version consistently across multiple requests', async () => {
      const response1 = await request(app)
        .get('/api/badge/version')
        .expect(200);

      const response2 = await request(app)
        .get('/api/badge/version')
        .expect(200);

      const response3 = await request(app)
        .get('/api/badge/version')
        .expect(200);

      expect(response1.body.message).toBe(response2.body.message);
      expect(response2.body.message).toBe(response3.body.message);
    });

    it('should not spawn processes during request handling', async () => {
      const childProcess = require('child_process');
      const execSyncSpy = vi.spyOn(childProcess, 'execSync');

      await request(app)
        .get('/api/badge/version')
        .expect(200);

      await request(app)
        .get('/api/badge/version')
        .expect(200);

      expect(execSyncSpy).not.toHaveBeenCalled();
      
      execSyncSpy.mockRestore();
    });
  });

  describe('GET /api/badge/devices', () => {
    it('should return shields.io JSON schema', async () => {
      const response = await request(app)
        .get('/api/badge/devices')
        .expect(200);

      expect(response.body).toMatchObject({
        schemaVersion: 1,
        label: 'connected devices',
        message: expect.any(String),
        color: expect.any(String),
      });
    });

    it('should return 0 when no devices are connected', async () => {
      mockTcpService.getConnectedDevices.mockReturnValue([]);

      const response = await request(app)
        .get('/api/badge/devices')
        .expect(200);

      expect(response.body.message).toBe('0');
      expect(response.body.color).toBe('lightgrey');
    });

    it('should count TCP connected devices', async () => {
      mockTcpService.getConnectedDevices.mockReturnValue([
        { address: '0xabc123', firmwareVersion: '1.0.0' },
        { address: '0xdef456', firmwareVersion: '1.0.0' },
      ]);

      const response = await request(app)
        .get('/api/badge/devices')
        .expect(200);

      expect(response.body.message).toBe('2');
      expect(response.body.color).toBe('green');
    });

    it('should deduplicate devices connected via both TCP and UDP', async () => {
      mockTcpService.getConnectedDevices.mockReturnValue([
        { address: '0xabc123', firmwareVersion: '1.0.0' },
      ]);

      const mockUdpInstance = {
        validated: true,
        getEthAddress: () => '0xabc123',
      };
      mockService.addressToClient.set('0xabc123', [mockUdpInstance]);

      const response = await request(app)
        .get('/api/badge/devices')
        .expect(200);

      expect(response.body.message).toBe('1');
    });

    it('should count unique devices across TCP and UDP', async () => {
      mockTcpService.getConnectedDevices.mockReturnValue([
        { address: '0xabc123', firmwareVersion: '1.0.0' },
        { address: '0xdef456', firmwareVersion: '1.0.0' },
      ]);

      const mockUdpInstance = {
        validated: true,
        getEthAddress: () => '0x789ghi',
      };
      mockService.addressToClient.set('0x789ghi', [mockUdpInstance]);

      const response = await request(app)
        .get('/api/badge/devices')
        .expect(200);

      expect(response.body.message).toBe('3');
    });

    it('should not count unvalidated UDP devices', async () => {
      mockTcpService.getConnectedDevices.mockReturnValue([]);

      const mockUdpInstance = {
        validated: false,
        getEthAddress: () => '0xabc123',
      };
      mockService.addressToClient.set('0xabc123', [mockUdpInstance]);

      const response = await request(app)
        .get('/api/badge/devices')
        .expect(200);

      expect(response.body.message).toBe('0');
    });

    it('should set Cache-Control header', async () => {
      const response = await request(app)
        .get('/api/badge/devices')
        .expect(200);

      expect(response.headers['cache-control']).toContain('max-age=60');
    });

    it('should set CORS headers', async () => {
      const response = await request(app)
        .get('/api/badge/devices')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBe('*');
    });

    it('should not expose device addresses or IPs', async () => {
      mockTcpService.getConnectedDevices.mockReturnValue([
        { address: '0xabc123def456', firmwareVersion: '1.0.0' },
      ]);

      const response = await request(app)
        .get('/api/badge/devices')
        .expect(200);

      const bodyStr = JSON.stringify(response.body);
      expect(bodyStr).not.toContain('0xabc123');
      expect(bodyStr).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    });

    it('should not expose sensitive metadata', async () => {
      mockTcpService.getConnectedDevices.mockReturnValue([
        { address: '0xabc123', firmwareVersion: '1.0.0', project: 'test-project' },
      ]);

      const response = await request(app)
        .get('/api/badge/devices')
        .expect(200);

      expect(response.body).not.toHaveProperty('devices');
      expect(response.body).not.toHaveProperty('addresses');
      const bodyStr = JSON.stringify(response.body);
      expect(bodyStr).not.toContain('test-project');
    });
  });
});
