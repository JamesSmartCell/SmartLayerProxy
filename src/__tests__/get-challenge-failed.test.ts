import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync } from 'fs';
import { TelemetryService } from '../service/TelemetryService';

const TEST_DB = './test-get-challenge-failed.db';

describe('get_challenge_failed telemetry', () => {
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

  it('stores failure reason, IP, duration, and rolling counts', () => {
    telemetry.recordGetChallengeFailed({
      address: '0xAbc123',
      ipAddress: '198.51.100.9',
      reason: 'device_offline',
      durationMs: 12,
      project: 'garage-door',
      requests60s: 4,
      requests10m: 11,
    });

    const { events } = telemetry.getEvents({ limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('get_challenge_failed');
    expect(events[0].device).toBe('0xabc123');
    expect(events[0].ipAddress).toBe('198.51.100.9');
    expect(events[0].failureReason).toBe('device_offline');
    expect(events[0].apiResponseTime).toBe(12);
    expect(events[0].firmwareProject).toBe('garage-door');
    expect(events[0].requests60s).toBe(4);
    expect(events[0].requests10m).toBe(11);
    expect(events[0].apiMethod).toBe('getChallenge');
    expect(events[0].apiSuccess).toBe(false);
  });

  it('recordApiCall stores client IP', () => {
    telemetry.recordApiCall('0xabc', 'getChallenge', true, 40, '203.0.113.1');
    const { events } = telemetry.getEvents({ limit: 5 });
    expect(events[0].ipAddress).toBe('203.0.113.1');
    expect(events[0].apiSuccess).toBe(true);
  });

  it('disconnect and diagnostics store IP', () => {
    telemetry.recordDeviceConnection('0xabc', 'TCP', '10.0.0.9');
    telemetry.recordDeviceDiagnostics('0xabc', { resetReason: 'POWERON', bootCount: 1 }, '10.0.0.9');
    telemetry.recordDeviceDisconnect('0xabc', 'client_close', '10.0.0.9');

    const { events } = telemetry.getEvents({ limit: 10 });
    const disconnect = events.find(e => e.eventType === 'disconnect');
    expect(disconnect?.ipAddress).toBe('10.0.0.9');

    const diag = telemetry.getLatestDiagnostics('0xabc');
    expect(diag?.ipAddress).toBe('10.0.0.9');
  });
});
