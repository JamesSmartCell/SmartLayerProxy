/**
 * Optional PROXY protocol (v1 text / v2 binary) parser for the TCP bridge.
 *
 * When the immediate peer is trusted, the first bytes of a connection may be a
 * PROXY header carrying the real client IP. If absent, the buffered bytes are
 * returned as leftover application data (direct connections keep working).
 */

import type { Socket } from 'net';
import { normalizeIp } from './ip';

/** HAProxy v1 max header length (incl. CRLF). */
export const PROXY_V1_MAX_LEN = 107;
/** v2 signature + fixed header; address block is additional. Cap total header. */
export const PROXY_V2_MAX_LEN = 232;
export const PROXY_HEADER_MAX_LEN = PROXY_V2_MAX_LEN;

const PROXY_V1_PREFIX = Buffer.from('PROXY ', 'ascii');
/** \r\n\r\n\0\r\nQUIT\n */
const PROXY_V2_SIG = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);

export type ProxyProtocolUntrustedAction = 'ignore' | 'reject';

export interface ProxyParseResult {
  /** True when a complete PROXY header was parsed. */
  present: boolean;
  /** Source (client) IP from the header, normalized. */
  clientIp?: string;
  /** Source port when available. */
  clientPort?: number;
  /** Bytes after the PROXY header (application data that arrived with it). */
  leftover: Buffer;
  /** Protocol version when present. */
  version?: 1 | 2;
}

export type ProxyParseIncomplete = { incomplete: true };
export type ProxyParseOutcome = ProxyParseResult | ProxyParseIncomplete;

export class ProxyProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyProtocolError';
  }
}

function startsWith(buf: Buffer, prefix: Buffer): boolean {
  if (buf.length < prefix.length) {
    return prefix.subarray(0, buf.length).equals(buf);
  }
  return buf.subarray(0, prefix.length).equals(prefix);
}

function couldBeV1(buf: Buffer): boolean {
  return startsWith(buf, PROXY_V1_PREFIX);
}

function couldBeV2(buf: Buffer): boolean {
  return startsWith(buf, PROXY_V2_SIG);
}

function isDefinitelyNotProxy(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  if (couldBeV1(buf) || couldBeV2(buf)) return false;
  // Enough bytes to know it is neither prefix
  if (buf.length >= PROXY_V1_PREFIX.length && !buf.subarray(0, PROXY_V1_PREFIX.length).equals(PROXY_V1_PREFIX)
    && buf.length >= PROXY_V2_SIG.length && !buf.subarray(0, PROXY_V2_SIG.length).equals(PROXY_V2_SIG)) {
    return true;
  }
  if (buf.length >= PROXY_V1_PREFIX.length && !couldBeV1(buf) && !couldBeV2(buf)) {
    return true;
  }
  // First byte alone: PROXY v1 starts with 'P' (0x50); v2 with 0x0d
  if (buf[0] !== 0x50 && buf[0] !== 0x0d) return true;
  return false;
}

/**
 * Try to parse a PROXY header from a buffer. Returns `incomplete` if more
 * bytes are needed; throws ProxyProtocolError on malformed complete-looking data.
 */
export function tryParseProxyHeader(buffer: Buffer): ProxyParseOutcome {
  if (buffer.length === 0) {
    return { incomplete: true };
  }

  if (isDefinitelyNotProxy(buffer)) {
    return { present: false, leftover: buffer };
  }

  if (couldBeV2(buffer) && (buffer.length >= PROXY_V2_SIG.length || buffer[0] === 0x0d)) {
    if (buffer.length < PROXY_V2_SIG.length) {
      return { incomplete: true };
    }
    if (!buffer.subarray(0, PROXY_V2_SIG.length).equals(PROXY_V2_SIG)) {
      // Started like \r but not v2 — if also not v1, treat as app data
      if (!couldBeV1(buffer)) {
        return { present: false, leftover: buffer };
      }
    } else {
      return parseV2(buffer);
    }
  }

  if (couldBeV1(buffer)) {
    return parseV1(buffer);
  }

  return { incomplete: true };
}

function parseV1(buffer: Buffer): ProxyParseOutcome {
  if (buffer.length > PROXY_V1_MAX_LEN) {
    // Look for CRLF within the max window
    const window = buffer.subarray(0, PROXY_V1_MAX_LEN);
    const crlf = window.indexOf('\r\n');
    if (crlf < 0) {
      throw new ProxyProtocolError('PROXY v1 header exceeds max length without CRLF');
    }
  }

  const crlf = buffer.indexOf('\r\n');
  if (crlf < 0) {
    if (buffer.length >= PROXY_V1_MAX_LEN) {
      throw new ProxyProtocolError('PROXY v1 header missing CRLF within max length');
    }
    return { incomplete: true };
  }

  if (crlf + 2 > PROXY_V1_MAX_LEN) {
    throw new ProxyProtocolError('PROXY v1 header too long');
  }

  const line = buffer.subarray(0, crlf).toString('ascii');
  const leftover = buffer.subarray(crlf + 2);
  const parts = line.split(' ');

  // PROXY UNKNOWN\r\n  or  PROXY TCP4/TCP6 src dst sport dport
  if (parts[0] !== 'PROXY') {
    throw new ProxyProtocolError('PROXY v1: invalid prefix');
  }

  if (parts[1] === 'UNKNOWN') {
    return { present: true, version: 1, leftover };
  }

  if (parts.length < 6) {
    throw new ProxyProtocolError('PROXY v1: expected at least 6 fields');
  }

  const family = parts[1];
  if (family !== 'TCP4' && family !== 'TCP6') {
    throw new ProxyProtocolError(`PROXY v1: unsupported family ${family}`);
  }

  const srcIp = normalizeIp(parts[2]);
  const srcPort = parseInt(parts[4], 10);
  if (!srcIp) {
    throw new ProxyProtocolError('PROXY v1: empty source address');
  }
  if (!Number.isFinite(srcPort) || srcPort < 0 || srcPort > 65535) {
    throw new ProxyProtocolError('PROXY v1: invalid source port');
  }

  return {
    present: true,
    version: 1,
    clientIp: srcIp,
    clientPort: srcPort,
    leftover,
  };
}

function parseV2(buffer: Buffer): ProxyParseOutcome {
  if (buffer.length < 16) {
    return { incomplete: true };
  }

  const verCmd = buffer[12];
  const version = verCmd >> 4;
  if (version !== 0x2) {
    throw new ProxyProtocolError(`PROXY v2: bad version ${version}`);
  }

  const cmd = verCmd & 0x0f;
  const familyByte = buffer[13];
  const addrLen = buffer.readUInt16BE(14);
  const totalLen = 16 + addrLen;

  if (totalLen > PROXY_V2_MAX_LEN) {
    throw new ProxyProtocolError('PROXY v2 header exceeds max length');
  }
  if (buffer.length < totalLen) {
    return { incomplete: true };
  }

  const leftover = buffer.subarray(totalLen);

  // LOCAL command: no address rewrite
  if (cmd === 0x0) {
    return { present: true, version: 2, leftover };
  }
  if (cmd !== 0x1) {
    throw new ProxyProtocolError(`PROXY v2: unsupported command ${cmd}`);
  }

  const family = familyByte >> 4;
  const transport = familyByte & 0x0f;
  // transport 1 = STREAM (TCP); 0 = UNSPEC
  if (transport !== 0x1 && transport !== 0x0) {
    // Still accept and try to parse common families
  }

  let clientIp: string | undefined;
  let clientPort: number | undefined;

  if (family === 0x1) {
    // AF_INET: 4 + 4 + 2 + 2
    if (addrLen < 12) {
      throw new ProxyProtocolError('PROXY v2: IPv4 address block too short');
    }
    clientIp = normalizeIp(
      `${buffer[16]}.${buffer[17]}.${buffer[18]}.${buffer[19]}`
    );
    clientPort = buffer.readUInt16BE(24);
  } else if (family === 0x2) {
    // AF_INET6: 16 + 16 + 2 + 2
    if (addrLen < 36) {
      throw new ProxyProtocolError('PROXY v2: IPv6 address block too short');
    }
    const parts: string[] = [];
    for (let i = 0; i < 8; i++) {
      parts.push(buffer.readUInt16BE(16 + i * 2).toString(16));
    }
    clientIp = normalizeIp(parts.join(':'));
    clientPort = buffer.readUInt16BE(16 + 32);
  } else if (family === 0x0) {
    // UNSPEC
    return { present: true, version: 2, leftover };
  } else {
    // UNIX or unknown — accept header but no IP rewrite
    return { present: true, version: 2, leftover };
  }

  return {
    present: true,
    version: 2,
    clientIp,
    clientPort,
    leftover,
  };
}

export interface ResolveProxyOptions {
  /** Milliseconds to wait for a complete header (default 500). */
  timeoutMs?: number;
  /** Max header bytes (default PROXY_HEADER_MAX_LEN). */
  maxLength?: number;
}

/**
 * Read optional PROXY header from a newly accepted socket.
 * Resolves with leftover application data (possibly empty).
 */
export function resolveProxyProtocol(
  socket: Socket,
  options: ResolveProxyOptions = {}
): Promise<ProxyParseResult> {
  const timeoutMs = options.timeoutMs ?? 500;
  const maxLength = options.maxLength ?? PROXY_HEADER_MAX_LEN;

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;

    // Hold the stream paused after we finish so leftover + further bytes are not
    // dropped between our listener cleanup and TCPClient.start / socket.resume().
    socket.pause();

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      clearTimeout(timer);
      socket.pause();
    };

    const finish = (result: ProxyParseResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxLength) {
        const probe = tryParseProxyHeader(buffer);
        if ('incomplete' in probe && probe.incomplete) {
          fail(new ProxyProtocolError('PROXY header exceeds max length'));
          return;
        }
      }
      try {
        const outcome = tryParseProxyHeader(buffer);
        if ('incomplete' in outcome && outcome.incomplete) {
          if (buffer.length > maxLength) {
            fail(new ProxyProtocolError('PROXY header exceeds max length'));
          }
          return;
        }
        finish(outcome as ProxyParseResult);
      } catch (err) {
        fail(err instanceof Error ? err : new ProxyProtocolError(String(err)));
      }
    };

    const onError = (err: Error) => fail(err);
    const onClose = () => {
      if (!settled) {
        finish({ present: false, leftover: buffer });
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      try {
        const outcome = tryParseProxyHeader(buffer);
        if ('incomplete' in outcome && outcome.incomplete) {
          if (buffer.length > 0 && (couldBeV1(buffer) || couldBeV2(buffer))) {
            fail(new ProxyProtocolError('PROXY header read timed out'));
            return;
          }
          finish({ present: false, leftover: buffer });
          return;
        }
        finish(outcome as ProxyParseResult);
      } catch (err) {
        fail(err instanceof Error ? err : new ProxyProtocolError(String(err)));
      }
    }, timeoutMs);

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.resume();
  });
}

/**
 * Feed already-buffered chunks through the parser (for unit tests / split chunks).
 */
export function parseProxyHeaderFromChunks(chunks: Buffer[]): ProxyParseOutcome {
  let buffer = Buffer.alloc(0);
  let last: ProxyParseOutcome = { incomplete: true };
  for (const chunk of chunks) {
    buffer = Buffer.concat([buffer, chunk]);
    last = tryParseProxyHeader(buffer);
    if (!('incomplete' in last && last.incomplete)) {
      return last;
    }
  }
  return last;
}
