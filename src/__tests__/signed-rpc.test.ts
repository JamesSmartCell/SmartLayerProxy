import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';
import { unlinkSync, existsSync } from 'fs';
import express from 'express';
import request from 'supertest';
import { TelemetryService } from '../service/TelemetryService';
import { AdminAuthService } from '../service/AdminAuthService';
import { createRouter } from '../api/routes';
import {
  SignedRpcService,
  ALLOWED_RPC_METHODS,
  RpcStatus,
  buildSignedRpcMessage,
  hashParams,
  canonicalJson,
  pinParamsToBlock,
  parseRpcCallRequest,
  encodeRpcCallRequest,
  encodeRpcResultPackets,
  OPCODE_RPC_CALL,
  OPCODE_RPC_RESULT,
  TCP_RPC_MAX_RESULT_BYTES,
} from '../service/SignedRpcService';

const TEST_DB = './test-signed-rpc.db';
const TEST_KEY =
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('SignedRpcService', () => {
  let wallet: ethers.Wallet;
  let mockSender: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    TelemetryService.resetInstance();
    TelemetryService.getInstance(TEST_DB, 30);
    AdminAuthService.resetInstance();
    SignedRpcService.resetInstance();

    wallet = new ethers.Wallet(TEST_KEY);
    mockSender = vi.fn(async () => ({
      result: '0x0000000000000000000000000000000000000000000000000000000000000001',
      blockNumber: 18_500_000,
      providerFallbacks: 0,
    }));
  });

  afterEach(() => {
    SignedRpcService.resetInstance();
    TelemetryService.resetInstance();
    AdminAuthService.resetInstance();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    delete process.env.TELEMETRY_API_KEY;
    delete process.env.ADMIN_ADDRESSES;
    delete process.env.RPC_SIGNER_PRIVATE_KEY;
  });

  function createService(overrides: Record<string, unknown> = {}) {
    return SignedRpcService.createForTests({
      privateKey: TEST_KEY,
      sender: mockSender,
      supportedChainIds: 'any',
      deviceLimitPerMin: 30,
      ipLimitPerMin: 60,
      ...overrides,
    });
  }

  describe('allowlist', () => {
    it('allows only read-only eth_* methods', async () => {
      const svc = createService();
      for (const method of ALLOWED_RPC_METHODS) {
        const out = await svc.execute({
          chainId: 1,
          method,
          params: method === 'eth_call' ? [{ to: '0x' + '11'.repeat(20), data: '0x' }] : [],
          deviceAddress: '0x' + 'ab'.repeat(20),
          nonceHex: '0x' + 'cd'.repeat(16),
        });
        expect(out.ok).toBe(true);
      }
    });

    it('rejects eth_sendRawTransaction and unknown methods', async () => {
      const svc = createService();
      for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign', 'foo']) {
        const out = await svc.execute({
          chainId: 1,
          method,
          params: [],
          deviceAddress: '0x' + 'ab'.repeat(20),
          nonceHex: '0x' + 'cd'.repeat(16),
        });
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.status).toBe(RpcStatus.METHOD_NOT_ALLOWED);
      }
    });
  });

  describe('fail-closed missing key', () => {
    it('returns SIGNER_UNAVAILABLE when private key is missing', async () => {
      const svc = SignedRpcService.createForTests({
        privateKey: null,
        sender: mockSender,
        supportedChainIds: 'any',
      });
      expect(svc.isSignerConfigured()).toBe(false);
      expect(svc.getSignerAddress()).toBeNull();
      const out = await svc.execute({
        chainId: 1,
        method: 'eth_blockNumber',
        params: [],
        deviceAddress: '0x' + 'ab'.repeat(20),
        nonceHex: '0x' + 'cd'.repeat(16),
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.status).toBe(RpcStatus.SIGNER_UNAVAILABLE);
      expect(mockSender).not.toHaveBeenCalled();
    });

    it('returns SIGNER_UNAVAILABLE for invalid private key', async () => {
      const svc = SignedRpcService.createForTests({
        privateKey: 'not-a-key',
        sender: mockSender,
        supportedChainIds: 'any',
      });
      expect(svc.isSignerConfigured()).toBe(false);
    });
  });

  describe('signature round-trip', () => {
    it('signs with EIP-191 and verifies with ethers.verifyMessage', async () => {
      const svc = createService();
      const device = '0x' + 'ab'.repeat(20);
      const nonce = '0x' + '11'.repeat(16);
      const params = [{ to: '0x' + '22'.repeat(20), data: '0x70a08231' + '00'.repeat(32) }];
      const out = await svc.execute({
        chainId: 1,
        method: 'eth_call',
        params,
        deviceAddress: device,
        nonceHex: nonce,
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;

      expect(svc.getSignerAddress()).toBe(wallet.address);
      const recovered = ethers.verifyMessage(out.message, out.signature);
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
      expect(await svc.verify(out.message, out.signature)).toBe(true);

      // Message is byte-exact rebuild
      const rebuilt = buildSignedRpcMessage({
        deviceAddress: device,
        nonceHex: nonce,
        chainId: 1,
        method: 'eth_call',
        paramsHash: hashParams(params),
        blockNumber: out.blockNumber,
        timestamp: out.timestamp,
        result: out.result,
      });
      expect(rebuilt).toBe(out.message);
      expect(out.signatureBytes.length).toBe(65);
    });
  });

  describe('replay binding', () => {
    it('different nonce produces different signature over same result', async () => {
      const svc = createService();
      const base = {
        chainId: 1,
        method: 'eth_call' as const,
        params: [{ to: '0x' + '22'.repeat(20), data: '0x' }],
        deviceAddress: '0x' + 'ab'.repeat(20),
      };
      const a = await svc.execute({ ...base, nonceHex: '0x' + 'aa'.repeat(16) });
      const b = await svc.execute({ ...base, nonceHex: '0x' + 'bb'.repeat(16) });
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.message).not.toBe(b.message);
      expect(a.signature).not.toBe(b.signature);
      // Old message must not verify against a different nonce rebuild expectation
      expect(a.message.includes('nonce:0x' + 'aa'.repeat(16))).toBe(true);
      expect(b.message.includes('nonce:0x' + 'bb'.repeat(16))).toBe(true);
    });

    it('binds device address into the signed message', async () => {
      const svc = createService();
      const out = await svc.execute({
        chainId: 1,
        method: 'eth_chainId',
        params: [],
        deviceAddress: '0x' + 'de'.repeat(20),
        nonceHex: '0x' + '01'.repeat(8),
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.message).toContain('device:0x' + 'de'.repeat(20));
    });
  });

  describe('supported chainIds', () => {
    it('rejects unsupported chainId when list is restricted', async () => {
      const svc = createService({ supportedChainIds: [1, 8453] });
      const out = await svc.execute({
        chainId: 999999,
        method: 'eth_blockNumber',
        params: [],
        deviceAddress: '0x' + 'ab'.repeat(20),
        nonceHex: '0x' + 'cd'.repeat(16),
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.status).toBe(RpcStatus.UNSUPPORTED_CHAIN);
      expect(mockSender).not.toHaveBeenCalled();
    });

    it('accepts allowlisted chainId', async () => {
      const svc = createService({ supportedChainIds: [8453] });
      const out = await svc.execute({
        chainId: 8453,
        method: 'eth_blockNumber',
        params: [],
        deviceAddress: '0x' + 'ab'.repeat(20),
        nonceHex: '0x' + 'cd'.repeat(16),
      });
      expect(out.ok).toBe(true);
    });
  });

  describe('rate limiting', () => {
    it('rate-limits per device', async () => {
      const svc = createService({ deviceLimitPerMin: 3, ipLimitPerMin: 100 });
      const device = '0x' + 'ab'.repeat(20);
      const req = {
        chainId: 1,
        method: 'eth_chainId',
        params: [] as unknown[],
        deviceAddress: device,
        nonceHex: '0x' + 'cd'.repeat(16),
        ipAddress: '10.0.0.1',
      };
      expect((await svc.execute(req)).ok).toBe(true);
      expect((await svc.execute(req)).ok).toBe(true);
      expect((await svc.execute(req)).ok).toBe(true);
      const limited = await svc.execute(req);
      expect(limited.ok).toBe(false);
      if (!limited.ok) expect(limited.status).toBe(RpcStatus.RATE_LIMITED);
    });

    it('rate-limits per IP across devices', async () => {
      const svc = createService({ deviceLimitPerMin: 100, ipLimitPerMin: 2 });
      const ip = '203.0.113.9';
      const a = await svc.execute({
        chainId: 1,
        method: 'eth_chainId',
        params: [],
        deviceAddress: '0x' + '01'.repeat(20),
        nonceHex: '0x11',
        ipAddress: ip,
      });
      const b = await svc.execute({
        chainId: 1,
        method: 'eth_chainId',
        params: [],
        deviceAddress: '0x' + '02'.repeat(20),
        nonceHex: '0x22',
        ipAddress: ip,
      });
      const c = await svc.execute({
        chainId: 1,
        method: 'eth_chainId',
        params: [],
        deviceAddress: '0x' + '03'.repeat(20),
        nonceHex: '0x33',
        ipAddress: ip,
      });
      expect(a.ok && b.ok).toBe(true);
      expect(c.ok).toBe(false);
      if (!c.ok) expect(c.status).toBe(RpcStatus.RATE_LIMITED);
    });
  });

  describe('TCP result size limit', () => {
    it('returns RESULT_TOO_LARGE when tcpLimits and result exceeds cap', async () => {
      const huge = '0x' + 'ab'.repeat(TCP_RPC_MAX_RESULT_BYTES);
      mockSender.mockResolvedValueOnce({
        result: huge,
        blockNumber: 1,
        providerFallbacks: 0,
      });
      const svc = createService();
      const out = await svc.execute({
        chainId: 1,
        method: 'eth_getCode',
        params: ['0x' + '11'.repeat(20)],
        deviceAddress: '0x' + 'ab'.repeat(20),
        nonceHex: '0x' + 'cd'.repeat(16),
        tcpLimits: true,
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.status).toBe(RpcStatus.RESULT_TOO_LARGE);
    });
  });

  describe('params helpers', () => {
    it('canonicalJson sorts object keys', () => {
      expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
      expect(hashParams([{ to: '0x1', data: '0x' }])).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('pinParamsToBlock replaces latest', () => {
      expect(pinParamsToBlock('eth_call', [{ to: '0x1' }, 'latest'], '0x123')).toEqual([
        { to: '0x1' },
        '0x123',
      ]);
      expect(pinParamsToBlock('eth_getBalance', ['0x1'], '0x123')).toEqual(['0x1', '0x123']);
      expect(pinParamsToBlock('eth_blockNumber', [], '0x123')).toEqual([]);
    });
  });

  describe('TCP wire encode/parse', () => {
    it('round-trips 0x0B request encoding', () => {
      const packet = encodeRpcCallRequest({
        requestId: 42,
        chainId: 8453,
        method: 'eth_call',
        params: [{ to: '0xabc', data: '0x1234' }],
        customNonce: Buffer.from('deadbeef', 'hex'),
      });
      expect(packet[0]).toBe(OPCODE_RPC_CALL);
      const parsed = parseRpcCallRequest(packet.subarray(1));
      expect(parsed).not.toBeNull();
      expect(parsed!.requestId).toBe(42);
      expect(parsed!.chainId).toBe(8453);
      expect(parsed!.method).toBe('eth_call');
      expect(parsed!.params).toEqual([{ data: '0x1234', to: '0xabc' }]);
      expect(parsed!.customNonce?.toString('hex')).toBe('deadbeef');
    });

    it('encodes 0x0C success chunks with opcode', async () => {
      const svc = createService();
      const out = await svc.execute({
        chainId: 1,
        method: 'eth_chainId',
        params: [],
        deviceAddress: '0x' + 'ab'.repeat(20),
        nonceHex: '0x99',
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const packets = encodeRpcResultPackets(7, out);
      expect(packets.length).toBeGreaterThanOrEqual(1);
      expect(packets[0][0]).toBe(OPCODE_RPC_RESULT);
      expect(packets[0].readUInt16BE(1)).toBe(7);
      expect(packets[0][3]).toBe(RpcStatus.OK);
    });

    it('encodes 0x0C error payload', () => {
      const packets = encodeRpcResultPackets(1, {
        ok: false,
        status: RpcStatus.RATE_LIMITED,
        error: 'too many',
        durationMs: 1,
        providerFallbacks: 0,
      });
      expect(packets).toHaveLength(1);
      expect(packets[0][0]).toBe(OPCODE_RPC_RESULT);
      expect(packets[0][3]).toBe(RpcStatus.RATE_LIMITED);
    });
  });

  describe('telemetry', () => {
    it('recordRpcCall stores chainId, method, success, duration, ip', () => {
      const telemetry = TelemetryService.getInstance();
      telemetry.recordRpcCall({
        address: '0xABC123',
        chainId: 8453,
        method: 'eth_call',
        success: true,
        durationMs: 42,
        ipAddress: '1.2.3.4',
        providerFallbacks: 2,
      });
      const { events } = telemetry.getEvents({ device: '0xabc123', limit: 10 });
      const ev = events.find((e) => e.eventType === 'rpc_call');
      expect(ev).toBeDefined();
      expect(ev!.apiMethod).toBe('eth_call');
      expect(ev!.apiSuccess).toBe(true);
      expect(ev!.apiResponseTime).toBe(42);
      expect(ev!.ipAddress).toBe('1.2.3.4');
      expect(ev!.firmwareProject).toBe('8453');
      expect(ev!.failureReason).toBe('fallbacks=2');
      expect(ev!.requests60s).toBe(2);
    });
  });
});

describe('Signed RPC HTTP endpoints', () => {
  const TEST_KEY_HTTP =
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  let app: express.Express;
  let mockSender: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    TelemetryService.resetInstance();
    TelemetryService.getInstance(TEST_DB, 30);
    AdminAuthService.resetInstance();
    SignedRpcService.resetInstance();

    process.env.TELEMETRY_API_KEY = 'test-rpc-api-key';
    process.env.ADMIN_ADDRESSES = new ethers.Wallet(TEST_KEY_HTTP).address;

    mockSender = vi.fn(async () => ({
      result: '0x01',
      blockNumber: 100,
      providerFallbacks: 0,
    }));

    SignedRpcService.createForTests({
      privateKey: TEST_KEY_HTTP,
      sender: mockSender,
      supportedChainIds: 'any',
    });

    const udp = {
      getResponse: vi.fn(async () => 'No device found'),
      checkServices: vi.fn(),
    } as any;
    const tcp = {
      getResponse: vi.fn(async () => 'No device found'),
      getConnectedDevices: vi.fn(() => []),
      sendApiCallToDevice: vi.fn(),
      trySendApiCallToDevice: vi.fn(() => false),
    } as any;

    app = express();
    app.use(express.json());
    app.use('/api', createRouter(udp, tcp));
  });

  afterEach(() => {
    SignedRpcService.resetInstance();
    TelemetryService.resetInstance();
    AdminAuthService.resetInstance();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    delete process.env.TELEMETRY_API_KEY;
    delete process.env.ADMIN_ADDRESSES;
  });

  it('GET /api/rpc/signer returns address', async () => {
    const res = await request(app).get('/api/rpc/signer');
    expect(res.status).toBe(200);
    expect(res.body.address.toLowerCase()).toBe(
      new ethers.Wallet(TEST_KEY_HTTP).address.toLowerCase()
    );
    expect(res.body.allowedMethods).toContain('eth_call');
  });

  it('POST /api/rpc/:chainId requires auth', async () => {
    const res = await request(app)
      .post('/api/rpc/1')
      .send({
        method: 'eth_chainId',
        params: [],
        device: '0x' + 'ab'.repeat(20),
        nonce: '0x' + 'cd'.repeat(8),
      });
    expect(res.status).toBe(401);
  });

  it('POST /api/rpc/:chainId works with Bearer token', async () => {
    const res = await request(app)
      .post('/api/rpc/1')
      .set('Authorization', 'Bearer test-rpc-api-key')
      .send({
        method: 'eth_chainId',
        params: [],
        device: '0x' + 'ab'.repeat(20),
        nonce: '0x' + 'cd'.repeat(8),
      });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('0x01');
    expect(res.body.signature).toMatch(/^0x/);
    expect(res.body.message).toContain('SmartLayerProxy-RPC-v1');
    const recovered = ethers.verifyMessage(res.body.message, res.body.signature);
    expect(recovered.toLowerCase()).toBe(res.body.signer.toLowerCase());
  });

  it('POST rejects disallowed methods', async () => {
    const res = await request(app)
      .post('/api/rpc/1')
      .set('Authorization', 'Bearer test-rpc-api-key')
      .send({
        method: 'eth_sendRawTransaction',
        params: ['0x'],
        device: '0x' + 'ab'.repeat(20),
        nonce: '0x11',
      });
    expect(res.status).toBe(403);
  });

  it('GET /api/rpc/signer returns 503 when key missing', async () => {
    SignedRpcService.resetInstance();
    SignedRpcService.createForTests({
      privateKey: null,
      sender: mockSender,
      supportedChainIds: 'any',
    });
    const res = await request(app).get('/api/rpc/signer');
    expect(res.status).toBe(503);
  });
});
