/**
 * Client IP helpers: normalize addresses, trusted-proxy checks, XFF derivation,
 * and a lightweight in-memory per-IP rate counter for flood spotting.
 */

import type { IncomingMessage } from 'http';

export const DEFAULT_TRUSTED_PROXIES = ['127.0.0.1', '::1'];

export function normalizeIp(ip: string | undefined | null): string {
  if (!ip) return '';
  return ip.replace(/^::ffff:/i, '').toLowerCase();
}

export function parseTrustedProxies(value?: string | null): string[] {
  if (value === undefined || value === null || value.trim() === '') {
    return [...DEFAULT_TRUSTED_PROXIES];
  }
  return value
    .split(',')
    .map((p) => normalizeIp(p.trim()))
    .filter((p) => p.length > 0);
}

export function isTrustedProxyPeer(
  peerIp: string | undefined | null,
  trusted: string[] = DEFAULT_TRUSTED_PROXIES
): boolean {
  const peer = normalizeIp(peerIp);
  if (!peer) return false;
  return trusted.some((t) => t === peer);
}

/**
 * Leftmost X-Forwarded-For entry, or CF-Connecting-IP, when present and non-empty.
 */
export function leftmostForwardedIp(
  headers: Record<string, string | string[] | undefined> | {
    get?(name: string): string | undefined;
  }
): string | undefined {
  const get = (name: string): string | undefined => {
    if (typeof (headers as { get?(n: string): string | undefined }).get === 'function') {
      return (headers as { get(n: string): string | undefined }).get(name) ?? undefined;
    }
    const raw = (headers as Record<string, string | string[] | undefined>)[name]
      ?? (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
    if (Array.isArray(raw)) return raw[0];
    return raw;
  };

  const forwardedFor = get('x-forwarded-for') || get('X-Forwarded-For');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return normalizeIp(first);
  }

  const cf = get('cf-connecting-ip') || get('CF-Connecting-IP');
  if (cf?.trim()) return normalizeIp(cf.trim());

  return undefined;
}

export interface DeriveClientIpOptions {
  /** Immediate TCP peer (socket.remoteAddress). */
  peerIp: string | undefined | null;
  /** Parsed trusted proxy list (default loopback). */
  trustedProxies?: string[];
  /**
   * Legacy TRUST_PROXY=true: trust XFF from any peer.
   * When false, XFF is only used if the peer is in trustedProxies.
   */
  trustProxy?: boolean;
  headers: Record<string, string | string[] | undefined> | {
    get?(name: string): string | undefined;
  };
}

/**
 * Real client IP for HTTP telemetry:
 * - If peer is a trusted proxy (or trustProxy is true), use leftmost XFF / CF-Connecting-IP.
 * - Otherwise use the socket peer address.
 */
export function deriveHttpClientIp(options: DeriveClientIpOptions): string {
  const peer = normalizeIp(options.peerIp);
  const trusted = options.trustedProxies ?? DEFAULT_TRUSTED_PROXIES;
  const allowForwarded = options.trustProxy === true || isTrustedProxyPeer(peer, trusted);

  if (allowForwarded) {
    const forwarded = leftmostForwardedIp(options.headers);
    if (forwarded) return forwarded;
  }

  return peer;
}

/** Convenience for Express / Node IncomingMessage. */
export function deriveHttpClientIpFromRequest(
  req: IncomingMessage,
  options: Omit<DeriveClientIpOptions, 'peerIp' | 'headers'> = {}
): string {
  return deriveHttpClientIp({
    peerIp: req.socket?.remoteAddress,
    headers: {
      get: (name: string) => {
        const v = req.headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      },
    },
    ...options,
  });
}

/**
 * Rolling per-IP request timestamps for flood detection (in-memory only).
 */
export class IpRateCounter {
  private timestamps = new Map<string, number[]>();
  private readonly maxAgeMs: number;

  constructor(maxAgeMs = 10 * 60 * 1000) {
    this.maxAgeMs = maxAgeMs;
  }

  record(ip: string, now = Date.now()): { last60s: number; last10m: number } {
    const key = normalizeIp(ip) || 'unknown';
    let arr = this.timestamps.get(key) || [];
    arr.push(now);
    const cutoff = now - this.maxAgeMs;
    arr = arr.filter((t) => t >= cutoff);
    this.timestamps.set(key, arr);

    const last60s = arr.filter((t) => now - t <= 60_000).length;
    return { last60s, last10m: arr.length };
  }

  /** Test helper */
  clear(): void {
    this.timestamps.clear();
  }

  size(): number {
    return this.timestamps.size;
  }
}
