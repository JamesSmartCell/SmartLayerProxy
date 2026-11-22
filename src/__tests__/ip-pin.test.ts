import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync } from 'fs';
import {
  parseIpPinMode,
  isLoopbackIp,
  isUnenforceableIp,
  evaluateSessionIpPin,
  resolvePinOnLogin,
  formatConnectionIpLog,
} from '../util/ipPin';
import { TelemetryService } from '../service/TelemetryService';

const TEST_DB = './test-ip-pin.db';

describe('parseIpPinMode', () => {
  it('defaults to log', () => {
    expect(parseIpPinMode(undefined)).toBe('log');
    expect(parseIpPinMode('')).toBe('log');
    expect(parseIpPinMode('nonsense')).toBe('log');
  });

  it('parses off / enforce aliases', () => {
    expect(parseIpPinMode('off')).toBe('off');
    expect(parseIpPinMode('OFF')).toBe('off');
    expect(parseIpPinMode('disabled')).toBe('off');
    expect(parseIpPinMode('enforce')).toBe('enforce');
    expect(parseIpPinMode('strict')).toBe('enforce');
    expect(parseIpPinMode('on')).toBe('enforce');
  });
});

describe('loopback / unenforceable', () => {
  it('detects loopback IPv4 and IPv6', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('::1')).toBe(true);
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackIp('144.6.2.81')).toBe(false);
  });

  it('treats empty and loopback as unenforceable', () => {
    expect(isUnenforceableIp('')).toBe(true);
    expect(isUnenforceableIp(null)).toBe(true);
    expect(isUnenforceableIp('127.0.0.1')).toBe(true);
    expect(isUnenforceableIp('203.0.113.10')).toBe(false);
  });
});

describe('resolvePinOnLogin', () => {
  it('pins real client IPs', () => {
    expect(resolvePinOnLogin('144.6.2.81')).toEqual({ pin: '144.6.2.81' });
    expect(resolvePinOnLogin('::ffff:198.51.100.7')).toEqual({ pin: '198.51.100.7' });
  });

  it('skips loopback/unknown (legacy tunnel without PROXY)', () => {
    expect(resolvePinOnLogin('127.0.0.1')).toMatchObject({
      skip: true,
      reason: 'unenforceable',
    });
    expect(resolvePinOnLogin('::1')).toMatchObject({ skip: true });
    expect(resolvePinOnLogin('')).toMatchObject({ skip: true });
  });
});

describe('evaluateSessionIpPin', () => {
  it('skips when mode is off', () => {
    expect(
      evaluateSessionIpPin({
        mode: 'off',
        pinnedIp: '1.2.3.4',
        currentIp: '5.6.7.8',
      })
    ).toEqual({ action: 'skip', reason: 'mode_off' });
  });

  it('skips when no pin is set yet', () => {
    expect(
      evaluateSessionIpPin({
        mode: 'enforce',
        pinnedIp: undefined,
        currentIp: '1.2.3.4',
      })
    ).toEqual({ action: 'skip', reason: 'no_pin' });
  });

  it('allows same IP', () => {
    expect(
      evaluateSessionIpPin({
        mode: 'enforce',
        pinnedIp: '203.0.113.10',
        currentIp: '203.0.113.10',
      })
    ).toEqual({
      action: 'allow',
      pinnedIp: '203.0.113.10',
      currentIp: '203.0.113.10',
    });
  });

  it('allows same IP ignoring IPv4-mapped prefix', () => {
    expect(
      evaluateSessionIpPin({
        mode: 'log',
        pinnedIp: '203.0.113.10',
        currentIp: '::ffff:203.0.113.10',
      }).action
    ).toBe('allow');
  });

  it('logs (does not reject) on mismatch in log mode', () => {
    const d = evaluateSessionIpPin({
      mode: 'log',
      pinnedIp: '203.0.113.10',
      currentIp: '198.51.100.1',
    });
    expect(d).toEqual({
      action: 'violation',
      mode: 'log',
      pinnedIp: '203.0.113.10',
      currentIp: '198.51.100.1',
      reject: false,
    });
  });

  it('rejects on mismatch in enforce mode', () => {
    const d = evaluateSessionIpPin({
      mode: 'enforce',
      pinnedIp: '203.0.113.10',
      currentIp: '198.51.100.1',
    });
    expect(d).toMatchObject({
      action: 'violation',
      mode: 'enforce',
      reject: true,
    });
  });

  it('skips enforcement when current IP is loopback (legacy)', () => {
    expect(
      evaluateSessionIpPin({
        mode: 'enforce',
        pinnedIp: '203.0.113.10',
        currentIp: '127.0.0.1',
      })
    ).toMatchObject({ action: 'skip', reason: 'unenforceable' });
  });
});

describe('session pin lifecycle (re-pin on new login)', () => {
  it('same IP allowed after pin; different IP violates; new login re-pins', () => {
    let pinned: string | undefined;

    const login = (ip: string) => {
      const r = resolvePinOnLogin(ip);
      pinned = 'pin' in r ? r.pin : undefined;
    };

    const check = (ip: string, mode: 'log' | 'enforce' = 'enforce') =>
      evaluateSessionIpPin({ mode, pinnedIp: pinned, currentIp: ip });

    login('144.6.2.81');
    expect(pinned).toBe('144.6.2.81');
    expect(check('144.6.2.81').action).toBe('allow');
    expect(check('198.51.100.9')).toMatchObject({ action: 'violation', reject: true });

    // Fresh full login on a new connection from a new ISP IP re-pins.
    login('198.51.100.9');
    expect(pinned).toBe('198.51.100.9');
    expect(check('198.51.100.9').action).toBe('allow');
    expect(check('144.6.2.81')).toMatchObject({ action: 'violation' });
  });

  it('loopback login leaves session unpinned so commands are not blocked', () => {
    let pinned: string | undefined;
    const r = resolvePinOnLogin('::1');
    pinned = 'pin' in r ? r.pin : undefined;
    expect(pinned).toBeUndefined();
    expect(
      evaluateSessionIpPin({
        mode: 'enforce',
        pinnedIp: pinned,
        currentIp: '::1',
      }).action
    ).toBe('skip');
  });
});

describe('formatConnectionIpLog', () => {
  it('shows resolved IP only (no peer parenthetical)', () => {
    expect(formatConnectionIpLog(0, '144.6.2.81', '::1')).toBe('#0 ip=144.6.2.81');
    expect(formatConnectionIpLog(3, '203.0.113.1', '127.0.0.1')).toBe(
      '#3 ip=203.0.113.1'
    );
  });

  it('prints resolved IP when it equals peer', () => {
    expect(formatConnectionIpLog(1, '10.0.0.5', '10.0.0.5')).toBe('#1 ip=10.0.0.5');
    expect(formatConnectionIpLog(2, '10.0.0.5')).toBe('#2 ip=10.0.0.5');
  });

  it('falls back to socket peer when resolved IP is missing', () => {
    expect(formatConnectionIpLog(0, '', '::1')).toBe('#0 ip=::1');
    expect(formatConnectionIpLog(1, '', '127.0.0.1')).toBe('#1 ip=127.0.0.1');
  });

  it('uses ? only when both resolved and peer are missing', () => {
    expect(formatConnectionIpLog(0, '', '')).toBe('#0 ip=?');
    expect(formatConnectionIpLog(2, undefined)).toBe('#2 ip=?');
  });
});

describe('ip_pin_violation telemetry', () => {
  let telemetry: TelemetryService;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    TelemetryService.resetInstance();
    telemetry = TelemetryService.getInstance(TEST_DB, 30);
  });

  afterEach(() => {
    telemetry.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('stores device, project, pinned IP, offending IP, opcode, connection id', () => {
    telemetry.recordIpPinViolation({
      address: '0xAbC123',
      project: 'garage-door',
      pinnedIp: '144.6.2.81',
      offendingIp: '198.51.100.9',
      opcodeOrMethod: '0x05-response',
      connectionId: 7,
      mode: 'log',
    });

    const { events } = telemetry.getEvents({ limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('ip_pin_violation');
    expect(events[0].device).toBe('0xabc123');
    expect(events[0].firmwareProject).toBe('garage-door');
    expect(events[0].ipAddress).toBe('198.51.100.9');
    expect(events[0].apiMethod).toBe('0x05-response');
    expect(events[0].apiSuccess).toBe(false);
    expect(events[0].failureReason).toBe('pinned=144.6.2.81;conn=#7;mode=log');
  });
});
