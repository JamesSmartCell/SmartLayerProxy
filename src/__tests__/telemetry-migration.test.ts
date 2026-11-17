import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TelemetryService } from '../service/TelemetryService';
import { unlinkSync, existsSync } from 'fs';
import Database from 'better-sqlite3';

const TEST_DB_PATH = './test-migration-telemetry.db';

describe('TelemetryService Schema Migration', () => {
  afterEach(() => {
    TelemetryService.resetInstance();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  it('should migrate old schema (pre-PR#2) to add firmware_version column', () => {
    // Create a database with the OLD schema (no firmware_version)
    const oldDb = new Database(TEST_DB_PATH);
    oldDb.exec(`
      CREATE TABLE device_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        device TEXT NOT NULL,
        event_type TEXT NOT NULL,
        protocol TEXT,
        disconnect_reason TEXT,
        api_method TEXT,
        api_success INTEGER,
        api_response_time INTEGER,
        ip_address TEXT
      );

      CREATE INDEX idx_device_timestamp ON device_events(device, timestamp);
      CREATE INDEX idx_timestamp ON device_events(timestamp);
      CREATE INDEX idx_event_type ON device_events(event_type);
      CREATE INDEX idx_id ON device_events(id);
    `);

    // Insert a row with old schema
    oldDb.prepare(`
      INSERT INTO device_events (timestamp, device, event_type, protocol, ip_address)
      VALUES (?, ?, ?, ?, ?)
    `).run(Date.now(), '0xabc123', 'connect', 'UDP', '192.168.1.1');

    oldDb.close();

    // Now open with TelemetryService (should auto-migrate)
    const service = TelemetryService.getInstance(TEST_DB_PATH);

    // Verify firmware_version column exists
    const columns = service['db'].prepare('PRAGMA table_info(device_events)').all() as Array<{ name: string }>;
    const columnNames = columns.map(c => c.name);
    expect(columnNames).toContain('firmware_version');

    // Verify we can insert with firmware_version
    service.recordDeviceConnection('0xdef456', 'TCP', '192.168.1.2', 'v1.2.3');

    // Verify both rows exist
    const rows = service['db'].prepare('SELECT * FROM device_events ORDER BY id').all() as any[];
    expect(rows).toHaveLength(2);

    // Old row should have NULL firmware_version
    expect(rows[0].firmware_version).toBeNull();
    expect(rows[0].device).toBe('0xabc123');

    // New row should have firmware_version
    expect(rows[1].firmware_version).toBe('v1.2.3');
    expect(rows[1].device).toBe('0xdef456');

    service.close();
  });

  it('should be idempotent (safe to run migration multiple times)', () => {
    // Create database with old schema
    const oldDb = new Database(TEST_DB_PATH);
    oldDb.exec(`
      CREATE TABLE device_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        device TEXT NOT NULL,
        event_type TEXT NOT NULL
      );
    `);
    oldDb.close();

    // First init (migrates)
    let service = TelemetryService.getInstance(TEST_DB_PATH);
    service.close();
    TelemetryService.resetInstance();

    // Second init (should not fail)
    service = TelemetryService.getInstance(TEST_DB_PATH);
    
    // Should still work
    service.recordDeviceConnection('0xtest', 'UDP', '192.168.1.1', 'v1.0.0');
    
    const rows = service['db'].prepare('SELECT * FROM device_events').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].firmware_version).toBe('v1.0.0');

    service.close();
  });

  it('should work with fresh database (new installs)', () => {
    // Fresh database (no pre-existing table)
    const service = TelemetryService.getInstance(TEST_DB_PATH);

    // Should create table with all columns including firmware_version
    const columns = service['db'].prepare('PRAGMA table_info(device_events)').all() as Array<{ name: string }>;
    const columnNames = columns.map(c => c.name);
    expect(columnNames).toContain('firmware_version');

    // Should work normally
    service.recordDeviceConnection('0xnew', 'UDP', '192.168.1.1', 'v2.0.0');
    
    const rows = service['db'].prepare('SELECT * FROM device_events').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].firmware_version).toBe('v2.0.0');

    service.close();
  });
});
