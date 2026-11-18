/**
 * ZigbeeDiagnosticsService - Zigbee gateway diagnostics storage (SQLite)
 *
 * TODO(auth): Add per-device P-256 signing. Register device pubkey on first
 * contact (or via admin), require ADMIN_ADDRESSES-signed challenge approval
 * before accepting signed posts, then verify signatures instead of (or in
 * addition to) the shared X-ZBGW-Diag product token.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export const ZBGW_MAX_PAYLOAD_BYTES = 64 * 1024;
export const ZBGW_ALLOWED_ACTIONS = ['restart', 'ota_check'] as const;
export type ZbgwCommandAction = (typeof ZBGW_ALLOWED_ACTIONS)[number];

export interface ZigbeeGateway {
  mac: string;
  firmwareVersion: string | null;
  firstSeen: number;
  lastSeen: number;
  lastIp: string | null;
  status: string | null;
  /** Reserved for future per-device P-256 auth (not used yet). */
  devicePubkey: string | null;
  /** Reserved for future admin approval of device pubkey (not used yet). */
  authApproved: boolean;
}

export interface ZigbeeEvent {
  id: number;
  mac: string;
  kind: string;
  payload: Record<string, unknown>;
  receivedAt: number;
}

export interface ZigbeeCommand {
  id: number;
  mac: string;
  action: string;
  queuedAt: number;
  deliveredAt: number | null;
  queuedBy: string | null;
}

export function normalizeMac(raw: string): string {
  return raw.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

export function isAllowedAction(action: string): action is ZbgwCommandAction {
  return (ZBGW_ALLOWED_ACTIONS as readonly string[]).includes(action);
}

export class ZigbeeDiagnosticsService {
  private static instance: ZigbeeDiagnosticsService;
  private db: Database.Database;
  private retentionDays: number;

  private constructor(dbPath: string, retentionDays: number = 30) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.retentionDays = retentionDays;
    this.initDatabase();
    this.startCleanupSchedule();
  }

  static getInstance(dbPath?: string, retentionDays?: number): ZigbeeDiagnosticsService {
    if (!ZigbeeDiagnosticsService.instance) {
      if (!dbPath) {
        throw new Error('Database path required for first initialization');
      }
      ZigbeeDiagnosticsService.instance = new ZigbeeDiagnosticsService(dbPath, retentionDays);
    }
    return ZigbeeDiagnosticsService.instance;
  }

  static resetInstance(): void {
    if (ZigbeeDiagnosticsService.instance) {
      ZigbeeDiagnosticsService.instance.close();
      ZigbeeDiagnosticsService.instance = null as any;
    }
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS zigbee_gateways (
        mac TEXT PRIMARY KEY,
        firmware_version TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        last_ip TEXT,
        status TEXT,
        device_pubkey TEXT,
        auth_approved INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS zigbee_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mac TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_zigbee_events_id ON zigbee_events(id);
      CREATE INDEX IF NOT EXISTS idx_zigbee_events_mac ON zigbee_events(mac, received_at);
      CREATE INDEX IF NOT EXISTS idx_zigbee_events_received ON zigbee_events(received_at);

      CREATE TABLE IF NOT EXISTS zigbee_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mac TEXT NOT NULL,
        action TEXT NOT NULL,
        queued_at INTEGER NOT NULL,
        delivered_at INTEGER,
        queued_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_zigbee_commands_pending
        ON zigbee_commands(mac, delivered_at);
    `);

    this.migrateSchema();
  }

  private migrateSchema(): void {
    const gatewayCols = this.db.prepare('PRAGMA table_info(zigbee_gateways)').all() as Array<{ name: string }>;
    const gatewayNames = new Set(gatewayCols.map(c => c.name));
    const gatewayRequired = [
      { name: 'firmware_version', type: 'TEXT' },
      { name: 'first_seen', type: 'INTEGER' },
      { name: 'last_seen', type: 'INTEGER' },
      { name: 'last_ip', type: 'TEXT' },
      { name: 'status', type: 'TEXT' },
      { name: 'device_pubkey', type: 'TEXT' },
      { name: 'auth_approved', type: 'INTEGER NOT NULL DEFAULT 0' },
    ];
    for (const col of gatewayRequired) {
      if (!gatewayNames.has(col.name)) {
        console.log(`[ZigbeeDiag] Migrating schema: adding zigbee_gateways.${col.name}`);
        this.db.exec(`ALTER TABLE zigbee_gateways ADD COLUMN ${col.name} ${col.type}`);
      }
    }

    const cmdCols = this.db.prepare('PRAGMA table_info(zigbee_commands)').all() as Array<{ name: string }>;
    const cmdNames = new Set(cmdCols.map(c => c.name));
    if (!cmdNames.has('queued_by')) {
      console.log('[ZigbeeDiag] Migrating schema: adding zigbee_commands.queued_by');
      this.db.exec('ALTER TABLE zigbee_commands ADD COLUMN queued_by TEXT');
    }
  }

  private startCleanupSchedule(): void {
    setInterval(() => this.cleanupOldEvents(), 24 * 60 * 60 * 1000);
  }

  private cleanupOldEvents(): void {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const result = this.db.prepare('DELETE FROM zigbee_events WHERE received_at < ?').run(cutoff);
    if (result.changes > 0) {
      console.log(`[ZigbeeDiag] Cleaned up ${result.changes} events older than ${this.retentionDays} days`);
    }
  }

  recordEvent(
    macRaw: string,
    kind: string,
    payload: Record<string, unknown>,
    ipAddress?: string
  ): { eventId: number; commands: Array<{ action: string }> } {
    const mac = normalizeMac(macRaw);
    if (!mac) {
      throw new Error('Invalid device MAC');
    }

    const now = Date.now();
    const firmwareVersion =
      typeof payload.fw === 'string' ? payload.fw :
      typeof payload.firmware_version === 'string' ? payload.firmware_version :
      null;
    const status = kind || 'unknown';

    const upsert = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT mac FROM zigbee_gateways WHERE mac = ?').get(mac) as
        | { mac: string }
        | undefined;

      if (existing) {
        this.db.prepare(`
          UPDATE zigbee_gateways
          SET firmware_version = COALESCE(?, firmware_version),
              last_seen = ?,
              last_ip = COALESCE(?, last_ip),
              status = ?
          WHERE mac = ?
        `).run(firmwareVersion, now, ipAddress || null, status, mac);
      } else {
        this.db.prepare(`
          INSERT INTO zigbee_gateways
            (mac, firmware_version, first_seen, last_seen, last_ip, status, device_pubkey, auth_approved)
          VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
        `).run(mac, firmwareVersion, now, now, ipAddress || null, status);
      }

      const insert = this.db.prepare(`
        INSERT INTO zigbee_events (mac, kind, payload, received_at)
        VALUES (?, ?, ?, ?)
      `);
      const info = insert.run(mac, kind, JSON.stringify(payload), now);

      const pending = this.db.prepare(`
        SELECT id, action FROM zigbee_commands
        WHERE mac = ? AND delivered_at IS NULL
        ORDER BY id ASC
      `).all(mac) as Array<{ id: number; action: string }>;

      const mark = this.db.prepare(`
        UPDATE zigbee_commands SET delivered_at = ? WHERE id = ?
      `);
      for (const cmd of pending) {
        mark.run(now, cmd.id);
      }

      return {
        eventId: Number(info.lastInsertRowid),
        commands: pending.map(c => ({ action: c.action })),
      };
    });

    return upsert();
  }

  listGateways(): ZigbeeGateway[] {
    const rows = this.db.prepare(`
      SELECT
        mac,
        firmware_version as firmwareVersion,
        first_seen as firstSeen,
        last_seen as lastSeen,
        last_ip as lastIp,
        status,
        device_pubkey as devicePubkey,
        auth_approved as authApproved
      FROM zigbee_gateways
      ORDER BY last_seen DESC
    `).all() as any[];

    return rows.map(r => ({
      ...r,
      authApproved: r.authApproved === 1,
    }));
  }

  getEventsFeed(afterId: number, limit: number): {
    rows: ZigbeeEvent[];
    maxId: number;
    hasMore: boolean;
  } {
    const rows = this.db.prepare(`
      SELECT id, mac, kind, payload, received_at as receivedAt
      FROM zigbee_events
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(afterId, limit) as any[];

    const { maxId } = this.db.prepare('SELECT MAX(id) as maxId FROM zigbee_events').get() as {
      maxId: number | null;
    };

    const parsed: ZigbeeEvent[] = rows.map(r => ({
      id: r.id,
      mac: r.mac,
      kind: r.kind,
      payload: JSON.parse(r.payload),
      receivedAt: r.receivedAt,
    }));

    const lastId = parsed[parsed.length - 1]?.id || 0;
    const hasMore = parsed.length === limit && (maxId || 0) > lastId;

    return {
      rows: parsed,
      maxId: maxId || 0,
      hasMore,
    };
  }

  countEventsUpTo(upToId: number): number {
    const { count } = this.db.prepare(
      'SELECT COUNT(*) as count FROM zigbee_events WHERE id <= ?'
    ).get(upToId) as { count: number };
    return count;
  }

  deleteEventsUpTo(upToId: number): { deleted: number; remaining: number } {
    const deleteResult = this.db.prepare('DELETE FROM zigbee_events WHERE id <= ?').run(upToId);
    const { count: remaining } = this.db.prepare(
      'SELECT COUNT(*) as count FROM zigbee_events'
    ).get() as { count: number };

    if (deleteResult.changes > 1000) {
      try {
        this.db.pragma('incremental_vacuum');
      } catch (vacErr) {
        console.warn('[ZigbeeDiag] Vacuum warning:', vacErr);
      }
    }

    return { deleted: deleteResult.changes, remaining };
  }

  queueCommand(macRaw: string, action: string, queuedBy?: string): ZigbeeCommand {
    const mac = normalizeMac(macRaw);
    if (!mac) {
      throw new Error('Invalid device MAC');
    }
    if (!isAllowedAction(action)) {
      throw new Error(`Unsupported action: ${action}`);
    }

    const now = Date.now();
    const info = this.db.prepare(`
      INSERT INTO zigbee_commands (mac, action, queued_at, delivered_at, queued_by)
      VALUES (?, ?, ?, NULL, ?)
    `).run(mac, action, now, queuedBy || null);

    return {
      id: Number(info.lastInsertRowid),
      mac,
      action,
      queuedAt: now,
      deliveredAt: null,
      queuedBy: queuedBy || null,
    };
  }

  getPendingCommands(macRaw: string): ZigbeeCommand[] {
    const mac = normalizeMac(macRaw);
    const rows = this.db.prepare(`
      SELECT
        id, mac, action,
        queued_at as queuedAt,
        delivered_at as deliveredAt,
        queued_by as queuedBy
      FROM zigbee_commands
      WHERE mac = ? AND delivered_at IS NULL
      ORDER BY id ASC
    `).all(mac) as ZigbeeCommand[];
    return rows;
  }

  close(): void {
    this.db.close();
  }

  reset(): void {
    this.db.exec('DELETE FROM zigbee_events');
    this.db.exec('DELETE FROM zigbee_commands');
    this.db.exec('DELETE FROM zigbee_gateways');
  }
}
