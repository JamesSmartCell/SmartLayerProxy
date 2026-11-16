import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TelemetryService } from '../service/TelemetryService';
import { FirmwareService } from '../service/FirmwareService';
import { AdminAuthService } from '../service/AdminAuthService';
import { createRouter } from '../api/routes';
import { unlinkSync, existsSync } from 'fs';
import { Wallet, HDNodeWallet } from 'ethers';
import { createHash } from 'crypto';

const TEST_TELEMETRY_DB = './test-firmware-api-telemetry.db';
const TEST_FIRMWARE_DB = './test-firmware-api-firmware.db';

describe('Firmware API', () => {
  let app: express.Application;
  let wallet: HDNodeWallet;

  beforeAll(() => {
    wallet = Wallet.createRandom();
    process.env.ADMIN_ADDRESSES = wallet.address;
    process.env.TELEMETRY_DB_PATH = TEST_TELEMETRY_DB;
    
    vi.mock('../service/CloudflareR2', () => ({
      uploadToR2: vi.fn(async (key: string, body: Buffer) => {
        return `https://example.r2.dev/${key}`;
      }),
      isR2Configured: vi.fn(() => true),
      getFirmwareBucketName: vi.fn(() => 'test-bucket'),
    }));
  });

  beforeEach(() => {
    if (existsSync(TEST_TELEMETRY_DB)) unlinkSync(TEST_TELEMETRY_DB);
    if (existsSync(TEST_FIRMWARE_DB)) unlinkSync(TEST_FIRMWARE_DB);
    
    TelemetryService.resetInstance();
    FirmwareService.resetInstance();
    AdminAuthService.resetInstance();
    
    TelemetryService.getInstance(TEST_TELEMETRY_DB, 30);

    app = express();
    app.use(express.json());
    app.use(express.raw({ type: ['application/octet-stream', 'application/x-binary'], limit: '10mb' }));
    
    const mockService = {
      checkServices: () => {},
      getResponse: async () => null,
      getDeviceAddress: async () => '',
    } as any;
    
    const mockTcpService = {
      getResponse: async () => null,
      getDeviceAddress: async () => '',
      handleDeviceConnection: () => '',
      getLoginChallenge: () => '',
    } as any;
    
    app.use('/api', createRouter(mockService, mockTcpService));
  });

  afterEach(() => {
    TelemetryService.getInstance().close();
    const fw = FirmwareService.getInstance(TEST_FIRMWARE_DB);
    if (fw) fw.close();
    
    if (existsSync(TEST_TELEMETRY_DB)) unlinkSync(TEST_TELEMETRY_DB);
    if (existsSync(TEST_FIRMWARE_DB)) unlinkSync(TEST_FIRMWARE_DB);
    
    AdminAuthService.resetInstance();
  });

  afterAll(() => {
    delete process.env.ADMIN_ADDRESSES;
    delete process.env.TELEMETRY_DB_PATH;
    vi.restoreAllMocks();
  });

  describe('GET /api/firmware/:project/latest', () => {
    it('should return 404 for nonexistent project', async () => {
      await request(app)
        .get('/api/firmware/Nonexistent/latest')
        .expect(404);
    });

    it('should return latest firmware version', async () => {
      const fw = FirmwareService.getInstance(TEST_FIRMWARE_DB);
      fw.addFirmware('GarageDoor', '1.0.0', 'hash1', 1024, 'key1', 'url1');
      fw.addFirmware('GarageDoor', '1.1.0', 'hash2', 2048, 'key2', 'url2');

      const response = await request(app)
        .get('/api/firmware/GarageDoor/latest')
        .expect(200);

      expect(response.body.project).toBe('GarageDoor');
      expect(response.body.version).toBe('1.1.0');
      expect(response.body.sha256).toBe('hash2');
      expect(response.body.size).toBe(2048);
      expect(response.body.url).toBe('url2');
    });
  });

  describe('GET /api/firmware/:project', () => {
    it('should list all versions', async () => {
      const fw = FirmwareService.getInstance(TEST_FIRMWARE_DB);
      fw.addFirmware('GarageDoor', '1.0.0', 'hash1', 1024, 'key1', 'url1');
      fw.addFirmware('GarageDoor', '1.1.0', 'hash2', 2048, 'key2', 'url2');
      fw.addFirmware('GarageDoor', '1.2.0', 'hash3', 3072, 'key3', 'url3');

      const response = await request(app)
        .get('/api/firmware/GarageDoor')
        .expect(200);

      expect(response.body.project).toBe('GarageDoor');
      expect(response.body.versions).toHaveLength(3);
      expect(response.body.versions[0].version).toBe('1.2.0');
    });

    it('should return empty list for nonexistent project', async () => {
      const response = await request(app)
        .get('/api/firmware/Nonexistent')
        .expect(200);

      expect(response.body.versions).toHaveLength(0);
    });
  });

  describe('POST /api/firmware/:project/current', () => {
    it('should require admin signature', async () => {
      await request(app)
        .post('/api/firmware/GarageDoor/current')
        .send({ version: '1.0.0' })
        .expect(400);
    });

    it('should rollback to previous version', async () => {
      const fw = FirmwareService.getInstance(TEST_FIRMWARE_DB);
      fw.addFirmware('GarageDoor', '1.0.0', 'hash1', 1024, 'key1', 'url1');
      fw.addFirmware('GarageDoor', '1.1.0', 'hash2', 2048, 'key2', 'url2');

      const challengeResp = await request(app).get('/api/admin/challenge').expect(200);
      const { nonce } = challengeResp.body;

      const message = `current:GarageDoor:1.0.0:${nonce}`;
      const signature = await wallet.signMessage(message);

      const response = await request(app)
        .post('/api/firmware/GarageDoor/current')
        .send({ version: '1.0.0', signature, message })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.version).toBe('1.0.0');
      expect(response.body.setBy).toBe(wallet.address.toLowerCase());

      const latestResp = await request(app).get('/api/firmware/GarageDoor/latest').expect(200);
      expect(latestResp.body.version).toBe('1.0.0');
    });

    it('should return 404 for nonexistent version', async () => {
      const fw = FirmwareService.getInstance(TEST_FIRMWARE_DB);
      fw.addFirmware('GarageDoor', '1.0.0', 'hash1', 1024, 'key1', 'url1');

      const challengeResp = await request(app).get('/api/admin/challenge').expect(200);
      const { nonce } = challengeResp.body;

      const message = `current:GarageDoor:9.9.9:${nonce}`;
      const signature = await wallet.signMessage(message);

      await request(app)
        .post('/api/firmware/GarageDoor/current')
        .send({ version: '9.9.9', signature, message })
        .expect(404);
    });

    it('should reject invalid message format', async () => {
      const challengeResp = await request(app).get('/api/admin/challenge').expect(200);
      const { nonce } = challengeResp.body;

      const message = `wrong:format:${nonce}`;
      const signature = await wallet.signMessage(message);

      await request(app)
        .post('/api/firmware/GarageDoor/current')
        .send({ version: '1.0.0', signature, message })
        .expect(400);
    });
  });

  describe('POST /api/firmware/:project', () => {
    it('should require admin signature', async () => {
      const firmware = Buffer.from('fake firmware data');

      await request(app)
        .post('/api/firmware/GarageDoor?version=1.0.0')
        .set('Content-Type', 'application/octet-stream')
        .send(firmware)
        .expect(400);
    });

    it('should upload firmware with valid signature', async () => {
      const firmware = Buffer.from('fake firmware data');
      const sha256 = createHash('sha256').update(firmware).digest('hex');

      const challengeResp = await request(app).get('/api/admin/challenge').expect(200);
      const { nonce } = challengeResp.body;

      const message = `firmware:GarageDoor:1.0.0:${sha256}:${nonce}`;
      const signature = await wallet.signMessage(message);

      const response = await request(app)
        .post(`/api/firmware/GarageDoor?version=1.0.0&signature=${encodeURIComponent(signature)}&message=${encodeURIComponent(message)}`)
        .set('Content-Type', 'application/octet-stream')
        .send(firmware)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.project).toBe('GarageDoor');
      expect(response.body.version).toBe('1.0.0');
      expect(response.body.sha256).toBe(sha256);
      expect(response.body.size).toBe(firmware.length);
      expect(response.body.uploadedBy).toBe(wallet.address.toLowerCase());
    });

    it('should reject duplicate version', async () => {
      const fw = FirmwareService.getInstance(TEST_FIRMWARE_DB);
      fw.addFirmware('GarageDoor', '1.0.0', 'existinghash', 1024, 'key1', 'url1');

      const firmware = Buffer.from('fake firmware data');
      const sha256 = createHash('sha256').update(firmware).digest('hex');

      const challengeResp = await request(app).get('/api/admin/challenge').expect(200);
      const { nonce } = challengeResp.body;

      const message = `firmware:GarageDoor:1.0.0:${sha256}:${nonce}`;
      const signature = await wallet.signMessage(message);

      await request(app)
        .post(`/api/firmware/GarageDoor?version=1.0.0&signature=${encodeURIComponent(signature)}&message=${encodeURIComponent(message)}`)
        .set('Content-Type', 'application/octet-stream')
        .send(firmware)
        .expect(409);
    });

    it('should reject mismatched sha256', async () => {
      const firmware = Buffer.from('fake firmware data');
      const wrongSha256 = 'wrong hash';

      const challengeResp = await request(app).get('/api/admin/challenge').expect(200);
      const { nonce } = challengeResp.body;

      const message = `firmware:GarageDoor:1.0.0:${wrongSha256}:${nonce}`;
      const signature = await wallet.signMessage(message);

      await request(app)
        .post(`/api/firmware/GarageDoor?version=1.0.0&signature=${encodeURIComponent(signature)}&message=${encodeURIComponent(message)}`)
        .set('Content-Type', 'application/octet-stream')
        .send(firmware)
        .expect(400);
    });

    it('should reject empty firmware', async () => {
      const challengeResp = await request(app).get('/api/admin/challenge').expect(200);
      const { nonce } = challengeResp.body;

      const message = `firmware:GarageDoor:1.0.0:emptyhash:${nonce}`;
      const signature = await wallet.signMessage(message);

      await request(app)
        .post(`/api/firmware/GarageDoor?version=1.0.0&signature=${encodeURIComponent(signature)}&message=${encodeURIComponent(message)}`)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(0))
        .expect(400);
    });
  });
});
