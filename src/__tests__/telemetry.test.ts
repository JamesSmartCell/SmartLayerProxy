import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TelemetryService } from '../service/TelemetryService';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB_PATH = './test-telemetry.db';

describe('TelemetryService', () => {
  let telemetry: TelemetryService;

  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    TelemetryService.resetInstance();
    telemetry = TelemetryService.getInstance(TEST_DB_PATH, 30);
  });

  afterEach(() => {
    telemetry.close();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  describe('Device Connection Tracking', () => {
    it('should record device connections', () => {
      const device = '0xabc123';
      telemetry.recordDeviceConnection(device, 'UDP', '192.168.1.100');

      const metrics = telemetry.getDeviceMetrics(device);
      expect(metrics).toBeDefined();
      expect(metrics?.address).toBe(device);
      expect(metrics?.connectionCount).toBe(1);
      expect(metrics?.protocol).toBe('UDP');
      expect(metrics?.ipAddress).toBe('192.168.1.100');
    });

    it('should track multiple connections', () => {
      const device = '0xabc123';
      telemetry.recordDeviceConnection(device, 'UDP', '192.168.1.100');
      telemetry.recordDeviceConnection(device, 'UDP', '192.168.1.100');
      telemetry.recordDeviceConnection(device, 'TCP', '192.168.1.100');

      const metrics = telemetry.getDeviceMetrics(device);
      expect(metrics?.connectionCount).toBe(3);
      expect(metrics?.protocol).toBe('BOTH');
    });

    it('should normalize device addresses to lowercase', () => {
      telemetry.recordDeviceConnection('0xABC123', 'UDP');
      
      const metrics = telemetry.getDeviceMetrics('0xabc123');
      expect(metrics).toBeDefined();
      expect(metrics?.address).toBe('0xabc123');
    });
  });

  describe('Device Disconnection Tracking', () => {
    it('should record disconnections with reason', () => {
      const device = '0xabc123';
      telemetry.recordDeviceConnection(device, 'TCP');
      telemetry.recordDeviceDisconnect(device, 'timeout');

      const metrics = telemetry.getDeviceMetrics(device);
      expect(metrics?.disconnectCount).toBe(1);
      expect(metrics?.disconnectsByReason.timeout).toBe(1);
    });

    it('should track multiple disconnect reasons', () => {
      const device = '0xabc123';
      telemetry.recordDeviceConnection(device, 'TCP');
      telemetry.recordDeviceDisconnect(device, 'timeout');
      telemetry.recordDeviceConnection(device, 'TCP');
      telemetry.recordDeviceDisconnect(device, 'socket_error');
      telemetry.recordDeviceConnection(device, 'TCP');
      telemetry.recordDeviceDisconnect(device, 'auth_failure');

      const metrics = telemetry.getDeviceMetrics(device);
      expect(metrics?.disconnectCount).toBe(3);
      expect(metrics?.disconnectsByReason.timeout).toBe(1);
      expect(metrics?.disconnectsByReason.socket_error).toBe(1);
      expect(metrics?.disconnectsByReason.auth_failure).toBe(1);
    });
  });

  describe('API Call Tracking', () => {
    it('should record successful API calls', () => {
      const device = '0xabc123';
      telemetry.recordApiCall(device, 'getValue', true, 50);
      telemetry.recordApiCall(device, 'getValue', true, 100);

      const metrics = telemetry.getDeviceMetrics(device);
      expect(metrics?.apiCalls).toBe(2);
      expect(metrics?.failedCalls).toBe(0);
      expect(metrics?.avgResponseTime).toBe(75);
      expect(metrics?.methodUsage['getValue']).toBe(2);
    });

    it('should track failed API calls', () => {
      const device = '0xabc123';
      telemetry.recordApiCall(device, 'getValue', true, 50);
      telemetry.recordApiCall(device, 'getValue', false, 1000);

      const metrics = telemetry.getDeviceMetrics(device);
      expect(metrics?.apiCalls).toBe(2);
      expect(metrics?.failedCalls).toBe(1);
    });

    it('should track method usage', () => {
      const device = '0xabc123';
      telemetry.recordApiCall(device, 'getValue', true, 50);
      telemetry.recordApiCall(device, 'setValue', true, 60);
      telemetry.recordApiCall(device, 'getValue', true, 70);

      const metrics = telemetry.getDeviceMetrics(device);
      expect(metrics?.methodUsage['getValue']).toBe(2);
      expect(metrics?.methodUsage['setValue']).toBe(1);
    });
  });

  describe('Session Duration and Uptime', () => {
    it('should calculate session duration', async () => {
      const device = '0xabc123';
      telemetry.recordDeviceConnection(device, 'TCP');
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      telemetry.recordDeviceDisconnect(device, 'client_close');

      const metrics = telemetry.getDeviceMetrics(device);
      expect(metrics?.totalSessionDuration).toBeGreaterThan(90);
      expect(metrics?.uptimePercent).toBeGreaterThan(0);
    });

    it('should calculate reconnect times', async () => {
      const device = '0xabc123';
      telemetry.recordDeviceConnection(device, 'TCP');
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      telemetry.recordDeviceDisconnect(device, 'timeout');
      
      await new Promise(resolve => setTimeout(resolve, 50));
      
      telemetry.recordDeviceConnection(device, 'TCP');

      const metrics = telemetry.getDeviceMetrics(device);
      expect(metrics?.medianReconnectTime).toBeDefined();
      if (metrics?.medianReconnectTime !== undefined) {
        expect(metrics.medianReconnectTime).toBeGreaterThan(0);
      }
    });
  });

  describe('System Metrics', () => {
    it('should provide system-wide metrics', () => {
      telemetry.recordDeviceConnection('0xabc123', 'UDP');
      telemetry.recordDeviceConnection('0xdef456', 'TCP');
      telemetry.recordApiCall('0xabc123', 'getValue', true, 50);
      telemetry.recordApiCall('0xabc123', 'getValue', false, 100);

      const metrics = telemetry.getSystemMetrics();
      expect(metrics.totalDevices).toBe(2);
      expect(metrics.totalApiCalls).toBe(2);
      expect(metrics.totalFailedCalls).toBe(1);
      expect(metrics.uptime).toBeGreaterThan(0);
    });
  });

  describe('Time-windowed Queries', () => {
    it('should filter metrics by time window', async () => {
      const device = '0xabc123';
      telemetry.recordDeviceConnection(device, 'UDP');
      telemetry.recordApiCall(device, 'getValue', true, 50);
      
      await new Promise(resolve => setTimeout(resolve, 100));
      const windowStart = Date.now();
      await new Promise(resolve => setTimeout(resolve, 100));
      
      telemetry.recordApiCall(device, 'getValue', true, 60);

      const allMetrics = telemetry.getDeviceMetrics(device);
      expect(allMetrics?.apiCalls).toBe(2);

      const windowedMetrics = telemetry.getDeviceMetrics(device, windowStart);
      expect(windowedMetrics?.apiCalls).toBe(1);
    });

    it('should filter system metrics by time window', async () => {
      telemetry.recordApiCall('0xabc123', 'getValue', true, 50);
      
      await new Promise(resolve => setTimeout(resolve, 100));
      const windowStart = Date.now();
      await new Promise(resolve => setTimeout(resolve, 100));
      
      telemetry.recordApiCall('0xabc123', 'getValue', true, 60);

      const allMetrics = telemetry.getSystemMetrics();
      expect(allMetrics.totalApiCalls).toBe(2);

      const windowedMetrics = telemetry.getSystemMetrics(windowStart);
      expect(windowedMetrics.totalApiCalls).toBe(1);
    });
  });

  describe('Top Methods', () => {
    it('should return top methods by usage', () => {
      telemetry.recordApiCall('0xabc123', 'getValue', true, 50);
      telemetry.recordApiCall('0xabc123', 'getValue', true, 60);
      telemetry.recordApiCall('0xabc123', 'setValue', true, 70);
      telemetry.recordApiCall('0xdef456', 'getValue', true, 80);

      const topMethods = telemetry.getTopMethods(10);
      expect(topMethods).toHaveLength(2);
      expect(topMethods[0].method).toBe('getValue');
      expect(topMethods[0].count).toBe(3);
      expect(topMethods[1].method).toBe('setValue');
      expect(topMethods[1].count).toBe(1);
    });

    it('should limit number of results', () => {
      for (let i = 0; i < 20; i++) {
        telemetry.recordApiCall('0xabc123', `method${i}`, true, 50);
      }

      const topMethods = telemetry.getTopMethods(5);
      expect(topMethods).toHaveLength(5);
    });
  });

  describe('Event Queries', () => {
    it('should return paginated events', () => {
      const device = '0xabc123';
      telemetry.recordDeviceConnection(device, 'UDP');
      telemetry.recordApiCall(device, 'getValue', true, 50);
      telemetry.recordApiCall(device, 'setValue', true, 60);
      telemetry.recordDeviceDisconnect(device, 'client_close');

      const result = telemetry.getEvents({ limit: 10, offset: 0 });
      expect(result.events).toHaveLength(4);
      expect(result.total).toBe(4);
    });

    it('should filter events by device', () => {
      telemetry.recordDeviceConnection('0xabc123', 'UDP');
      telemetry.recordDeviceConnection('0xdef456', 'TCP');
      telemetry.recordApiCall('0xabc123', 'getValue', true, 50);

      const result = telemetry.getEvents({ device: '0xabc123' });
      expect(result.events).toHaveLength(2);
      expect(result.events.every(e => e.device === '0xabc123')).toBe(true);
    });

    it('should support pagination', () => {
      const device = '0xabc123';
      for (let i = 0; i < 10; i++) {
        telemetry.recordApiCall(device, `method${i}`, true, 50);
      }

      const page1 = telemetry.getEvents({ limit: 5, offset: 0 });
      const page2 = telemetry.getEvents({ limit: 5, offset: 5 });

      expect(page1.events).toHaveLength(5);
      expect(page2.events).toHaveLength(5);
      expect(page1.total).toBe(10);
      expect(page2.total).toBe(10);
    });
  });

  describe('Persistence', () => {
    it('should persist events across restarts', () => {
      const device = '0xabc123';
      telemetry.recordDeviceConnection(device, 'UDP');
      telemetry.recordApiCall(device, 'getValue', true, 50);
      telemetry.close();

      TelemetryService.resetInstance();
      const newTelemetry = TelemetryService.getInstance(TEST_DB_PATH, 30);

      const metrics = newTelemetry.getDeviceMetrics(device);
      expect(metrics).toBeDefined();
      expect(metrics?.connectionCount).toBe(1);
      expect(metrics?.apiCalls).toBe(1);

      newTelemetry.close();
    });
  });
});
