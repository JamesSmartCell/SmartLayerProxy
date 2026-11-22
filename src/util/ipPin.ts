/**
 * Session IP pinning: after a successful ESP login, bind the TCP session to the
 * resolved real client IP. Subsequent commands / re-auth on that session must
 * match; a fresh full login on a new connection re-pins.
 *
 * Loopback / empty IPs (legacy tunnel without PROXY) are not enforceable.
 */

import { normalizeIp } from './ip';

export type IpPinMode = 'off' | 'log' | 'enforce';

export function parseIpPinMode(value?: string | null): IpPinMode {
  const v = (value || 'log').toLowerCase().trim();
  if (v === 'off' || v === 'false' || v === '0' || v === 'disabled') return 'off';
  if (v === 'enforce' || v === 'strict' || v === 'on' || v === 'true' || v === '1') return 'enforce';
  return 'log';
}

export function isLoopbackIp(ip: string | undefined | null): boolean {
  const n = normalizeIp(ip);
  return n === '127.0.0.1' || n === '::1';
}

/** Empty or loopback — cannot enforce pinning (legacy path without PROXY). */
export function isUnenforceableIp(ip: string | undefined | null): boolean {
  const n = normalizeIp(ip);
  return !n || isLoopbackIp(n);
}

export type IpPinDecision =
  | { action: 'skip'; reason: 'mode_off' }
  | { action: 'skip'; reason: 'no_pin' }
  | { action: 'skip'; reason: 'unenforceable'; currentIp: string }
  | { action: 'allow'; pinnedIp: string; currentIp: string }
  | {
      action: 'violation';
      mode: 'log' | 'enforce';
      pinnedIp: string;
      currentIp: string;
      reject: boolean;
    };

/**
 * Evaluate whether the current resolved IP matches the session pin.
 * - mode off → skip
 * - no pin yet → skip (caller pins on successful login)
 * - unenforceable current IP → skip (legacy)
 * - match → allow
 * - mismatch → violation (reject only when mode=enforce)
 */
export function evaluateSessionIpPin(options: {
  mode: IpPinMode;
  pinnedIp: string | undefined | null;
  currentIp: string | undefined | null;
}): IpPinDecision {
  if (options.mode === 'off') {
    return { action: 'skip', reason: 'mode_off' };
  }

  const pinned = normalizeIp(options.pinnedIp);
  if (!pinned) {
    return { action: 'skip', reason: 'no_pin' };
  }

  const current = normalizeIp(options.currentIp);
  if (isUnenforceableIp(current)) {
    return { action: 'skip', reason: 'unenforceable', currentIp: current || '' };
  }

  if (pinned === current) {
    return { action: 'allow', pinnedIp: pinned, currentIp: current };
  }

  return {
    action: 'violation',
    mode: options.mode,
    pinnedIp: pinned,
    currentIp: current,
    reject: options.mode === 'enforce',
  };
}

/**
 * Decide whether to store a pin after successful auth.
 * Returns the normalized IP to pin, or null when pinning should be skipped.
 */
export function resolvePinOnLogin(
  currentIp: string | undefined | null
): { pin: string } | { skip: true; reason: 'unenforceable'; currentIp: string } {
  const current = normalizeIp(currentIp);
  if (isUnenforceableIp(current)) {
    return { skip: true, reason: 'unenforceable', currentIp: current || '' };
  }
  return { pin: current };
}

/**
 * Handshake / command log suffix: `#0 ip=144.6.2.81`
 * Uses the resolved client IP when known; otherwise the socket peer so lines
 * never omit an IP.
 */
export function formatConnectionIpLog(
  index: number,
  resolvedIp: string | undefined | null,
  peerIp?: string | undefined | null
): string {
  const ip = normalizeIp(resolvedIp) || normalizeIp(peerIp) || '?';
  return `#${index} ip=${ip}`;
}
