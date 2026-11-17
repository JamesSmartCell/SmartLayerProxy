import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TelemetryService } from '../service/TelemetryService';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB_PATH = './test-silent-devices.db';

describe('Silent Device Detection', () => {
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

  describe('Device Registry', () => {
    it('should track first and last seen times', () => {
      const device = '0xabc123';
      const now = Date.now();
      
      telemetry.recordDeviceConnection(device, 'TCP', '192.168.1.1');
      
      const registry = telemetry['db'].prepare('SELECT * FROM device_registry WHERE device = ?').get(device) as any;
      expect(registry).toBeDefined();
      expect(registry.first_seen).toBeGreaterThanOrEqual(now);
      expect(registry.last_seen).toBeGreaterThanOrEqual(now);
      expect(registry.retired).toBe(0);
    });

    it('should update last seen on subsequent connections', async () => {
      const device = '0xabc123';
      
      telemetry.recordDeviceConnection(device, 'TCP', '192.168.1.1');
      const first = telemetry['db'].prepare('SELECT * FROM device_registry WHERE device = ?').get(device) as any;
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      telemetry.recordDeviceConnection(device, 'TCP', '192.168.1.1');
      const second = telemetry['db'].prepare('SELECT * FROM device_registry WHERE device = ?').get(device) as any;
      
      expect(second.first_seen).toBe(first.first_seen);
      expect(second.last_seen).toBeGreaterThan(first.last_seen);
    });

    it('should mark device as retired', () => {
      const device = '0xabc123';
      
      telemetry.recordDeviceConnection(device, 'TCP', '192.168.1.1');
      telemetry.markDeviceRetired(device, true, 'Replaced with new hardware');
      
      const registry = telemetry['db'].prepare('SELECT * FROM device_registry WHERE device = ?').get(device) as any;
      expect(registry.retired).toBe(1);
      expect(registry.notes).toBe('Replaced with new hardware');
    });

    it('should unretire device', () => {
      const device = '0xabc123';
      
      telemetry.recordDeviceConnection(device, 'TCP', '192.168.1.1');
      telemetry.markDeviceRetired(device, true);
      telemetry.markDeviceRetired(device, false);
      
      const registry = telemetry['db'].prepare('SELECT * FROM device_registry WHERE device = ?').get(device) as any;
      expect(registry.retired).toBe(0);
    });
  });

  describe('Device Diagnostics', () => {
    it('should record device diagnostics', () => {
      const device = '0xabc123';
      
      telemetry.recordDeviceDiagnostics(device, {
        resetReason: 'power_on',
        bootCount: 42,
        wifiAttempts: 3,
        connectTimeMs: 1500,
        networkIndex: 0,
        ssidHash: 'abc123',
        lastFailureStage: 'none',
      });
      
      const diag = telemetry.getLatestDiagnostics(device);
      expect(diag).toBeDefined();
      expect(diag?.resetReason).toBe('power_on');
      expect(diag?.bootCount).toBe(42);
      expect(diag?.wifiAttempts).toBe(3);
      expect(diag?.connectTimeMs).toBe(1500);
      expect(diag?.networkIndex).toBe(0);
      expect(diag?.ssidHash).toBe('abc123');
      expect(diag?.lastFailureStage).toBe('none');
    });

    it('should return latest diagnostics for device', async () => {
      const device = '0xabc123';
      
      telemetry.recordDeviceDiagnostics(device, {
        resetReason: 'power_on',
        bootCount: 1,
      });
      
      await new Promise(resolve => setTimeout(resolve, 5));
      
      telemetry.recordDeviceDiagnostics(device, {
        resetReason: 'software_reset',
        bootCount: 2,
      });
      
      const diag = telemetry.getLatestDiagnostics(device);
      expect(diag?.resetReason).toBe('software_reset');
      expect(diag?.bootCount).toBe(2);
    });

    it('should handle partial diagnostics', () => {
      const device = '0xabc123';
      
      telemetry.recordDeviceDiagnostics(device, {
        resetReason: 'watchdog',
      });
      
      const diag = telemetry.getLatestDiagnostics(device);
      expect(diag?.resetReason).toBe('watchdog');
      expect(diag?.bootCount).toBeNull();
    });
  });

  describe('Silent Device Detection', () => {
    it('should detect device that has gone silent', () => {
      const device = '0xabc123';
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      
      telemetry['db'].prepare(
        'INSERT INTO device_registry (device, first_seen, last_seen, retired) VALUES (?, ?, ?, 0)'
      ).run(device, oneHourAgo, oneHourAgo);
      
      telemetry['db'].prepare(
        'INSERT INTO device_events (timestamp, device, event_type, protocol) VALUES (?, ?, ?, ?)'
      ).run(oneHourAgo, device, 'connect', 'TCP');
      
      const silentDevices = telemetry.getSilentDevices({
        minSilenceMs: 30 * 60 * 1000,
        cadenceMultiplier: 2,
      });
      
      expect(silentDevices.length).toBeGreaterThan(0);
      const silent = silentDevices.find(d => d.address === device);
      expect(silent).toBeDefined();
      expect(silent?.silentDurationMs).toBeGreaterThan(30 * 60 * 1000);
    });

    it('should not detect recently active device', () => {
      const device = '0xabc123';
      
      telemetry.recordDeviceConnection(device, 'TCP', '192.168.1.1');
      
      const silentDevices = telemetry.getSilentDevices({
        minSilenceMs: 15 * 60 * 1000,
      });
      
      const silent = silentDevices.find(d => d.address === device);
      expect(silent).toBeUndefined();
    });

    it('should exclude retired devices by default', () => {
      const device = '0xabc123';
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      
      telemetry['db'].prepare(
        'INSERT INTO device_registry (device, first_seen, last_seen, retired) VALUES (?, ?, ?, 1)'
      ).run(device, oneHourAgo, oneHourAgo);
      
      telemetry['db'].prepare(
        'INSERT INTO device_events (timestamp, device, event_type, protocol) VALUES (?, ?, ?, ?)'
      ).run(oneHourAgo, device, 'connect', 'TCP');
      
      const silentDevices = telemetry.getSilentDevices({
        minSilenceMs: 15 * 60 * 1000,
        includeRetired: false,
      });
      
      const silent = silentDevices.find(d => d.address === device);
      expect(silent).toBeUndefined();
    });

    it('should include retired devices when requested', () => {
      const device = '0xabc123';
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      
      telemetry['db'].prepare(
        'INSERT INTO device_registry (device, first_seen, last_seen, retired) VALUES (?, ?, ?, 1)'
      ).run(device, oneHourAgo, oneHourAgo);
      
      telemetry['db'].prepare(
        'INSERT INTO device_events (timestamp, device, event_type, protocol) VALUES (?, ?, ?, ?)'
      ).run(oneHourAgo, device, 'connect', 'TCP');
      
      const silentDevices = telemetry.getSilentDevices({
        minSilenceMs: 15 * 60 * 1000,
        includeRetired: true,
      });
      
      const silent = silentDevices.find(d => d.address === device);
      expect(silent).toBeDefined();
      expect(silent?.retired).toBe(true);
    });

    it('should include last disconnect reason', () => {
      const device = '0xabc123';
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      
      telemetry['db'].prepare(
        'INSERT INTO device_registry (device, first_seen, last_seen, retired) VALUES (?, ?, ?, 0)'
      ).run(device, oneHourAgo, oneHourAgo);
      
      telemetry['db'].prepare(
        'INSERT INTO device_events (timestamp, device, event_type, protocol) VALUES (?, ?, ?, ?)'
      ).run(oneHourAgo, device, 'connect', 'TCP');
      
      telemetry['db'].prepare(
        'INSERT INTO device_events (timestamp, device, event_type, disconnect_reason) VALUES (?, ?, ?, ?)'
      ).run(oneHourAgo + 1000, device, 'disconnect', 'timeout');
      
      const silentDevices = telemetry.getSilentDevices({
        minSilenceMs: 15 * 60 * 1000,
      });
      
      const silent = silentDevices.find(d => d.address === device);
      expect(silent?.lastDisconnectReason).toBe('timeout');
    });

    it('should include last diagnostics', () => {
      const device = '0xabc123';
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      
      telemetry['db'].prepare(
        'INSERT INTO device_registry (device, first_seen, last_seen, retired) VALUES (?, ?, ?, 0)'
      ).run(device, oneHourAgo, oneHourAgo);
      
      telemetry['db'].prepare(
        'INSERT INTO device_events (timestamp, device, event_type, protocol) VALUES (?, ?, ?, ?)'
      ).run(oneHourAgo, device, 'connect', 'TCP');
      
      telemetry.recordDeviceDiagnostics(device, {
        resetReason: 'watchdog',
        bootCount: 100,
      });
      
      const silentDevices = telemetry.getSilentDevices({
        minSilenceMs: 15 * 60 * 1000,
      });
      
      const silent = silentDevices.find(d => d.address === device);
      expect(silent?.lastDiagnostics?.resetReason).toBe('watchdog');
      expect(silent?.lastDiagnostics?.bootCount).toBe(100);
    });

    it('should sort by silence duration descending', () => {
      const device1 = '0xabc001';
      const device2 = '0xabc002';
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      
      for (const [device, time] of [[device1, twoHoursAgo], [device2, oneHourAgo]]) {
        telemetry['db'].prepare(
          'INSERT INTO device_registry (device, first_seen, last_seen, retired) VALUES (?, ?, ?, 0)'
        ).run(device, time, time);
        
        telemetry['db'].prepare(
          'INSERT INTO device_events (timestamp, device, event_type, protocol) VALUES (?, ?, ?, ?)'
        ).run(time, device, 'connect', 'TCP');
      }
      
      const silentDevices = telemetry.getSilentDevices({
        minSilenceMs: 15 * 60 * 1000,
      });
      
      expect(silentDevices.length).toBeGreaterThanOrEqual(2);
      expect(silentDevices[0].address).toBe(device1);
      expect(silentDevices[1].address).toBe(device2);
    });
  });
});
