import { describe, it, expect } from 'vitest';
import {
  deriveHttpClientIp,
  leftmostForwardedIp,
  normalizeIp,
  IpRateCounter,
  DEFAULT_TRUSTED_PROXIES,
} from '../util/ip';

describe('HTTP client IP derivation (XFF)', () => {
  it('uses socket peer when not a trusted proxy', () => {
    const ip = deriveHttpClientIp({
      peerIp: '203.0.113.50',
      headers: { 'x-forwarded-for': '198.51.100.1' },
      trustedProxies: DEFAULT_TRUSTED_PROXIES,
      trustProxy: false,
    });
    expect(ip).toBe('203.0.113.50');
  });

  it('uses leftmost XFF when peer is loopback', () => {
    const ip = deriveHttpClientIp({
      peerIp: '127.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
      trustedProxies: DEFAULT_TRUSTED_PROXIES,
      trustProxy: false,
    });
    expect(ip).toBe('198.51.100.7');
  });

  it('uses leftmost XFF when peer is ::1', () => {
    const ip = deriveHttpClientIp({
      peerIp: '::1',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('strips IPv4-mapped IPv6 on peer before trust check', () => {
    const ip = deriveHttpClientIp({
      peerIp: '::ffff:127.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.2' },
    });
    expect(ip).toBe('198.51.100.2');
  });

  it('falls back to peer when trusted but no XFF', () => {
    const ip = deriveHttpClientIp({
      peerIp: '127.0.0.1',
      headers: {},
    });
    expect(ip).toBe('127.0.0.1');
  });

  it('TRUST_PROXY=true trusts XFF from any peer (legacy)', () => {
    const ip = deriveHttpClientIp({
      peerIp: '10.0.0.5',
      headers: { 'x-forwarded-for': '198.51.100.3' },
      trustProxy: true,
    });
    expect(ip).toBe('198.51.100.3');
  });

  it('prefers CF-Connecting-IP when XFF absent', () => {
    expect(
      leftmostForwardedIp({ 'cf-connecting-ip': '198.51.100.4' })
    ).toBe('198.51.100.4');
  });

  it('normalizeIp strips mapped prefix', () => {
    expect(normalizeIp('::ffff:192.168.1.1')).toBe('192.168.1.1');
  });
});

describe('IpRateCounter', () => {
  it('counts requests in 60s and 10m windows', () => {
    const counter = new IpRateCounter();
    const t0 = 1_700_000_000_000;
    expect(counter.record('1.2.3.4', t0)).toEqual({ last60s: 1, last10m: 1 });
    expect(counter.record('1.2.3.4', t0 + 30_000)).toEqual({ last60s: 2, last10m: 2 });
    expect(counter.record('1.2.3.4', t0 + 120_000)).toEqual({ last60s: 1, last10m: 3 });
    // Far enough that prior samples (including t0+120s) fall outside the 10m window
    expect(counter.record('1.2.3.4', t0 + 120_000 + 10 * 60_000 + 1)).toEqual({ last60s: 1, last10m: 1 });
  });
});

