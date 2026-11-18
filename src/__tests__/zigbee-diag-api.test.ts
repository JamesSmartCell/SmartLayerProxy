import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TelemetryService } from '../service/TelemetryService';
import { FirmwareService } from '../service/FirmwareService';
import { ZigbeeDiagnosticsService } from '../service/ZigbeeDiagnosticsService';
import { AdminAuthService } from '../service/AdminAuthService';
import { createRouter } from '../api/routes';
import { unlinkSync, existsSync } from 'fs';
import { Wallet, HDNodeWallet } from 'ethers';

const TEST_TELEMETRY_DB = './test-zbgw-telemetry.db';
const TEST_ZIGBEE_DB = './test-zbgw-zigbee.db';
const TEST_FIRMWARE_DB = './test-zbgw-firmware.db';
const TEST_API_KEY = 'test-telemetry-key-zbgw';
const TEST_DIAG_TOKEN = 'test-zbgw-diag-token';
const TEST_DIAG_TOKEN_2 = 'second-zbgw-token';

function cleanupDb(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

describe('Zigbee Gateway Diagnostics API', () => {
  let app: express.Application;
  let wallet: HDNodeWallet;

  beforeAll(() => {
    wallet = Wallet.createRandom();
    process.env.TELEMETRY_API_KEY = TEST_API_KEY;
    process.env.ADMIN_ADDRESSES = wallet.address;
    process.env.TELEMETRY_ACK_ENABLED = 'true';
    process.env.ZBGW_DIAG_TOKENS = `${TEST_DIAG_TOKEN},${TEST_DIAG_TOKEN_2}`;
    process.env.TELEMETRY_DB_PATH = TEST_TELEMETRY_DB;
    process.env.ZIGBEE_DB_PATH = TEST_ZIGBEE_DB;
  });

  beforeEach(() => {
    cleanupDb(TEST_TELEMETRY_DB);
    cleanupDb(TEST_ZIGBEE_DB);
    cleanupDb(TEST_FIRMWARE_DB);

    TelemetryService.resetInstance();
    ZigbeeDiagnosticsService.resetInstance();
    FirmwareService.resetInstance();
    AdminAuthService.resetInstance();

    TelemetryService.getInstance(TEST_TELEMETRY_DB, 30);
    ZigbeeDiagnosticsService.getInstance(TEST_ZIGBEE_DB, 30);

    app = express();
    app.use(express.json({ limit: '1mb' }));

    const mockService = {
      checkServices: vi.fn(),
      getResponse: vi.fn(),
      getDeviceAddress: vi.fn(),
    } as any;

    const mockTcpService = {
      getResponse: vi.fn(),
      getDeviceAddress: vi.fn(),
      handleDeviceConnection: vi.fn(),
      getLoginChallenge: vi.fn(),
      getConnectedDevices: vi.fn(() => []),
      sendApiCallToDevice: vi.fn(),
    } as any;

    app.use('/api', createRouter(mockService, mockTcpService));
  });

  afterEach(() => {
    try { TelemetryService.getInstance().close(); } catch { /* ignore */ }
    try { ZigbeeDiagnosticsService.getInstance().close(); } catch { /* ignore */ }
    try { FirmwareService.getInstance(TEST_FIRMWARE_DB).close(); } catch { /* ignore */ }
    TelemetryService.resetInstance();
    ZigbeeDiagnosticsService.resetInstance();
    FirmwareService.resetInstance();
    AdminAuthService.resetInstance();
    cleanupDb(TEST_TELEMETRY_DB);
    cleanupDb(TEST_ZIGBEE_DB);
    cleanupDb(TEST_FIRMWARE_DB);
  });

  afterAll(() => {
    delete process.env.TELEMETRY_API_KEY;
    delete process.env.ADMIN_ADDRESSES;
    delete process.env.TELEMETRY_ACK_ENABLED;
    delete process.env.ZBGW_DIAG_TOKENS;
    delete process.env.TELEMETRY_DB_PATH;
    delete process.env.ZIGBEE_DB_PATH;
  });

  describe('POST /api/diag/zbgw (device)', () => {
    const sampleBody = {
      device_id: 'aabbccddeeff',
      fw: '1.2.3',
      kind: 'boot',
      ok: true,
      uptime_s: 12,
      reset: 'power',
      heap: 120000,
      wifi_rssi: -55,
      mqtt_ok: true,
      zigbee_ok: true,
      devices: 2,
      code: 'boot',
      message: 'Gateway started',
    };

    it('rejects missing X-ZBGW-Diag token', async () => {
      const res = await request(app)
        .post('/api/diag/zbgw')
        .send(sampleBody)
        .expect(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('rejects invalid token', async () => {
      await request(app)
        .post('/api/diag/zbgw')
        .set('X-ZBGW-Diag', 'wrong-token')
        .send(sampleBody)
        .expect(401);
    });

    it('accepts any configured comma-separated token', async () => {
      await request(app)
        .post('/api/diag/zbgw')
        .set('X-ZBGW-Diag', TEST_DIAG_TOKEN_2)
        .send(sampleBody)
        .expect(200);
    });

    it('returns 503 when tokens not configured', async () => {
      delete process.env.ZBGW_DIAG_TOKENS;
      const res = await request(app)
        .post('/api/diag/zbgw')
        .set('X-ZBGW-Diag', TEST_DIAG_TOKEN)
        .send(sampleBody)
        .expect(503);
      expect(res.body.error).toMatch(/disabled/i);
      process.env.ZBGW_DIAG_TOKENS = `${TEST_DIAG_TOKEN},${TEST_DIAG_TOKEN_2}`;
    });

    it('stores boot event and returns empty commands', async () => {
      const res = await request(app)
        .post('/api/diag/zbgw')
        .set('X-ZBGW-Diag', TEST_DIAG_TOKEN)
        .send(sampleBody)
        .expect(200);

      expect(res.body).toEqual({ commands: [] });

      const zigbee = ZigbeeDiagnosticsService.getInstance();
      const gateways = zigbee.listGateways();
      expect(gateways).toHaveLength(1);
      expect(gateways[0].mac).toBe('aabbccddeeff');
      expect(gateways[0].firmwareVersion).toBe('1.2.3');
      expect(gateways[0].status).toBe('boot');
    });

    it('works regardless of Host header', async () => {
      await request(app)
        .post('/api/diag/zbgw')
        .set('X-ZBGW-Diag', TEST_DIAG_TOKEN)
        .set('Host', 'zigbeediagnostics.percolate.one')
        .send(sampleBody)
        .expect(200);
    });

    it('accepts and stores arbitrary extra fields', async () => {
      await request(app)
        .post('/api/diag/zbgw')
        .set('X-ZBGW-Diag', TEST_DIAG_TOKEN)
        .send({
          ...sampleBody,
          kind: 'device-added',
          watchdog_count: 3,
          recovery_stage: 'mqtt_reconnect',
          unknown_device: {
            manufacturer: 'Acme',
            model: 'Plug-X',
            power_source: 'mains',
            endpoints: [{ id: 1, clusters: [6, 8] }],
          },
        })
        .expect(200);

      const feed = ZigbeeDiagnosticsService.getInstance().getEventsFeed(0, 10);
      expect(feed.rows).toHaveLength(1);
      expect(feed.rows[0].payload.watchdog_count).toBe(3);
      expect((feed.rows[0].payload.unknown_device as any).model).toBe('Plug-X');
    });

    it('rejects missing device_id', async () => {
      const { device_id, ...rest } = sampleBody;
      await request(app)
        .post('/api/diag/zbgw')
        .set('X-ZBGW-Diag', TEST_DIAG_TOKEN)
        .send(rest)
        .expect(400);
    });

    it('rejects oversized payloads', async () => {
      const big = {
        ...sampleBody,
        blob: 'x'.repeat(70 * 1024),
      };
      await request(app)
        .post('/api/diag/zbgw')
        .set('X-ZBGW-Diag', TEST_DIAG_TOKEN)
        .send(big)
        .expect(413);
    });

    it('delivers queued restart command on poll', async () => {
      const zigbee = ZigbeeDiagnosticsService.getInstance();
      zigbee.queueCommand('aabbccddeeff', 'restart', wallet.address.toLowerCase());

      const res = await request(app)
        .post('/api/diag/zbgw')
        .set('X-ZBGW-Diag', TEST_DIAG_TOKEN)
        .send({ ...sampleBody, kind: 'poll' })
        .expect(200);

      expect(res.body.commands).toEqual([{ action: 'restart' }]);

      const pending = zigbee.getPendingCommands('aabbccddeeff');
      expect(pending).toHaveLength(0);

      // Second poll should not re-deliver
      const res2 = await request(app)
        .post('/api/diag/zbgw')
        .set('X-ZBGW-Diag', TEST_DIAG_TOKEN)
        .send({ ...sampleBody, kind: 'poll' })
        .expect(200);
      expect(res2.body.commands).toEqual([]);
    });
  });

  describe('Admin endpoints', () => {
    async function postDeviceEvent(kind = 'ok') {
      await request(app)
        .post('/api/diag/zbgw')
        .set('X-ZBGW-Diag', TEST_DIAG_TOKEN)
        .send({
          device_id: '112233445566',
          fw: '2.0.0',
          kind,
          ok: kind !== 'error',
          reset: 'software',
        })
        .expect(200);
    }

    it('lists gateways with TELEMETRY_API_KEY', async () => {
      await postDeviceEvent('boot');

      const res = await request(app)
        .get('/api/diag/zbgw/gateways')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(res.body.gateways).toHaveLength(1);
      expect(res.body.gateways[0].mac).toBe('112233445566');
    });

    it('rejects gateway list without bearer', async () => {
      await request(app).get('/api/diag/zbgw/gateways').expect(401);
    });

    it('pages events with afterId and supports ack', async () => {
      await postDeviceEvent('boot');
      await postDeviceEvent('poll');
      await postDeviceEvent('ok');

      const page1 = await request(app)
        .get('/api/diag/zbgw/events?afterId=0&limit=2')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(page1.body.rows).toHaveLength(2);
      expect(page1.body.hasMore).toBe(true);

      const lastId = page1.body.rows[1].id;
      const page2 = await request(app)
        .get(`/api/diag/zbgw/events?afterId=${lastId}&limit=10`)
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(page2.body.rows).toHaveLength(1);

      const challenge = await request(app).get('/api/admin/challenge').expect(200);
      const upToId = page1.body.maxId;
      const message = `zbgw-ack:${upToId}:${challenge.body.nonce}`;
      const signature = await wallet.signMessage(message);

      const ack = await request(app)
        .post('/api/diag/zbgw/ack')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .send({ upToId, signature, message })
        .expect(200);

      expect(ack.body.deleted).toBe(3);
      expect(ack.body.remaining).toBe(0);
    });

    it('queues ota_check via admin-signed endpoint and delivers it', async () => {
      await postDeviceEvent('boot');

      const challenge = await request(app).get('/api/admin/challenge').expect(200);
      const mac = '112233445566';
      const action = 'ota_check';
      const message = `zbgw-cmd:${mac}:${action}:${challenge.body.nonce}`;
      const signature = await wallet.signMessage(message);

      const queued = await request(app)
        .post('/api/diag/zbgw/commands')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .send({ mac, action, signature, message })
        .expect(200);

      expect(queued.body.success).toBe(true);
      expect(queued.body.command.action).toBe('ota_check');

      const deliver = await request(app)
        .post('/api/diag/zbgw')
        .set('X-ZBGW-Diag', TEST_DIAG_TOKEN)
        .send({
          device_id: mac,
          fw: '2.0.0',
          kind: 'poll',
          ok: true,
        })
        .expect(200);

      expect(deliver.body.commands).toEqual([{ action: 'ota_check' }]);
    });

    it('rejects command queue with bad signature', async () => {
      const challenge = await request(app).get('/api/admin/challenge').expect(200);
      const other = Wallet.createRandom();
      const mac = '112233445566';
      const action = 'restart';
      const message = `zbgw-cmd:${mac}:${action}:${challenge.body.nonce}`;
      const signature = await other.signMessage(message);

      await request(app)
        .post('/api/diag/zbgw/commands')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .send({ mac, action, signature, message })
        .expect(403);
    });
  });

  describe('Firmware project zigbee-gateway', () => {
    it('serves GET /api/firmware/zigbee-gateway/latest', async () => {
      const fw = FirmwareService.getInstance(TEST_FIRMWARE_DB);
      fw.addFirmware(
        'zigbee-gateway',
        '1.0.1',
        'abc123',
        4096,
        'firmware/zigbee-gateway/1.0.1/firmware.bin',
        'https://example.r2.dev/firmware/zigbee-gateway/1.0.1/firmware.bin'
      );

      const res = await request(app)
        .get('/api/firmware/zigbee-gateway/latest')
        .expect(200);

      expect(res.body).toMatchObject({
        project: 'zigbee-gateway',
        version: '1.0.1',
        sha256: 'abc123',
        size: 4096,
        url: 'https://example.r2.dev/firmware/zigbee-gateway/1.0.1/firmware.bin',
      });
    });
  });
});
