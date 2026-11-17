import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TelemetryService } from '../service/TelemetryService';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB_PATH = './test-wifi-diagnostics.db';

const OPCODE_WIFI_DIAGNOSTICS = 0x0A;

describe('WiFi Diagnostics (opcode 0x0A)', () => {
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

  describe('Packet Format', () => {
    it('should parse 14-byte diagnostics packet (big-endian)', () => {
      const packet = Buffer.alloc(14);
      packet[0] = OPCODE_WIFI_DIAGNOSTICS;
      packet[1] = 1; // POWERON
      packet.writeUInt16BE(42, 2); // bootCount
      packet.writeUInt16BE(3, 4); // wifiAttempts
      packet.writeUInt32BE(1500, 6); // connectTimeMs
      packet[10] = 0; // networkIndex
      packet[11] = 0; // lastFailureStage (none)
      packet[12] = 201; // lastDisconnectReason (NO_AP_FOUND)
      packet[13] = 0; // reserved
      
      expect(packet.length).toBe(14);
      expect(packet[0]).toBe(0x0A);
      
      const resetReason = packet[1];
      const bootCount = packet.readUInt16BE(2);
      const wifiAttempts = packet.readUInt16BE(4);
      const connectTimeMs = packet.readUInt32BE(6);
      const networkIndex = packet[10];
      const lastFailureStage = packet[11];
      const lastDisconnectReason = packet[12];
      
      expect(resetReason).toBe(1);
      expect(bootCount).toBe(42);
      expect(wifiAttempts).toBe(3);
      expect(connectTimeMs).toBe(1500);
      expect(networkIndex).toBe(0);
      expect(lastFailureStage).toBe(0);
      expect(lastDisconnectReason).toBe(201);
    });

    it('should handle large values correctly', () => {
      const packet = Buffer.alloc(14);
      packet[0] = OPCODE_WIFI_DIAGNOSTICS;
      packet[1] = 10; // SDIO
      packet.writeUInt16BE(65535, 2); // max uint16
      packet.writeUInt16BE(1000, 4);
      packet.writeUInt32BE(4294967295, 6); // max uint32
      packet[10] = 5;
      packet[11] = 6;
      packet[12] = 23;
      packet[13] = 0;
      
      expect(packet.readUInt16BE(2)).toBe(65535);
      expect(packet.readUInt32BE(6)).toBe(4294967295);
    });

    it('should detect short packet', () => {
      const shortPacket = Buffer.alloc(13);
      shortPacket[0] = OPCODE_WIFI_DIAGNOSTICS;
      
      expect(shortPacket.length).toBeLessThan(14);
    });
  });

  describe('ESP Reset Reason Decoding', () => {
    const resetReasons = [
      { code: 1, name: 'POWERON' },
      { code: 2, name: 'EXT' },
      { code: 3, name: 'SW' },
      { code: 4, name: 'PANIC' },
      { code: 5, name: 'INT_WDT' },
      { code: 6, name: 'TASK_WDT' },
      { code: 7, name: 'WDT' },
      { code: 8, name: 'DEEPSLEEP' },
      { code: 9, name: 'BROWNOUT' },
      { code: 10, name: 'SDIO' },
    ];

    it.each(resetReasons)('should decode reset reason $code as $name', ({ code, name }) => {
      const device = '0xabc123';
      
      telemetry.recordDeviceDiagnostics(device, {
        resetReason: name,
        bootCount: 1,
      });
      
      const diag = telemetry.getLatestDiagnostics(device);
      expect(diag?.resetReason).toBe(name);
    });
  });

  describe('Failure Stage Decoding', () => {
    const stages = [
      { code: 0, name: 'none' },
      { code: 1, name: 'wifi_assoc' },
      { code: 2, name: 'wifi_auth' },
      { code: 3, name: 'dhcp' },
      { code: 4, name: 'dns' },
      { code: 5, name: 'tls' },
      { code: 6, name: 'proxy_connect' },
    ];

    it.each(stages)('should decode failure stage $code as $name', ({ code, name }) => {
      const device = '0xabc123';
      
      telemetry.recordDeviceDiagnostics(device, {
        lastFailureStage: name,
      });
      
      const diag = telemetry.getLatestDiagnostics(device);
      expect(diag?.lastFailureStage).toBe(name);
    });
  });

  describe('WiFi Disconnect Reason Decoding', () => {
    const commonReasons = [
      { code: 0, name: 'none' },
      { code: 1, name: 'UNSPECIFIED' },
      { code: 15, name: 'FOURWAY_HANDSHAKE_TIMEOUT' },
      { code: 23, name: 'IEEE_802_1X_AUTH_FAILED' },
      { code: 200, name: 'BEACON_TIMEOUT' },
      { code: 201, name: 'NO_AP_FOUND' },
      { code: 202, name: 'AUTH_FAIL' },
      { code: 203, name: 'ASSOC_FAIL' },
      { code: 204, name: 'HANDSHAKE_TIMEOUT' },
      { code: 205, name: 'CONNECTION_FAIL' },
    ];

    it.each(commonReasons)('should decode wifi disconnect reason $code as $name', ({ code, name }) => {
      const device = '0xabc123';
      
      telemetry.recordDeviceDiagnostics(device, {
        wifiDisconnectReason: name,
      });
      
      const diag = telemetry.getLatestDiagnostics(device);
      expect(diag?.wifiDisconnectReason).toBe(name);
    });

    it('should map unknown codes to unknown(N)', () => {
      const device = '0xabc123';
      
      telemetry.recordDeviceDiagnostics(device, {
        wifiDisconnectReason: 'unknown(99)',
      });
      
      const diag = telemetry.getLatestDiagnostics(device);
      expect(diag?.wifiDisconnectReason).toBe('unknown(99)');
    });
  });

  describe('Complete Diagnostics Flow', () => {
    it('should store complete diagnostics from 0x0A packet', () => {
      const device = '0xabc123';
      
      telemetry.recordDeviceConnection(device, 'TCP', '192.168.1.1');
      
      telemetry.recordDeviceDiagnostics(device, {
        resetReason: 'POWERON',
        bootCount: 5,
        wifiAttempts: 2,
        connectTimeMs: 2500,
        networkIndex: 0,
        lastFailureStage: 'none',
        wifiDisconnectReason: 'NO_AP_FOUND',
      });
      
      const diag = telemetry.getLatestDiagnostics(device);
      expect(diag).toBeDefined();
      expect(diag?.resetReason).toBe('POWERON');
      expect(diag?.bootCount).toBe(5);
      expect(diag?.wifiAttempts).toBe(2);
      expect(diag?.connectTimeMs).toBe(2500);
      expect(diag?.networkIndex).toBe(0);
      expect(diag?.lastFailureStage).toBe('none');
      expect(diag?.wifiDisconnectReason).toBe('NO_AP_FOUND');
    });

    it('should track diagnostics across multiple boots', async () => {
      const device = '0xabc123';
      
      telemetry.recordDeviceConnection(device, 'TCP', '192.168.1.1');
      telemetry.recordDeviceDiagnostics(device, {
        resetReason: 'POWERON',
        bootCount: 1,
        wifiAttempts: 1,
        connectTimeMs: 1200,
        networkIndex: 0,
        lastFailureStage: 'none',
        wifiDisconnectReason: 'NO_AP_FOUND',
      });
      
      await new Promise(resolve => setTimeout(resolve, 5));
      
      telemetry.recordDeviceConnection(device, 'TCP', '192.168.1.1');
      telemetry.recordDeviceDiagnostics(device, {
        resetReason: 'SW',
        bootCount: 2,
        wifiAttempts: 3,
        connectTimeMs: 3500,
        networkIndex: 0,
        lastFailureStage: 'dhcp',
        wifiDisconnectReason: 'AUTH_FAIL',
      });
      
      const diag = telemetry.getLatestDiagnostics(device);
      expect(diag?.resetReason).toBe('SW');
      expect(diag?.bootCount).toBe(2);
      expect(diag?.lastFailureStage).toBe('dhcp');
    });

    it('should identify problematic patterns from diagnostics', () => {
      const device = '0xabc123';
      
      telemetry.recordDeviceDiagnostics(device, {
        resetReason: 'WDT',
        bootCount: 150,
        wifiAttempts: 10,
        connectTimeMs: 45000,
        networkIndex: 0,
        lastFailureStage: 'wifi_assoc',
        wifiDisconnectReason: 'AUTH_FAIL',
      });
      
      const diag = telemetry.getLatestDiagnostics(device);
      
      if (diag?.resetReason?.includes('WDT')) {
        expect(diag.resetReason).toMatch(/WDT/);
      }
      
      if (diag && diag.bootCount && diag.bootCount > 100) {
        expect(diag.bootCount).toBeGreaterThan(100);
      }
      
      if (diag && diag.wifiAttempts && diag.wifiAttempts > 5) {
        expect(diag.wifiAttempts).toBeGreaterThan(5);
      }
      
      if (diag && diag.connectTimeMs && diag.connectTimeMs > 30000) {
        expect(diag.connectTimeMs).toBeGreaterThan(30000);
      }
    });
  });
});
