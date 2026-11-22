/**
 * SignedRpcService — authenticated read-only JSON-RPC via waterfall-rpc,
 * with EIP-191 personal_sign attestation for ESP32 firmware verification.
 *
 * Keys: RPC_SIGNER_PRIVATE_KEY from .env only. Never logged.
 */

import { ethers } from 'ethers';
import { WaterfallRpc } from '@smarttokenlabs/waterfall-rpc';
import { IpRateCounter, normalizeIp } from '../util/ip';

/** Read-only eth_* methods permitted through the proxy. */
export const ALLOWED_RPC_METHODS = [
  'eth_call',
  'eth_getBalance',
  'eth_blockNumber',
  'eth_chainId',
  'eth_getCode',
  'eth_getTransactionReceipt',
] as const;

export type AllowedRpcMethod = (typeof ALLOWED_RPC_METHODS)[number];

export const RPC_MESSAGE_VERSION = 'SmartLayerProxy-RPC-v1';

/** TCP opcode: device → proxy rpcCall request. */
export const OPCODE_RPC_CALL = 0x0b;
/** TCP opcode: proxy → device signed rpcCall response (may be chunked). */
export const OPCODE_RPC_RESULT = 0x0c;

/** Max UTF-8 params JSON on TCP (fits under MAX_TCP_PACKET with headers). */
export const TCP_RPC_MAX_PARAMS_BYTES = 1024;
/** Max result string returned on TCP; larger results use HTTP. */
export const TCP_RPC_MAX_RESULT_BYTES = 512;
/** Max bytes of logical payload per 0x0C chunk (ESP-friendly). */
export const TCP_RPC_CHUNK_PAYLOAD = 1200;

export const RpcStatus = {
  OK: 0,
  BAD_REQUEST: 1,
  METHOD_NOT_ALLOWED: 2,
  UNSUPPORTED_CHAIN: 3,
  RATE_LIMITED: 4,
  RPC_FAILED: 5,
  SIGNER_UNAVAILABLE: 6,
  RESULT_TOO_LARGE: 7,
  UNAUTHENTICATED: 8,
} as const;

export type RpcStatusCode = (typeof RpcStatus)[keyof typeof RpcStatus];

export interface SignedRpcRequest {
  chainId: number;
  method: string;
  params: unknown[];
  /** Device Ethereum address (authenticated session or explicit HTTP). */
  deviceAddress: string;
  /**
   * Replay-binding nonce: session TCP challenge hex, or caller-supplied hex.
   * Must be non-empty.
   */
  nonceHex: string;
  /** Client IP for rate limiting / telemetry. */
  ipAddress?: string;
  /** When true, reject results larger than TCP_RPC_MAX_RESULT_BYTES. */
  tcpLimits?: boolean;
}

export interface SignedRpcSuccess {
  ok: true;
  chainId: number;
  method: AllowedRpcMethod;
  paramsHash: string;
  result: string;
  blockNumber: number;
  timestamp: number;
  nonceHex: string;
  deviceAddress: string;
  message: string;
  signature: string;
  signatureBytes: Uint8Array;
  durationMs: number;
  /** Fallback probe count when exposed by the transport (often 0). */
  providerFallbacks: number;
}

export interface SignedRpcFailure {
  ok: false;
  status: RpcStatusCode;
  error: string;
  durationMs: number;
  providerFallbacks: number;
}

export type SignedRpcOutcome = SignedRpcSuccess | SignedRpcFailure;

export type JsonRpcSender = (
  chainId: number,
  method: string,
  params: unknown[]
) => Promise<{ result: unknown; blockNumber: number; providerFallbacks: number }>;

export interface SignedRpcServiceOptions {
  /** Injected for tests; defaults to waterfall-backed sender. */
  sender?: JsonRpcSender;
  deviceLimitPerMin?: number;
  ipLimitPerMin?: number;
  /** Catalog refresh interval (ms). Default 24h. */
  catalogRefreshMs?: number;
  /** Skip starting the refresh timer (tests). */
  disableCatalogRefresh?: boolean;
  /** Private key hex; defaults to process.env.RPC_SIGNER_PRIVATE_KEY. */
  privateKey?: string | null;
  now?: () => number;
  /**
   * When set, chain support is checked against this list instead of probing waterfall.
   * Use `'any'` in unit tests with a mock sender.
   */
  supportedChainIds?: number[] | 'any';
}

function isAllowedMethod(method: string): method is AllowedRpcMethod {
  return (ALLOWED_RPC_METHODS as readonly string[]).includes(method);
}

/** Deterministic JSON for params hashing (sorted object keys, no spaces). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

export function hashParams(params: unknown[]): string {
  return ethers.keccak256(ethers.toUtf8Bytes(canonicalJson(params)));
}

/**
 * Byte-exact EIP-191 message body (UTF-8). Device must reconstruct identically.
 * Lines are LF-separated; no trailing newline.
 */
export function buildSignedRpcMessage(fields: {
  deviceAddress: string;
  nonceHex: string;
  chainId: number;
  method: string;
  paramsHash: string;
  blockNumber: number;
  timestamp: number;
  result: string;
}): string {
  const device = normalizeAddress(fields.deviceAddress);
  const nonce = normalizeHex(fields.nonceHex);
  const paramsHash = normalizeHex(fields.paramsHash);
  const result = normalizeResult(fields.result);
  return [
    RPC_MESSAGE_VERSION,
    `device:${device}`,
    `nonce:${nonce}`,
    `chainId:${fields.chainId}`,
    `method:${fields.method}`,
    `paramsHash:${paramsHash}`,
    `block:${fields.blockNumber}`,
    `timestamp:${fields.timestamp}`,
    `result:${result}`,
  ].join('\n');
}

export function normalizeAddress(addr: string): string {
  const hex = addr.replace(/^0x/i, '').toLowerCase();
  return '0x' + hex;
}

export function normalizeHex(hex: string): string {
  const h = hex.replace(/^0x/i, '').toLowerCase();
  return '0x' + h;
}

function normalizeResult(result: string): string {
  if (typeof result !== 'string') return String(result);
  if (result.startsWith('0x') || result.startsWith('0X')) {
    return '0x' + result.slice(2).toLowerCase();
  }
  return result;
}

function resultToWireString(result: unknown): string {
  if (typeof result === 'string') {
    return result.startsWith('0x') || result.startsWith('0X')
      ? '0x' + result.slice(2).toLowerCase()
      : result;
  }
  if (typeof result === 'number' || typeof result === 'bigint') {
    return ethers.toQuantity(result);
  }
  if (result === null || result === undefined) return '0x';
  // Objects (e.g. eth_getTransactionReceipt): canonical JSON
  return canonicalJson(result);
}

export class SignedRpcService {
  private static instance: SignedRpcService | null = null;

  private wallet: ethers.Wallet | null = null;
  private readonly sender: JsonRpcSender;
  private readonly deviceLimiter = new IpRateCounter();
  private readonly ipLimiter = new IpRateCounter();
  private readonly deviceLimitPerMin: number;
  private readonly ipLimitPerMin: number;
  private readonly now: () => number;
  private catalogTimer?: NodeJS.Timeout;
  private providerCache = new Map<number, WaterfallRpc>();
  private supportedChainCache: Set<number> | null = null;
  private readonly supportedChainIds: number[] | 'any' | null;
  private readonly usingCustomSender: boolean;

  private constructor(options: SignedRpcServiceOptions = {}) {
    this.deviceLimitPerMin =
      options.deviceLimitPerMin ??
      parseInt(process.env.RPC_RATE_LIMIT_DEVICE_PER_MIN || '30', 10);
    this.ipLimitPerMin =
      options.ipLimitPerMin ??
      parseInt(process.env.RPC_RATE_LIMIT_IP_PER_MIN || '60', 10);
    this.now = options.now ?? (() => Date.now());
    this.usingCustomSender = Boolean(options.sender);
    this.supportedChainIds = options.supportedChainIds ?? null;
    this.sender = options.sender ?? ((chainId, method, params) =>
      this.defaultSender(chainId, method, params));

    const keySource =
      options.privateKey !== undefined
        ? options.privateKey
        : process.env.RPC_SIGNER_PRIVATE_KEY;

    if (keySource && keySource.trim()) {
      try {
        this.wallet = new ethers.Wallet(keySource.trim());
        console.log(
          '[SignedRpc] Signer loaded; address=',
          this.wallet.address
        );
      } catch {
        console.error('[SignedRpc] Invalid RPC_SIGNER_PRIVATE_KEY; signed RPC disabled');
        this.wallet = null;
      }
    } else {
      console.warn(
        '[SignedRpc] RPC_SIGNER_PRIVATE_KEY not set; signed RPC fail-closed'
      );
      this.wallet = null;
    }

    if (!options.disableCatalogRefresh) {
      const interval =
        options.catalogRefreshMs ??
        parseInt(process.env.RPC_CATALOG_REFRESH_MS || String(24 * 60 * 60 * 1000), 10);
      // Library auto-refreshes weekly via scheduleCatalogRefreshIfStale; we force
      // a 24h refresh so Chainlist/rankings stay fresher on the Pi.
      this.catalogTimer = setInterval(() => {
        void this.refreshCatalog();
      }, interval);
      // Unref so the timer does not keep the process alive in tests/scripts.
      if (typeof this.catalogTimer.unref === 'function') {
        this.catalogTimer.unref();
      }
    }
  }

  static getInstance(options?: SignedRpcServiceOptions): SignedRpcService {
    if (!SignedRpcService.instance) {
      SignedRpcService.instance = new SignedRpcService(options);
    }
    return SignedRpcService.instance;
  }

  static resetInstance(): void {
    if (SignedRpcService.instance) {
      SignedRpcService.instance.stop();
      SignedRpcService.instance = null;
    }
  }

  /** Test helper: replace singleton with a configured instance. */
  static createForTests(options: SignedRpcServiceOptions): SignedRpcService {
    SignedRpcService.resetInstance();
    SignedRpcService.instance = new SignedRpcService({
      disableCatalogRefresh: true,
      ...options,
    });
    return SignedRpcService.instance;
  }

  stop(): void {
    if (this.catalogTimer) {
      clearInterval(this.catalogTimer);
      this.catalogTimer = undefined;
    }
    this.providerCache.clear();
  }

  isSignerConfigured(): boolean {
    return this.wallet !== null;
  }

  getSignerAddress(): string | null {
    return this.wallet?.address ?? null;
  }

  async refreshCatalog(): Promise<void> {
    try {
      // Force download if cache older than 24h (library default interval is 7d).
      await WaterfallRpc.resetProviders(24 * 60 * 60 * 1000);
      this.providerCache.clear();
      this.supportedChainCache = null;
      console.log('[SignedRpc] Waterfall RPC catalog refresh completed');
    } catch (err) {
      console.error(
        '[SignedRpc] Catalog refresh failed:',
        err instanceof Error ? err.message : err
      );
    }
  }

  checkRateLimit(deviceAddress: string, ipAddress?: string): {
    limited: boolean;
    deviceCount: number;
    ipCount: number;
  } {
    const now = this.now();
    const deviceKey = 'dev:' + normalizeAddress(deviceAddress);
    const deviceStats = this.deviceLimiter.record(deviceKey, now);
    const ipStats = this.ipLimiter.record(normalizeIp(ipAddress) || 'unknown', now);
    const limited =
      deviceStats.last60s > this.deviceLimitPerMin ||
      ipStats.last60s > this.ipLimitPerMin;
    return {
      limited,
      deviceCount: deviceStats.last60s,
      ipCount: ipStats.last60s,
    };
  }

  /** Clear rate-limit windows (tests). */
  clearRateLimits(): void {
    this.deviceLimiter.clear();
    this.ipLimiter.clear();
  }

  async execute(request: SignedRpcRequest): Promise<SignedRpcOutcome> {
    const started = this.now();
    const duration = () => this.now() - started;

    if (!this.wallet) {
      return {
        ok: false,
        status: RpcStatus.SIGNER_UNAVAILABLE,
        error: 'RPC signer not configured',
        durationMs: duration(),
        providerFallbacks: 0,
      };
    }

    if (!Number.isInteger(request.chainId) || request.chainId <= 0) {
      return {
        ok: false,
        status: RpcStatus.BAD_REQUEST,
        error: 'Invalid chainId',
        durationMs: duration(),
        providerFallbacks: 0,
      };
    }

    if (!request.nonceHex || !/^0x[0-9a-fA-F]+$/.test(normalizeHex(request.nonceHex))) {
      return {
        ok: false,
        status: RpcStatus.BAD_REQUEST,
        error: 'Invalid or missing nonce',
        durationMs: duration(),
        providerFallbacks: 0,
      };
    }

    if (!request.deviceAddress || !/^0x[0-9a-fA-F]{40}$/.test(normalizeAddress(request.deviceAddress))) {
      return {
        ok: false,
        status: RpcStatus.BAD_REQUEST,
        error: 'Invalid device address',
        durationMs: duration(),
        providerFallbacks: 0,
      };
    }

    if (!isAllowedMethod(request.method)) {
      return {
        ok: false,
        status: RpcStatus.METHOD_NOT_ALLOWED,
        error: `Method not allowed: ${request.method}`,
        durationMs: duration(),
        providerFallbacks: 0,
      };
    }

    if (!Array.isArray(request.params)) {
      return {
        ok: false,
        status: RpcStatus.BAD_REQUEST,
        error: 'params must be an array',
        durationMs: duration(),
        providerFallbacks: 0,
      };
    }

    const rate = this.checkRateLimit(request.deviceAddress, request.ipAddress);
    if (rate.limited) {
      return {
        ok: false,
        status: RpcStatus.RATE_LIMITED,
        error: `Rate limit exceeded (device=${rate.deviceCount}/min, ip=${rate.ipCount}/min)`,
        durationMs: duration(),
        providerFallbacks: 0,
      };
    }

    const supported = await this.isChainSupported(request.chainId);
    if (!supported) {
      return {
        ok: false,
        status: RpcStatus.UNSUPPORTED_CHAIN,
        error: `Unsupported chainId: ${request.chainId}`,
        durationMs: duration(),
        providerFallbacks: 0,
      };
    }

    let rpcResult: { result: unknown; blockNumber: number; providerFallbacks: number };
    try {
      rpcResult = await this.sender(request.chainId, request.method, request.params);
    } catch (err) {
      return {
        ok: false,
        status: RpcStatus.RPC_FAILED,
        error: err instanceof Error ? err.message : 'RPC call failed',
        durationMs: duration(),
        providerFallbacks: 0,
      };
    }

    const resultStr = resultToWireString(rpcResult.result);
    if (request.tcpLimits && Buffer.byteLength(resultStr, 'utf-8') > TCP_RPC_MAX_RESULT_BYTES) {
      return {
        ok: false,
        status: RpcStatus.RESULT_TOO_LARGE,
        error: `Result exceeds TCP limit of ${TCP_RPC_MAX_RESULT_BYTES} bytes; use HTTP POST /api/rpc/${request.chainId}`,
        durationMs: duration(),
        providerFallbacks: rpcResult.providerFallbacks,
      };
    }

    const paramsHash = hashParams(request.params);
    const timestamp = Math.floor(this.now() / 1000);
    const deviceAddress = normalizeAddress(request.deviceAddress);
    const nonceHex = normalizeHex(request.nonceHex);
    const message = buildSignedRpcMessage({
      deviceAddress,
      nonceHex,
      chainId: request.chainId,
      method: request.method,
      paramsHash,
      blockNumber: rpcResult.blockNumber,
      timestamp,
      result: resultStr,
    });

    let signature: string;
    try {
      signature = await this.wallet.signMessage(message);
    } catch (err) {
      return {
        ok: false,
        status: RpcStatus.SIGNER_UNAVAILABLE,
        error: err instanceof Error ? err.message : 'Signing failed',
        durationMs: duration(),
        providerFallbacks: rpcResult.providerFallbacks,
      };
    }

    const signatureBytes = ethers.getBytes(signature);

    return {
      ok: true,
      chainId: request.chainId,
      method: request.method,
      paramsHash,
      result: resultStr,
      blockNumber: rpcResult.blockNumber,
      timestamp,
      nonceHex,
      deviceAddress,
      message,
      signature,
      signatureBytes,
      durationMs: duration(),
      providerFallbacks: rpcResult.providerFallbacks,
    };
  }

  /**
   * Verify a signed RPC message with the configured signer (or an explicit address).
   * Used by unit tests and as a reference for firmware/viem porting.
   */
  async verify(
    message: string,
    signature: string,
    expectedAddress?: string
  ): Promise<boolean> {
    try {
      const recovered = ethers.verifyMessage(message, signature);
      const expected = expectedAddress || this.wallet?.address;
      if (!expected) return false;
      return recovered.toLowerCase() === expected.toLowerCase();
    } catch {
      return false;
    }
  }

  private async isChainSupported(chainId: number): Promise<boolean> {
    if (this.supportedChainIds === 'any') return true;
    if (Array.isArray(this.supportedChainIds)) {
      return this.supportedChainIds.includes(chainId);
    }
    // Custom mock sender without an explicit list: allow any positive chainId (unit tests).
    if (this.usingCustomSender) return true;
    try {
      const provider = await this.getProvider(chainId);
      return Boolean(provider);
    } catch {
      return false;
    }
  }

  private async getProvider(chainId: number): Promise<WaterfallRpc | null> {
    const cached = this.providerCache.get(chainId);
    if (cached) return cached;
    try {
      const provider = await WaterfallRpc.createProvider(chainId, () => {
        // Silence probe progress bar on the Pi / CI.
      });
      this.providerCache.set(chainId, provider);
      return provider;
    } catch (err) {
      console.error(
        '[SignedRpc] Failed to create provider for chain',
        chainId,
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }

  private async defaultSender(
    chainId: number,
    method: string,
    params: unknown[]
  ): Promise<{ result: unknown; blockNumber: number; providerFallbacks: number }> {
    const provider = await this.getProvider(chainId);
    if (!provider) {
      throw new Error(`No RPC provider for chainId ${chainId}`);
    }

    // Pin to a concrete block: fetch latest first, then execute at that number.
    const blockNumber = await provider.getBlockNumber();
    const blockTag = ethers.toQuantity(blockNumber);
    const pinnedParams = pinParamsToBlock(method, params, blockTag);

    // ethers JsonRpcProvider send
    const result = await provider.send(method, pinnedParams);
    return { result, blockNumber, providerFallbacks: 0 };
  }
}

/**
 * Replace "latest"/"pending"/omitted block tags with a concrete block quantity
 * so the signed blockNumber matches the executed call.
 */
export function pinParamsToBlock(
  method: string,
  params: unknown[],
  blockTag: string
): unknown[] {
  const copy = params.slice();
  switch (method) {
    case 'eth_call':
    case 'eth_getBalance':
    case 'eth_getCode': {
      if (copy.length === 0) return copy;
      if (copy.length === 1) {
        copy.push(blockTag);
      } else {
        const tag = copy[1];
        if (
          tag === undefined ||
          tag === null ||
          tag === 'latest' ||
          tag === 'pending' ||
          tag === 'safe' ||
          tag === 'finalized'
        ) {
          copy[1] = blockTag;
        }
      }
      return copy;
    }
    case 'eth_blockNumber':
    case 'eth_chainId':
    case 'eth_getTransactionReceipt':
    default:
      return copy;
  }
}

/** Encode a successful / failed TCP 0x0C response (possibly multiple chunks). */
export function encodeRpcResultPackets(
  requestId: number,
  outcome: SignedRpcOutcome
): Buffer[] {
  if (!outcome.ok) {
    const errBuf = Buffer.from(outcome.error, 'utf-8').subarray(0, 200);
    const payload = Buffer.alloc(1 + 2 + errBuf.length);
    payload[0] = outcome.status;
    payload.writeUInt16BE(errBuf.length, 1);
    errBuf.copy(payload, 3);
    return [encodeSingleChunk(requestId, outcome.status, 0, 1, payload)];
  }

  // Logical payload:
  // [block u64 BE][timestamp u32 BE][paramsHash 32][resultLen u16][result]
  // [sig 65][messageLen u16][message utf8]
  const paramsHashBytes = Buffer.from(ethers.getBytes(outcome.paramsHash));
  const resultBuf = Buffer.from(outcome.result, 'utf-8');
  const sigBuf = Buffer.from(outcome.signatureBytes);
  const msgBuf = Buffer.from(outcome.message, 'utf-8');

  const logical = Buffer.alloc(
    8 + 4 + 32 + 2 + resultBuf.length + 65 + 2 + msgBuf.length
  );
  let o = 0;
  // block as uint64 BE
  const blockHex = BigInt(outcome.blockNumber).toString(16).padStart(16, '0');
  Buffer.from(blockHex, 'hex').copy(logical, o);
  o += 8;
  logical.writeUInt32BE(outcome.timestamp >>> 0, o);
  o += 4;
  paramsHashBytes.copy(logical, o);
  o += 32;
  logical.writeUInt16BE(resultBuf.length, o);
  o += 2;
  resultBuf.copy(logical, o);
  o += resultBuf.length;
  if (sigBuf.length !== 65) {
    throw new Error('Signature must be 65 bytes');
  }
  sigBuf.copy(logical, o);
  o += 65;
  logical.writeUInt16BE(msgBuf.length, o);
  o += 2;
  msgBuf.copy(logical, o);

  const chunks: Buffer[] = [];
  const chunkCount = Math.max(1, Math.ceil(logical.length / TCP_RPC_CHUNK_PAYLOAD));
  for (let i = 0; i < chunkCount; i++) {
    const start = i * TCP_RPC_CHUNK_PAYLOAD;
    const slice = logical.subarray(start, start + TCP_RPC_CHUNK_PAYLOAD);
    chunks.push(encodeSingleChunk(requestId, RpcStatus.OK, i, chunkCount, slice));
  }
  return chunks;
}

function encodeSingleChunk(
  requestId: number,
  status: number,
  chunkIndex: number,
  chunkCount: number,
  payload: Buffer
): Buffer {
  const buf = Buffer.alloc(1 + 2 + 1 + 1 + 1 + 2 + payload.length);
  let o = 0;
  buf[o++] = OPCODE_RPC_RESULT;
  buf.writeUInt16BE(requestId & 0xffff, o);
  o += 2;
  buf[o++] = status & 0xff;
  buf[o++] = chunkIndex & 0xff;
  buf[o++] = chunkCount & 0xff;
  buf.writeUInt16BE(payload.length, o);
  o += 2;
  payload.copy(buf, o);
  return buf;
}

/**
 * Parse device → proxy 0x0B request (message without opcode byte).
 *
 * Wire:
 *   [requestId u16 BE]
 *   [chainId u32 BE]
 *   [flags u8] bit0 = custom nonce present
 *   [methodLen u8][method]
 *   [paramsLen u16 BE][params utf8 JSON array]
 *   if flags&1: [nonceLen u8][nonce bytes]
 */
export function parseRpcCallRequest(message: Buffer): {
  requestId: number;
  chainId: number;
  method: string;
  params: unknown[];
  customNonce?: Buffer;
} | null {
  if (message.length < 2 + 4 + 1 + 1 + 2) return null;
  let o = 0;
  const requestId = message.readUInt16BE(o);
  o += 2;
  const chainId = message.readUInt32BE(o);
  o += 4;
  const flags = message[o++];
  const methodLen = message[o++];
  if (message.length < o + methodLen + 2) return null;
  const method = message.subarray(o, o + methodLen).toString('utf-8');
  o += methodLen;
  const paramsLen = message.readUInt16BE(o);
  o += 2;
  if (paramsLen > TCP_RPC_MAX_PARAMS_BYTES) return null;
  if (message.length < o + paramsLen) return null;
  const paramsRaw = message.subarray(o, o + paramsLen).toString('utf-8');
  o += paramsLen;

  let params: unknown[];
  try {
    const parsed = JSON.parse(paramsRaw || '[]');
    if (!Array.isArray(parsed)) return null;
    params = parsed;
  } catch {
    return null;
  }

  let customNonce: Buffer | undefined;
  if (flags & 0x01) {
    if (message.length < o + 1) return null;
    const nonceLen = message[o++];
    if (message.length < o + nonceLen) return null;
    customNonce = Buffer.from(message.subarray(o, o + nonceLen));
  }

  return { requestId, chainId, method, params, customNonce };
}

/** Encode a 0x0B request (for tests / docs). */
export function encodeRpcCallRequest(fields: {
  requestId: number;
  chainId: number;
  method: string;
  params: unknown[];
  customNonce?: Buffer;
}): Buffer {
  const methodBuf = Buffer.from(fields.method, 'utf-8').subarray(0, 255);
  const paramsBuf = Buffer.from(canonicalJson(fields.params), 'utf-8');
  const hasNonce = Boolean(fields.customNonce && fields.customNonce.length);
  const nonceBuf = hasNonce ? fields.customNonce!.subarray(0, 255) : Buffer.alloc(0);
  const buf = Buffer.alloc(
    1 + 2 + 4 + 1 + 1 + methodBuf.length + 2 + paramsBuf.length + (hasNonce ? 1 + nonceBuf.length : 0)
  );
  let o = 0;
  buf[o++] = OPCODE_RPC_CALL;
  buf.writeUInt16BE(fields.requestId & 0xffff, o);
  o += 2;
  buf.writeUInt32BE(fields.chainId >>> 0, o);
  o += 4;
  buf[o++] = hasNonce ? 0x01 : 0x00;
  buf[o++] = methodBuf.length;
  methodBuf.copy(buf, o);
  o += methodBuf.length;
  buf.writeUInt16BE(paramsBuf.length, o);
  o += 2;
  paramsBuf.copy(buf, o);
  o += paramsBuf.length;
  if (hasNonce) {
    buf[o++] = nonceBuf.length;
    nonceBuf.copy(buf, o);
  }
  return buf;
}
