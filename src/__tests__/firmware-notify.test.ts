import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

const TEST_FIRMWARE_DB = './test-firmware-notify.db';
const TEST_TELEMETRY_DB = './test-telemetry-notify.db';
const ADMIN_PRIVATE_KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';

describe('Firmware Notify API', () => {
  let app: express.Application;
  let adminWallet: Wallet;

  beforeEach(() => {
    if (existsSync(TEST_FIRMWARE_DB)) unlinkSync(TEST_FIRMWARE_DB);
    if (existsSync(TEST_TELEMETRY_DB)) unlinkSync(TEST_TELEMETRY_DB);

    FirmwareService.resetInstance();
    TelemetryService.resetInstance();
    AdminAuthService.resetInstance();

    const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
    const telemetry = TelemetryService.getInstance(TEST_TELEMETRY_DB);

    process.env.ADMIN_ADDRESSES = new Wallet(ADMIN_PRIVATE_KEY).address;
    
    const mockService = {} as ASyncService;
    const mockTcpService = {
      getConnectedDevices: () => [],
      sendApiCallToDevice: async () => {},
    } as unknown as ASyncTCPService;

    const router = createRouter(mockService, mockTcpService);
    app = express();
    app.use('/api', router);

    adminWallet = new Wallet(ADMIN_PRIVATE_KEY);
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
    delete process.env.ADMIN_ADDRESSES;
  });

  async function getChallenge(): Promise<string> {
    const response = await request(app).get('/api/admin/challenge');
    return response.body.nonce;
  }

  async function signNotifyRequest(project: string): Promise<{ message: string; signature: string }> {
    const nonce = await getChallenge();
    const message = `notify:${project}:${nonce}`;
    const signature = await adminWallet.signMessage(message);
    return { message, signature };
  }

  it('should require authentication', async () => {
    const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
    firmware.addFirmware('garagedoor', '1.0.0', 'hash', 1024, 'key', 'url');

    const response = await request(app)
      .post('/api/firmware/garagedoor/notify')
      .send({})
      .expect(400);

    expect(response.body.error).toContain('signature');
  });

  it('should reject invalid signature', async () => {
    const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
    firmware.addFirmware('garagedoor', '1.0.0', 'hash', 1024, 'key', 'url');

    const nonce = await getChallenge();
    const message = `notify:garagedoor:${nonce}`;
    const wrongWallet = Wallet.createRandom();
    const signature = await wrongWallet.signMessage(message);

    const response = await request(app)
      .post('/api/firmware/garagedoor/notify')
      .send({ message, signature })
      .expect(403);

    expect(response.body.error).toContain('admin');
  });

  it('should return 404 when project has no firmware', async () => {
    const { message, signature } = await signNotifyRequest('nonexistent');

    const response = await request(app)
      .post('/api/firmware/nonexistent/notify')
      .send({ message, signature })
      .expect(404);

    expect(response.body.error).toContain('No firmware found');
  });

  it('should return success with empty lists when no devices connected', async () => {
    const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
    firmware.addFirmware('garagedoor', '1.0.0', 'hash', 1024, 'key', 'url');

    const { message, signature } = await signNotifyRequest('garagedoor');

    const response = await request(app)
      .post('/api/firmware/garagedoor/notify')
      .send({ message, signature })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.project).toBe('garagedoor');
    expect(response.body.latest).toBe('1.0.0');
    expect(response.body.notified).toEqual([]);
    expect(response.body.skipped).toEqual([]);
  });

  it('should skip devices with different project', async () => {
    const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
    firmware.addFirmware('garagedoor', '1.0.0', 'hash', 1024, 'key', 'url');

    const mockTcpService = {
      getConnectedDevices: () => [
        { address: '0xaaa', project: 'remotecamera', semver: '0.5.0' },
      ],
      sendApiCallToDevice: async () => {},
    } as unknown as ASyncTCPService;

    const router = createRouter({} as ASyncService, mockTcpService);
    const testApp = express();
    testApp.use('/api', router);

    const { message, signature } = await signNotifyRequest('garagedoor');

    const response = await request(testApp)
      .post('/api/firmware/garagedoor/notify')
      .send({ message, signature })
      .expect(200);

    expect(response.body.notified).toEqual([]);
  });

  it('should skip devices with legacy firmware format', async () => {
    const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
    firmware.addFirmware('garagedoor', '1.0.0', 'hash', 1024, 'key', 'url');

    const mockTcpService = {
      getConnectedDevices: () => [
        { address: '0xaaa', firmwareVersion: 'legacy-format' },
      ],
      sendApiCallToDevice: async () => {},
    } as unknown as ASyncTCPService;

    const router = createRouter({} as ASyncService, mockTcpService);
    const testApp = express();
    testApp.use('/api', router);

    const { message, signature } = await signNotifyRequest('garagedoor');

    const response = await request(testApp)
      .post('/api/firmware/garagedoor/notify')
      .send({ message, signature })
      .expect(200);

    expect(response.body.notified).toEqual([]);
  });

  it('should skip devices already on latest version', async () => {
    const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
    firmware.addFirmware('garagedoor', '1.0.0', 'hash', 1024, 'key', 'url');

    const mockTcpService = {
      getConnectedDevices: () => [
        { address: '0xaaa', project: 'garagedoor', semver: '1.0.0' },
      ],
      sendApiCallToDevice: async () => {},
    } as unknown as ASyncTCPService;

    const router = createRouter({} as ASyncService, mockTcpService);
    const testApp = express();
    testApp.use('/api', router);

    const { message, signature } = await signNotifyRequest('garagedoor');

    const response = await request(testApp)
      .post('/api/firmware/garagedoor/notify')
      .send({ message, signature })
      .expect(200);

    expect(response.body.notified).toEqual([]);
    expect(response.body.skipped.length).toBeGreaterThan(0);
    expect(response.body.skipped[0].reason).toContain('up to date');
  });

  it('should notify devices with older versions', async () => {
    const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
    firmware.addFirmware('garagedoor', '1.2.0', 'hash', 1024, 'key', 'url');

    const notifiedDevices: string[] = [];
    const mockTcpService = {
      getConnectedDevices: () => [
        { address: '0xaaa', project: 'garagedoor', semver: '1.0.0' },
        { address: '0xbbb', project: 'garagedoor', semver: '1.1.0' },
      ],
      sendApiCallToDevice: async (address: string) => {
        notifiedDevices.push(address);
      },
    } as unknown as ASyncTCPService;

    const router = createRouter({} as ASyncService, mockTcpService);
    const testApp = express();
    testApp.use('/api', router);

    const { message, signature } = await signNotifyRequest('garagedoor');

    const response = await request(testApp)
      .post('/api/firmware/garagedoor/notify')
      .send({ message, signature })
      .expect(200);

    expect(response.body.notified.length).toBe(2);
    expect(notifiedDevices).toContain('0xaaa');
    expect(notifiedDevices).toContain('0xbbb');
  });

  it('should support force flag to notify all devices', async () => {
    const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
    firmware.addFirmware('garagedoor', '1.0.0', 'hash', 1024, 'key', 'url');

    const notifiedDevices: string[] = [];
    const mockTcpService = {
      getConnectedDevices: () => [
        { address: '0xaaa', project: 'garagedoor', semver: '1.0.0' },
      ],
      sendApiCallToDevice: async (address: string) => {
        notifiedDevices.push(address);
      },
    } as unknown as ASyncTCPService;

    const router = createRouter({} as ASyncService, mockTcpService);
    const testApp = express();
    testApp.use('/api', router);

    const { message, signature } = await signNotifyRequest('garagedoor');

    const response = await request(testApp)
      .post('/api/firmware/garagedoor/notify')
      .send({ message, signature, force: true })
      .expect(200);

    expect(response.body.notified.length).toBe(1);
    expect(notifiedDevices).toContain('0xaaa');
  });

  it('should support device filtering', async () => {
    const firmware = FirmwareService.getInstance(TEST_FIRMWARE_DB);
    firmware.addFirmware('garagedoor', '1.2.0', 'hash', 1024, 'key', 'url');

    const notifiedDevices: string[] = [];
    const mockTcpService = {
      getConnectedDevices: () => [
        { address: '0xaaa', project: 'garagedoor', semver: '1.0.0' },
        { address: '0xbbb', project: 'garagedoor', semver: '1.0.0' },
      ],
      sendApiCallToDevice: async (address: string) => {
        notifiedDevices.push(address);
      },
    } as unknown as ASyncTCPService;

    const router = createRouter({} as ASyncService, mockTcpService);
    const testApp = express();
    testApp.use('/api', router);

    const { message, signature } = await signNotifyRequest('garagedoor');

    const response = await request(testApp)
      .post('/api/firmware/garagedoor/notify')
      .send({ message, signature, devices: ['0xaaa'] })
      .expect(200);

    expect(response.body.notified.length).toBe(1);
    expect(response.body.notified[0].address).toBe('0xaaa');
    expect(notifiedDevices).toEqual(['0xaaa']);
  });
});
