import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TelemetryService } from '../service/TelemetryService';
import { AdminAuthService } from '../service/AdminAuthService';
import { createRouter } from '../api/routes';
import { unlinkSync, existsSync } from 'fs';
import { Wallet, HDNodeWallet } from 'ethers';

const TEST_DB_PATH = './test-feed-telemetry.db';
const TEST_API_KEY = 'test-api-key-12345';

describe('Telemetry Feed & Ack API', () => {
  let app: express.Application;
  let wallet: HDNodeWallet;

  beforeAll(() => {
    wallet = Wallet.createRandom();
    process.env.TELEMETRY_API_KEY = TEST_API_KEY;
    process.env.ADMIN_ADDRESSES = wallet.address;
    process.env.TELEMETRY_ACK_ENABLED = 'true';
  });

  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    TelemetryService.resetInstance();
    AdminAuthService.resetInstance();
    TelemetryService.getInstance(TEST_DB_PATH, 30);

    app = express();
    app.use(express.json());
    app.use(express.raw({ type: 'application/octet-stream', limit: '10mb' }));
    
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
    const telemetry = TelemetryService.getInstance();
    telemetry.close();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    AdminAuthService.resetInstance();
  });

  afterAll(() => {
    delete process.env.TELEMETRY_API_KEY;
    delete process.env.ADMIN_ADDRESSES;
    delete process.env.TELEMETRY_ACK_ENABLED;
  });

  describe('GET /api/telemetry/feed', () => {
    it('should require authentication', async () => {
      await request(app)
        .get('/api/telemetry/feed')
        .expect(401);
    });

    it('should return paginated events', async () => {
      const telemetry = TelemetryService.getInstance();
      for (let i = 0; i < 10; i++) {
        telemetry.recordDeviceConnection('0xabc123', 'UDP');
      }

      const response = await request(app)
        .get('/api/telemetry/feed?afterId=0&limit=5')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(response.body.rows).toHaveLength(5);
      expect(response.body.maxId).toBeGreaterThan(0);
      expect(response.body.hasMore).toBe(true);
      expect(response.body.serverTime).toBeGreaterThan(0);
    });

    it('should support afterId pagination', async () => {
      const telemetry = TelemetryService.getInstance();
      for (let i = 0; i < 10; i++) {
        telemetry.recordApiCall('0xabc123', 'test', true, 50);
      }

      const page1 = await request(app)
        .get('/api/telemetry/feed?afterId=0&limit=5')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      const lastId = page1.body.rows[page1.body.rows.length - 1].id;

      const page2 = await request(app)
        .get(`/api/telemetry/feed?afterId=${lastId}&limit=5`)
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(page2.body.rows).toHaveLength(5);
      expect(page2.body.rows[0].id).toBeGreaterThan(lastId);
    });

    it('should respect max limit', async () => {
      const telemetry = TelemetryService.getInstance();
      for (let i = 0; i < 10; i++) {
        telemetry.recordDeviceConnection('0xabc123', 'UDP');
      }

      const response = await request(app)
        .get('/api/telemetry/feed?afterId=0&limit=10000')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(response.body.rows.length).toBeLessThanOrEqual(5000);
    });

    it('should include firmware version when available', async () => {
      const telemetry = TelemetryService.getInstance();
      telemetry.recordDeviceConnection('0xabc123', 'UDP', '192.168.1.1', 'v1.2.3');

      const response = await request(app)
        .get('/api/telemetry/feed?afterId=0')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(response.body.rows[0].firmwareVersion).toBe('v1.2.3');
    });
  });

  describe('POST /api/telemetry/ack', () => {
    it('should require authentication', async () => {
      await request(app)
        .post('/api/telemetry/ack')
        .send({ upToId: 1 })
        .expect(401);
    });

    it('should require admin signature', async () => {
      const telemetry = TelemetryService.getInstance();
      telemetry.recordDeviceConnection('0xabc123', 'UDP');

      await request(app)
        .post('/api/telemetry/ack')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .send({ upToId: 1 })
        .expect(400);
    });

    it('should delete events with valid signature', async () => {
      const telemetry = TelemetryService.getInstance();
      for (let i = 0; i < 10; i++) {
        telemetry.recordDeviceConnection('0xabc123', 'UDP');
      }

      const challengeResp = await request(app).get('/api/admin/challenge').expect(200);
      const { nonce } = challengeResp.body;

      const message = `ack:5:${nonce}`;
      const signature = await wallet.signMessage(message);

      const response = await request(app)
        .post('/api/telemetry/ack')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .send({ upToId: 5, signature, message })
        .expect(200);

      expect(response.body.deleted).toBe(5);
      expect(response.body.remaining).toBe(5);
      expect(response.body.deletedBy).toBe(wallet.address.toLowerCase());
    });

    it('should support dry run', async () => {
      const telemetry = TelemetryService.getInstance();
      for (let i = 0; i < 5; i++) {
        telemetry.recordDeviceConnection('0xabc123', 'UDP');
      }

      const challengeResp = await request(app).get('/api/admin/challenge').expect(200);
      const { nonce } = challengeResp.body;

      const message = `ack:5:${nonce}`;
      const signature = await wallet.signMessage(message);

      const response = await request(app)
        .post('/api/telemetry/ack')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .send({ upToId: 5, signature, message, dryRun: true })
        .expect(200);

      expect(response.body.wouldDelete).toBe(5);
      expect(response.body.dryRun).toBe(true);

      const feedResp = await request(app)
        .get('/api/telemetry/feed')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);

      expect(feedResp.body.rows).toHaveLength(5);
    });

    it('should reject replay attacks', async () => {
      const telemetry = TelemetryService.getInstance();
      telemetry.recordDeviceConnection('0xabc123', 'UDP');

      const challengeResp = await request(app).get('/api/admin/challenge').expect(200);
      const { nonce } = challengeResp.body;

      const message = `ack:1:${nonce}`;
      const signature = await wallet.signMessage(message);

      await request(app)
        .post('/api/telemetry/ack')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .send({ upToId: 1, signature, message })
        .expect(200);

      await request(app)
        .post('/api/telemetry/ack')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .send({ upToId: 1, signature, message })
        .expect(403);
    });

    it('should reject invalid message format', async () => {
      const challengeResp = await request(app).get('/api/admin/challenge').expect(200);
      const { nonce } = challengeResp.body;

      const message = `wrong:format:${nonce}`;
      const signature = await wallet.signMessage(message);

      await request(app)
        .post('/api/telemetry/ack')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .send({ upToId: 1, signature, message })
        .expect(400);
    });
  });

  describe('GET /api/admin/challenge', () => {
    it('should generate challenge nonce', async () => {
      const response = await request(app)
        .get('/api/admin/challenge')
        .expect(200);

      expect(response.body.nonce).toBeDefined();
      expect(response.body.nonce).toHaveLength(64);
      expect(response.body.expiresAt).toBeGreaterThan(Date.now());
    });
  });
});
