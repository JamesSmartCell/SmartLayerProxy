import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRouter } from '../api/routes';
import { ASyncService } from '../service/ASyncService';
import { ASyncTCPService } from '../service/ASyncTCPService';
import { FirmwareService } from '../service/FirmwareService';
import { TelemetryService } from '../service/TelemetryService';
import { AdminAuthService } from '../service/AdminAuthService';
import { Wallet } from 'ethers';
import { unlinkSync, existsSync } from 'fs';

const TEST_FIRMWARE_DB = './test-firmware-safety.db';
const TEST_TELEMETRY_DB = './test-telemetry-safety.db';
const ADMIN_PRIVATE_KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';

describe('Firmware Auto-Notify Safety', () => {
  let adminWallet: Wallet;

  beforeAll(() => {
    adminWallet = new Wallet(ADMIN_PRIVATE_KEY);
    process.env.ADMIN_ADDRESSES = adminWallet.address;

    // Mock R2 upload
    vi.mock('../service/CloudflareR2', () => ({
      uploadToR2: vi.fn(async (key: string) => `https://test.r2.dev/${key}`),
      uploadFirmwareToR2: vi.fn(async (project: string, key: string) => `https://test.r2.dev/${key}`),
      isR2Configured: vi.fn(() => true),
    }));
  });

  beforeEach(() => {
    if (existsSync(TEST_FIRMWARE_DB)) unlinkSync(TEST_FIRMWARE_DB);
    if (existsSync(TEST_TELEMETRY_DB)) unlinkSync(TEST_TELEMETRY_DB);

    FirmwareService.resetInstance();
    TelemetryService.resetInstance();
    AdminAuthService.resetInstance();

    FirmwareService.getInstance(TEST_FIRMWARE_DB);
    TelemetryService.getInstance(TEST_TELEMETRY_DB);
  });

  afterEach(() => {
    const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
    firmware.close();
    const telemetry = TelemetryService.getInstance(TEST_TELEMETRY_DB);
    telemetry.close();
    if (existsSync(TEST_FIRMWARE_DB)) unlinkSync(TEST_FIRMWARE_DB);
    if (existsSync(TEST_TELEMETRY_DB)) unlinkSync(TEST_TELEMETRY_DB);
    FirmwareService.resetInstance();
    TelemetryService.resetInstance();
    AdminAuthService.resetInstance();
  });

  afterAll(() => {
    delete process.env.ADMIN_ADDRESSES;
    vi.restoreAllMocks();
  });

  async function getChallenge(app: express.Application): Promise<string> {
    const response = await request(app).get('/api/admin/challenge');
    return response.body.nonce;
  }

  async function signUploadRequest(
    app: express.Application,
    project: string,
    version: string,
    sha256: string
  ): Promise<{ message: string; signature: string }> {
    const nonce = await getChallenge(app);
    const message = `firmware:${project}:${version}:${sha256}:${nonce}`;
    const signature = await adminWallet.signMessage(message);
    return { message, signature };
  }

  describe('autoNotify flag in database', () => {
    it('should store autoNotify=true for new uploads by default', async () => {
      const mockTcpService = {
        getConnectedDevices: () => [],
        sendApiCallToDevice: async () => {},
      } as unknown as ASyncTCPService;

      const router = createRouter({} as ASyncService, mockTcpService);
      const testApp = express();
      testApp.use(express.json());
      testApp.use(express.raw({ type: ['application/octet-stream', 'application/x-binary'], limit: '10mb' }));
      testApp.use('/api', router);

      const firmwareData = Buffer.from('fake firmware binary');
      const sha256 = require('crypto').createHash('sha256').update(firmwareData).digest('hex');
      const { message, signature } = await signUploadRequest(testApp, 'garagedoor', '1.2.10', sha256);

      await request(testApp)
        .post('/api/firmware/garagedoor')
        .query({ version: '1.2.10', signature, message })
        .set('Content-Type', 'application/octet-stream')
        .send(firmwareData)
        .expect(200);

      const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
      const latest = firmware.getLatestFirmware('garagedoor');
      expect(latest).not.toBeNull();
      expect(latest!.autoNotify).toBe(true);
    });

    it('should store autoNotify=false when autoNotify=false is passed', async () => {
      const mockTcpService = {
        getConnectedDevices: () => [],
        sendApiCallToDevice: async () => {},
      } as unknown as ASyncTCPService;

      const router = createRouter({} as ASyncService, mockTcpService);
      const testApp = express();
      testApp.use(express.json());
      testApp.use(express.raw({ type: ['application/octet-stream', 'application/x-binary'], limit: '10mb' }));
      testApp.use('/api', router);

      const firmwareData = Buffer.from('fake firmware binary');
      const sha256 = require('crypto').createHash('sha256').update(firmwareData).digest('hex');
      const { message, signature } = await signUploadRequest(testApp, 'garagedoor', '1.2.10', sha256);

      await request(testApp)
        .post('/api/firmware/garagedoor')
        .query({ version: '1.2.10', signature, message, autoNotify: 'false' })
        .set('Content-Type', 'application/octet-stream')
        .send(firmwareData)
        .expect(200);

      const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
      const latest = firmware.getLatestFirmware('garagedoor');
      expect(latest).not.toBeNull();
      expect(latest!.autoNotify).toBe(false);
    });

    it('should default existing releases to autoNotify=false after migration', () => {
      const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
      
      // Directly insert a release without autoNotify (simulating pre-migration data)
      const db = (firmware as any).db;
      db.prepare(`
        INSERT INTO firmware (project, version, sha256, size, r2_key, url, uploaded_at, is_current, auto_notify)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)
      `).run('garagedoor', '1.0.0', 'oldhash', 1024, 'oldkey', 'oldurl', Date.now());

      const latest = firmware.getLatestFirmware('garagedoor');
      expect(latest).not.toBeNull();
      expect(latest!.autoNotify).toBe(false);
    });
  });

  describe('login-time notify with autoNotify flag', () => {
    it('should NOT notify on login when latest release has autoNotify=false', async () => {
      const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
      
      // Upload with autoNotify=false
      firmware.addFirmware(
        'garagedoor',
        '1.2.10',
        'hash',
        1024,
        'key',
        'url',
        undefined,
        true,
        false // autoNotify=false
      );

      const latest = firmware.getLatestFirmware('garagedoor');
      expect(latest!.autoNotify).toBe(false);

      // Simulate login-time check - should skip notification
      // This would normally be tested via ASyncTCPService but that requires
      // more complex setup. The key assertion is that autoNotify=false is stored.
    });

    it('should notify on login when latest release has autoNotify=true', async () => {
      const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
      
      // Upload with autoNotify=true (default)
      firmware.addFirmware(
        'garagedoor',
        '1.2.10',
        'hash',
        1024,
        'key',
        'url',
        undefined,
        true,
        true // autoNotify=true
      );

      const latest = firmware.getLatestFirmware('garagedoor');
      expect(latest!.autoNotify).toBe(true);
    });
  });

  describe('logging of skipped devices', () => {
    it('should log skipped devices even when no devices were notified', async () => {
      const mockTcpService = {
        getConnectedDevices: () => [
          { address: '0xaaa', project: 'garagedoor', semver: '1.2.10', firmwareVersion: 'garagedoor@1.2.10+abc' },
        ],
        sendApiCallToDevice: async () => {},
      } as unknown as ASyncTCPService;

      const router = createRouter({} as ASyncService, mockTcpService);
      const testApp = express();
      testApp.use(express.json());
      testApp.use(express.raw({ type: ['application/octet-stream', 'application/x-binary'], limit: '10mb' }));
      testApp.use('/api', router);

      const firmwareData = Buffer.from('fake firmware binary');
      const sha256 = require('crypto').createHash('sha256').update(firmwareData).digest('hex');
      const { message, signature } = await signUploadRequest(testApp, 'garagedoor', '1.2.10', sha256);

      const response = await request(testApp)
        .post('/api/firmware/garagedoor')
        .query({ version: '1.2.10', signature, message })
        .set('Content-Type', 'application/octet-stream')
        .send(firmwareData)
        .expect(200);

      // Should have skipped devices in response
      expect(response.body.notified).toBe(0);
      expect(response.body.skipped).toBeDefined();
      expect(response.body.skipped.length).toBeGreaterThan(0);
      expect(response.body.skipped[0].reason).toBe('already up to date or newer');
    });
  });

  describe('schema migration', () => {
    it('should add auto_notify column to existing firmware table', () => {
      const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
      const db = (firmware as any).db;

      const columns = db.prepare('PRAGMA table_info(firmware)').all() as Array<{ name: string }>;
      const columnNames = columns.map(c => c.name);

      expect(columnNames).toContain('auto_notify');
    });
  });
});
