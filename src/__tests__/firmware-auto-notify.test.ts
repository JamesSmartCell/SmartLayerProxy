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

const TEST_FIRMWARE_DB = './test-firmware-auto-notify.db';
const TEST_TELEMETRY_DB = './test-telemetry-auto-notify.db';
const ADMIN_PRIVATE_KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';

describe('Firmware Auto-Notify on Upload', () => {
  let app: express.Application;
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

  it('should notify connected devices with older versions by default', async () => {
    const notifiedDevices: Array<{ address: string; method: string }> = [];
    const mockTcpService = {
      getConnectedDevices: () => [
        { address: '0xaaa', project: 'garagedoor', semver: '1.2.7', firmwareVersion: 'garagedoor@1.2.7+abc' },
        { address: '0xbbb', project: 'garagedoor', semver: '1.2.8', firmwareVersion: 'garagedoor@1.2.8+def' },
      ],
      sendApiCallToDevice: async (address: string, method: string) => {
        notifiedDevices.push({ address, method });
      },
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

    expect(response.body.success).toBe(true);
    expect(response.body.version).toBe('1.2.10');
    expect(response.body.notified).toBe(2);
    expect(notifiedDevices).toHaveLength(2);
    expect(notifiedDevices.every(d => d.method === 'updateReady')).toBe(true);
    expect(response.body.devices).toBeDefined();
    expect(response.body.devices[0].oldVersion).toBe('1.2.7');
    expect(response.body.devices[0].newVersion).toBe('1.2.10');
  });

  it('should NOT notify when autoNotify=false', async () => {
    const notifiedDevices: string[] = [];
    const mockTcpService = {
      getConnectedDevices: () => [
        { address: '0xaaa', project: 'garagedoor', semver: '1.2.7', firmwareVersion: 'garagedoor@1.2.7+abc' },
      ],
      sendApiCallToDevice: async (address: string) => {
        notifiedDevices.push(address);
      },
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
      .query({ version: '1.2.10', signature, message, autoNotify: 'false' })
      .set('Content-Type', 'application/octet-stream')
      .send(firmwareData)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.notified).toBeUndefined();
    expect(notifiedDevices).toHaveLength(0);
  });

  it('should skip devices on equal or newer versions', async () => {
    const notifiedDevices: string[] = [];
    const mockTcpService = {
      getConnectedDevices: () => [
        { address: '0xaaa', project: 'garagedoor', semver: '1.2.10', firmwareVersion: 'garagedoor@1.2.10+abc' },
        { address: '0xbbb', project: 'garagedoor', semver: '1.2.11', firmwareVersion: 'garagedoor@1.2.11+def' },
      ],
      sendApiCallToDevice: async (address: string) => {
        notifiedDevices.push(address);
      },
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

    expect(response.body.notified).toBe(0);
    expect(notifiedDevices).toHaveLength(0);
    expect(response.body.skipped).toBeDefined();
    expect(response.body.skipped.length).toBeGreaterThan(0);
  });

  it('should only notify devices of the same project', async () => {
    const notifiedDevices: Array<{ address: string; project?: string }> = [];
    const mockTcpService = {
      getConnectedDevices: () => [
        { address: '0xaaa', project: 'garagedoor', semver: '1.2.7', firmwareVersion: 'garagedoor@1.2.7+abc' },
        { address: '0xbbb', project: 'remotecamera', semver: '0.5.0', firmwareVersion: 'remotecamera@0.5.0+def' },
        { address: '0xccc', project: 'zigbee-gateway', semver: '1.0.0', firmwareVersion: 'zigbee-gateway@1.0.0+ghi' },
      ],
      sendApiCallToDevice: async (address: string) => {
        const device = mockTcpService.getConnectedDevices().find(d => d.address === address);
        notifiedDevices.push({ address, project: device?.project });
      },
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

    expect(response.body.notified).toBe(1);
    expect(notifiedDevices).toHaveLength(1);
    expect(notifiedDevices[0].address).toBe('0xaaa');
    expect(notifiedDevices[0].project).toBe('garagedoor');
  });

  it('should handle version 1.2.10 > 1.2.7 comparison correctly', async () => {
    const notifiedDevices: Array<{ address: string; oldVersion: string }> = [];
    const mockTcpService = {
      getConnectedDevices: () => [
        { address: '0xaaa', project: 'garagedoor', semver: '1.2.7', firmwareVersion: 'garagedoor@1.2.7+abc' },
        { address: '0xbbb', project: 'garagedoor', semver: '1.2.9', firmwareVersion: 'garagedoor@1.2.9+def' },
      ],
      sendApiCallToDevice: async (address: string) => {
        const device = mockTcpService.getConnectedDevices().find(d => d.address === address);
        notifiedDevices.push({ address, oldVersion: device!.semver! });
      },
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

    expect(response.body.notified).toBe(2);
    expect(notifiedDevices).toHaveLength(2);
    // Verify both 1.2.7 and 1.2.9 are considered older than 1.2.10
    expect(notifiedDevices.some(d => d.oldVersion === '1.2.7')).toBe(true);
    expect(notifiedDevices.some(d => d.oldVersion === '1.2.9')).toBe(true);
  });

  it('should skip devices with unparseable versions', async () => {
    const notifiedDevices: string[] = [];
    const mockTcpService = {
      getConnectedDevices: () => [
        { address: '0xaaa', project: 'garagedoor', semver: undefined, firmwareVersion: 'legacy-format' },
        { address: '0xbbb', project: 'garagedoor', semver: '1.2.7', firmwareVersion: 'garagedoor@1.2.7+abc' },
      ],
      sendApiCallToDevice: async (address: string) => {
        notifiedDevices.push(address);
      },
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

    expect(response.body.notified).toBe(1);
    expect(notifiedDevices).toEqual(['0xbbb']);
    expect(response.body.skipped).toBeDefined();
    expect(response.body.skipped.some((s: any) => s.reason === 'no parseable version')).toBe(true);
  });

  it('should log devices that were notified with version details', async () => {
    const mockTcpService = {
      getConnectedDevices: () => [
        { address: '0xaaa', project: 'garagedoor', semver: '1.2.7', firmwareVersion: 'garagedoor@1.2.7+e0a8bb6' },
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

    expect(response.body.devices).toBeDefined();
    expect(response.body.devices[0]).toMatchObject({
      address: '0xaaa',
      oldVersion: '1.2.7',
      newVersion: '1.2.10',
    });
  });
});
