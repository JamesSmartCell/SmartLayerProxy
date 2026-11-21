import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRouter } from '../api/routes';
import { ASyncService } from '../service/ASyncService';
import { ASyncTCPService } from '../service/ASyncTCPService';
import {
  FirmwareService,
  buildRevokeNoticeMessage,
  normalizeDeviceAddress,
  setupFirmwareProjectId,
} from '../service/FirmwareService';
import { TelemetryService } from '../service/TelemetryService';
import { AdminAuthService } from '../service/AdminAuthService';
import { Wallet } from 'ethers';
import { unlinkSync, existsSync } from 'fs';

const TEST_FIRMWARE_DB = './test-firmware-revoke.db';
const TEST_TELEMETRY_DB = './test-telemetry-revoke.db';
const ADMIN_PRIVATE_KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';
const DEVICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('Firmware revoke helpers', () => {
  it('builds revoke notice message with normalized device address', () => {
    const msg = buildRevokeNoticeMessage(
      'garagedoor',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'abc123',
      'n'.repeat(64)
    );
    expect(msg).toBe(
      `revoke:garagedoor:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:abc123:${'n'.repeat(64)}`
    );
  });

  it('builds setup firmware project id helper', () => {
    expect(setupFirmwareProjectId('GarageDoor')).toBe('garagedoor-setup');
  });
});

describe('Firmware Revoke API', () => {
  let app: express.Application;
  let adminWallet: Wallet;
  let sentCalls: Array<{ address: string; method: string; args: any }>;
  let connected: Array<{ address: string; project?: string; semver?: string; firmwareVersion?: string }>;

  beforeAll(() => {
    vi.mock('../service/CloudflareR2', () => ({
      uploadToR2: vi.fn(async (key: string) => `https://example.r2.dev/${key}`),
      uploadFirmwareToR2: vi.fn(async (_project: string, key: string) => `https://example.r2.dev/${key}`),
      isR2Configured: vi.fn(() => true),
      getFirmwareBucketName: vi.fn(() => 'test-bucket'),
      getFirmwareStorageConfig: vi.fn(() => ({
        bucket: 'test-bucket',
        publicUrl: 'https://example.r2.dev',
        credentials: { accountId: 'a', accessKeyId: 'k', secretAccessKey: 's' },
        isDedicatedFirmwareBucket: true,
      })),
    }));
  });

  beforeEach(() => {
    if (existsSync(TEST_FIRMWARE_DB)) unlinkSync(TEST_FIRMWARE_DB);
    if (existsSync(TEST_TELEMETRY_DB)) unlinkSync(TEST_TELEMETRY_DB);

    FirmwareService.resetInstance();
    TelemetryService.resetInstance();
    AdminAuthService.resetInstance();

    process.env.ADMIN_ADDRESSES = new Wallet(ADMIN_PRIVATE_KEY).address;
    process.env.TELEMETRY_DB_PATH = TEST_TELEMETRY_DB;

    FirmwareService.getInstance(TEST_FIRMWARE_DB);
    TelemetryService.getInstance(TEST_TELEMETRY_DB);

    sentCalls = [];
    connected = [];

    const mockTcpService = {
      getConnectedDevices: () => connected,
      sendApiCallToDevice: async (address: string, method: string, args: any) => {
        sentCalls.push({ address, method, args });
      },
      trySendApiCallToDevice: (address: string, method: string, args: any) => {
        const hit = connected.some(d => d.address.toLowerCase() === address.toLowerCase());
        if (hit) sentCalls.push({ address, method, args });
        return hit;
      },
      deliverPendingRevoke: (deviceAddress: string) => {
        const firmware = FirmwareService.getInstance();
        const pending = firmware.getPendingRevoke(deviceAddress);
        if (!pending) return false;
        const hit = connected.some(
          d => d.address.toLowerCase() === normalizeDeviceAddress(deviceAddress).toLowerCase()
        );
        if (!hit) return false;
        const args = firmware.buildRevokeNoticeArgs(pending);
        sentCalls.push({ address: pending.device, method: 'updateReady', args });
        firmware.markRevokeDelivered(pending.id);
        TelemetryService.getInstance().recordFirmwareRevoke(
          pending.device,
          pending.project,
          'delivered',
          pending.setupVersion
        );
        return true;
      },
    } as unknown as ASyncTCPService;

    const router = createRouter({} as ASyncService, mockTcpService);
    app = express();
    app.use(express.json());
    app.use('/api', router);

    adminWallet = new Wallet(ADMIN_PRIVATE_KEY);
  });

  afterEach(() => {
    try {
      FirmwareService.getInstance().close();
    } catch {
      /* ignore */
    }
    try {
      TelemetryService.getInstance().close();
    } catch {
      /* ignore */
    }
    if (existsSync(TEST_FIRMWARE_DB)) unlinkSync(TEST_FIRMWARE_DB);
    if (existsSync(TEST_TELEMETRY_DB)) unlinkSync(TEST_TELEMETRY_DB);
    FirmwareService.resetInstance();
    TelemetryService.resetInstance();
    AdminAuthService.resetInstance();
    delete process.env.ADMIN_ADDRESSES;
    delete process.env.TELEMETRY_DB_PATH;
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  async function getChallenge(): Promise<string> {
    const response = await request(app).get('/api/admin/challenge');
    return response.body.nonce;
  }

  async function seedSetupFirmware(
    project = 'garagedoor',
    version = '1.0.0',
    sha256 = 'aa'.repeat(32)
  ) {
    const firmware = FirmwareService.getInstance();
    firmware.addSetupFirmware(
      project,
      version,
      sha256,
      2048,
      `firmware/${project}/setup/${version}/firmware.bin`,
      `https://example.r2.dev/firmware/${project}/setup/${version}/firmware.bin`
    );
    return { project, version, sha256 };
  }

  async function signRevoke(project: string, device: string, sha256: string) {
    const nonce = await getChallenge();
    const message = buildRevokeNoticeMessage(project, device, sha256, nonce);
    const signature = await adminWallet.signMessage(message);
    return { message, signature };
  }

  it('GET /setup returns 404 when no setup firmware registered', async () => {
    await request(app).get('/api/firmware/garagedoor/setup').expect(404);
  });

  it('GET /setup returns current setup firmware metadata', async () => {
    await seedSetupFirmware();
    const response = await request(app).get('/api/firmware/garagedoor/setup').expect(200);
    expect(response.body.version).toBe('1.0.0');
    expect(response.body.sha256).toBe('aa'.repeat(32));
    expect(response.body.channel).toBe('setup');
  });

  it('rejects revoke without auth', async () => {
    await seedSetupFirmware();
    const response = await request(app)
      .post('/api/firmware/garagedoor/revoke')
      .send({ device: DEVICE })
      .expect(400);
    expect(response.body.error).toContain('signature');
  });

  it('rejects revoke when no setup firmware registered', async () => {
    const nonce = await getChallenge();
    const message = buildRevokeNoticeMessage('garagedoor', DEVICE, 'deadbeef', nonce);
    const signature = await adminWallet.signMessage(message);

    const response = await request(app)
      .post('/api/firmware/garagedoor/revoke')
      .send({ device: DEVICE, message, signature })
      .expect(404);

    expect(response.body.error).toContain('setup firmware');
  });

  it('rejects revoke with wrong signature', async () => {
    const { sha256 } = await seedSetupFirmware();
    const nonce = await getChallenge();
    const message = buildRevokeNoticeMessage('garagedoor', DEVICE, sha256, nonce);
    const wrong = Wallet.createRandom();
    const signature = await wrong.signMessage(message);

    await request(app)
      .post('/api/firmware/garagedoor/revoke')
      .send({ device: DEVICE, message, signature })
      .expect(403);
  });

  it('queues revoke when device is offline', async () => {
    const { sha256, version } = await seedSetupFirmware();
    const { message, signature } = await signRevoke('garagedoor', DEVICE, sha256);

    const response = await request(app)
      .post('/api/firmware/garagedoor/revoke')
      .send({ device: DEVICE, message, signature })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.status).toBe('pending');
    expect(response.body.queued).toBe(true);
    expect(response.body.setup.version).toBe(version);
    expect(sentCalls).toHaveLength(0);

    const firmware = FirmwareService.getInstance();
    const pending = firmware.getPendingRevoke(DEVICE);
    expect(pending).not.toBeNull();
    expect(pending!.noticeMessage).toBe(message);

    const telemetry = TelemetryService.getInstance();
    const events = telemetry.getEvents({ device: DEVICE, limit: 10 });
    expect(events.events.some(e => e.eventType === 'firmware_revoke_requested')).toBe(true);
  });

  it('delivers revoke notice immediately when device is online', async () => {
    const { sha256 } = await seedSetupFirmware();
    connected = [{ address: DEVICE, project: 'garagedoor', semver: '1.2.0' }];

    const { message, signature } = await signRevoke('garagedoor', DEVICE, sha256);

    const response = await request(app)
      .post('/api/firmware/garagedoor/revoke')
      .send({ device: DEVICE, message, signature })
      .expect(200);

    expect(response.body.status).toBe('delivered');
    expect(response.body.queued).toBe(false);
    expect(sentCalls).toHaveLength(1);
    expect(sentCalls[0].method).toBe('updateReady');
    expect(sentCalls[0].args.purpose).toEqual(['revoke']);
    expect(sentCalls[0].args.sha256).toEqual([sha256]);
    expect(sentCalls[0].args.message).toEqual([message]);
    expect(sentCalls[0].args.signature).toEqual([signature]);

    const firmware = FirmwareService.getInstance();
    const active = firmware.getActiveRevoke(DEVICE);
    expect(active?.status).toBe('delivered');

    const telemetry = TelemetryService.getInstance();
    const events = telemetry.getEvents({ device: DEVICE, limit: 10 });
    const types = events.events.map(e => e.eventType);
    expect(types).toContain('firmware_revoke_requested');
    expect(types).toContain('firmware_revoke_delivered');
  });

  it('cancels a pending revoke', async () => {
    const { sha256 } = await seedSetupFirmware();
    const { message, signature } = await signRevoke('garagedoor', DEVICE, sha256);
    await request(app)
      .post('/api/firmware/garagedoor/revoke')
      .send({ device: DEVICE, message, signature })
      .expect(200);

    const nonce = await getChallenge();
    const cancelMessage = `revoke-cancel:garagedoor:${normalizeDeviceAddress(DEVICE)}:${nonce}`;
    const cancelSig = await adminWallet.signMessage(cancelMessage);

    const response = await request(app)
      .post('/api/firmware/garagedoor/revoke/cancel')
      .send({ device: DEVICE, message: cancelMessage, signature: cancelSig })
      .expect(200);

    expect(response.body.status).toBe('cancelled');
    expect(FirmwareService.getInstance().getActiveRevoke(DEVICE)).toBeNull();

    const events = TelemetryService.getInstance().getEvents({ device: DEVICE, limit: 10 });
    expect(events.events.some(e => e.eventType === 'firmware_revoke_cancelled')).toBe(true);
  });

  it('lists revokes for a project', async () => {
    const { sha256 } = await seedSetupFirmware();
    const { message, signature } = await signRevoke('garagedoor', DEVICE, sha256);
    await request(app)
      .post('/api/firmware/garagedoor/revoke')
      .send({ device: DEVICE, message, signature })
      .expect(200);

    const response = await request(app).get('/api/firmware/garagedoor/revokes').expect(200);
    expect(response.body.revokes).toHaveLength(1);
    expect(response.body.revokes[0].device).toBe(normalizeDeviceAddress(DEVICE));
    expect(response.body.revokes[0].status).toBe('pending');
  });

  it('uploads setup firmware with admin signature', async () => {
    const binary = Buffer.from('setup-firmware-binary-contents');
    const sha256 = FirmwareService.computeSha256(binary);
    const nonce = await getChallenge();
    const message = `setup-firmware:garagedoor:1.0.0:${sha256}:${nonce}`;
    const signature = await adminWallet.signMessage(message);

    const response = await request(app)
      .post(
        `/api/firmware/garagedoor/setup?version=1.0.0&signature=${encodeURIComponent(signature)}&message=${encodeURIComponent(message)}`
      )
      .set('Content-Type', 'application/octet-stream')
      .send(binary)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.channel).toBe('setup');
    expect(response.body.sha256).toBe(sha256);
    expect(response.body.url).toContain('/setup/1.0.0/');

    const latestApp = FirmwareService.getInstance().getLatestFirmware('garagedoor');
    expect(latestApp).toBeNull();
    const setup = FirmwareService.getInstance().getSetupFirmware('garagedoor');
    expect(setup?.version).toBe('1.0.0');
  });

  it('does not replace app latest when uploading setup firmware', async () => {
    const firmware = FirmwareService.getInstance();
    firmware.addFirmware(
      'garagedoor',
      '2.0.0',
      'bb'.repeat(32),
      4096,
      'firmware/garagedoor/2.0.0/firmware.bin',
      'https://example.r2.dev/app.bin'
    );

    const binary = Buffer.from('setup-bin');
    const sha256 = FirmwareService.computeSha256(binary);
    const nonce = await getChallenge();
    const message = `setup-firmware:garagedoor:1.0.0:${sha256}:${nonce}`;
    const signature = await adminWallet.signMessage(message);

    await request(app)
      .post(
        `/api/firmware/garagedoor/setup?version=1.0.0&signature=${encodeURIComponent(signature)}&message=${encodeURIComponent(message)}`
      )
      .set('Content-Type', 'application/octet-stream')
      .send(binary)
      .expect(200);

    expect(firmware.getLatestFirmware('garagedoor')?.version).toBe('2.0.0');
    expect(firmware.getSetupFirmware('garagedoor')?.version).toBe('1.0.0');
  });
});

describe('FirmwareService revoke queue', () => {
  beforeEach(() => {
    if (existsSync(TEST_FIRMWARE_DB)) unlinkSync(TEST_FIRMWARE_DB);
    FirmwareService.resetInstance();
  });

  afterEach(() => {
    try {
      FirmwareService.getInstance().close();
    } catch {
      /* ignore */
    }
    if (existsSync(TEST_FIRMWARE_DB)) unlinkSync(TEST_FIRMWARE_DB);
    FirmwareService.resetInstance();
  });

  it('marks delivered, acknowledged, then completed', () => {
    const fw = FirmwareService.getInstance(TEST_FIRMWARE_DB);
    fw.addSetupFirmware('garagedoor', '1.0.0', 'aa'.repeat(32), 100, 'key', 'url');
    const setup = fw.getSetupFirmware('garagedoor')!;

    const revoke = fw.requestRevoke({
      project: 'garagedoor',
      device: DEVICE,
      setup,
      noticeMessage: 'msg',
      noticeSignature: 'sig',
      requestedBy: '0xadmin',
    });
    expect(revoke.status).toBe('pending');

    const delivered = fw.markRevokeDelivered(revoke.id);
    expect(delivered?.status).toBe('delivered');

    const acknowledged = fw.markRevokeAcknowledged(revoke.id);
    expect(acknowledged?.status).toBe('acknowledged');

    fw.markRevokeDisconnectedAfterDelivery(DEVICE);
    expect(fw.getActiveRevoke(DEVICE)?.disconnectedAfterDelivery).toBe(true);

    const completed = fw.markRevokeCompleted(revoke.id);
    expect(completed?.status).toBe('completed');
    expect(fw.getActiveRevoke(DEVICE)).toBeNull();
  });

  it('supersedes previous pending revoke for same device', () => {
    const fw = FirmwareService.getInstance(TEST_FIRMWARE_DB);
    fw.addSetupFirmware('garagedoor', '1.0.0', 'aa'.repeat(32), 100, 'key', 'url');
    const setup = fw.getSetupFirmware('garagedoor')!;

    const first = fw.requestRevoke({
      project: 'garagedoor',
      device: DEVICE,
      setup,
      noticeMessage: 'msg1',
      noticeSignature: 'sig1',
    });
    const second = fw.requestRevoke({
      project: 'garagedoor',
      device: DEVICE,
      setup,
      noticeMessage: 'msg2',
      noticeSignature: 'sig2',
    });

    expect(fw.getRevokeById(first.id)?.status).toBe('cancelled');
    expect(second.status).toBe('pending');
    expect(fw.getPendingRevoke(DEVICE)?.id).toBe(second.id);
  });
});
