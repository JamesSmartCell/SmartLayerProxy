/**
 * FirmwareService - Manages firmware metadata, setup firmware, and revoke queue
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';

export type FirmwareChannel = 'app' | 'setup';

export interface FirmwareMetadata {
  id: number;
  project: string;
  version: string;
  sha256: string;
  size: number;
  r2Key: string;
  url: string;
  uploadedAt: number;
  uploadedBy?: string;
  isCurrent: boolean;
  channel: FirmwareChannel;
}

export interface FirmwareVersion {
  project: string;
  version: string;
  url: string;
  sha256: string;
  size: number;
  channel?: FirmwareChannel;
}

export type RevokeStatus =
  | 'pending'
  | 'delivered'
  | 'acknowledged'
  | 'completed'
  | 'cancelled';

export interface DeviceRevoke {
  id: number;
  project: string;
  device: string;
  status: RevokeStatus;
  setupVersion: string;
  setupSha256: string;
  setupSize: number;
  setupUrl: string;
  noticeMessage: string;
  noticeSignature: string;
  requestedAt: number;
  requestedBy?: string;
  deliveredAt?: number;
  acknowledgedAt?: number;
  /** Set when the device disconnects after delivery/ack (typical OTA reboot). */
  disconnectedAfterDelivery: boolean;
  completedAt?: number;
  cancelledAt?: number;
}

/** Build the EIP-191 message an admin signs for a device revoke notice. */
export function buildRevokeNoticeMessage(
  project: string,
  deviceAddress: string,
  setupSha256: string,
  nonce: string
): string {
  const device = normalizeDeviceAddress(deviceAddress);
  return `revoke:${project}:${device}:${setupSha256}:${nonce}`;
}

/** Setup firmware TCP/login identity: "<project>-setup@<semver>+<hash>" */
export function setupFirmwareProjectId(project: string): string {
  return `${project.trim().toLowerCase()}-setup`;
}

export function isSetupFirmwareIdentity(project: string | undefined, appProject: string): boolean {
  if (!project) return false;
  return project.toLowerCase() === setupFirmwareProjectId(appProject);
}

export function normalizeDeviceAddress(addr: string): string {
  const hex = addr.replace(/^0x/i, '').toLowerCase();
  return `0x${hex}`;
}

export class FirmwareService {
  private static instance: FirmwareService;
  private db: Database.Database;

  private constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initDatabase();
  }

  static getInstance(dbPath?: string): FirmwareService {
    if (!FirmwareService.instance) {
      if (!dbPath) {
        throw new Error('Database path required for first initialization');
      }
      FirmwareService.instance = new FirmwareService(dbPath);
    }
    return FirmwareService.instance;
  }

  static resetInstance(): void {
    if (FirmwareService.instance) {
      FirmwareService.instance.close();
      FirmwareService.instance = null as any;
    }
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS firmware (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        version TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        r2_key TEXT NOT NULL,
        url TEXT NOT NULL,
        uploaded_at INTEGER NOT NULL,
        uploaded_by TEXT,
        is_current INTEGER NOT NULL DEFAULT 0,
        UNIQUE(project, version)
      );

      CREATE INDEX IF NOT EXISTS idx_project ON firmware(project);
      CREATE INDEX IF NOT EXISTS idx_project_current ON firmware(project, is_current);

      CREATE TABLE IF NOT EXISTS setup_firmware (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        version TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        r2_key TEXT NOT NULL,
        url TEXT NOT NULL,
        uploaded_at INTEGER NOT NULL,
        uploaded_by TEXT,
        is_current INTEGER NOT NULL DEFAULT 0,
        UNIQUE(project, version)
      );

      CREATE INDEX IF NOT EXISTS idx_setup_project ON setup_firmware(project);
      CREATE INDEX IF NOT EXISTS idx_setup_project_current ON setup_firmware(project, is_current);

      CREATE TABLE IF NOT EXISTS device_revokes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        device TEXT NOT NULL,
        status TEXT NOT NULL,
        setup_version TEXT NOT NULL,
        setup_sha256 TEXT NOT NULL,
        setup_size INTEGER NOT NULL,
        setup_url TEXT NOT NULL,
        notice_message TEXT NOT NULL,
        notice_signature TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        requested_by TEXT,
        delivered_at INTEGER,
        acknowledged_at INTEGER,
        disconnected_after_delivery INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER,
        cancelled_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_revoke_device ON device_revokes(device);
      CREATE INDEX IF NOT EXISTS idx_revoke_status ON device_revokes(status);
      CREATE INDEX IF NOT EXISTS idx_revoke_device_status ON device_revokes(device, status);
    `);

    this.migrateRevokeSchema();
  }

  private migrateRevokeSchema(): void {
    const columns = this.db.prepare('PRAGMA table_info(device_revokes)').all() as Array<{ name: string }>;
    const names = new Set(columns.map(c => c.name));
    if (!names.has('acknowledged_at')) {
      this.db.exec('ALTER TABLE device_revokes ADD COLUMN acknowledged_at INTEGER');
    }
    if (!names.has('disconnected_after_delivery')) {
      this.db.exec(
        'ALTER TABLE device_revokes ADD COLUMN disconnected_after_delivery INTEGER NOT NULL DEFAULT 0'
      );
    }
  }

  static computeSha256(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  addFirmware(
    project: string,
    version: string,
    sha256: string,
    size: number,
    r2Key: string,
    url: string,
    uploadedBy?: string,
    markCurrent = true
  ): FirmwareMetadata {
    const uploadedAt = Date.now();

    const result = this.db.transaction(() => {
      if (markCurrent) {
        const clearStmt = this.db.prepare(`
          UPDATE firmware SET is_current = 0 WHERE project = ?
        `);
        clearStmt.run(project);
      }

      const insertStmt = this.db.prepare(`
        INSERT INTO firmware (project, version, sha256, size, r2_key, url, uploaded_at, uploaded_by, is_current)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const info = insertStmt.run(
        project,
        version,
        sha256,
        size,
        r2Key,
        url,
        uploadedAt,
        uploadedBy || null,
        markCurrent ? 1 : 0
      );

      return {
        id: info.lastInsertRowid as number,
        project,
        version,
        sha256,
        size,
        r2Key,
        url,
        uploadedAt,
        uploadedBy,
        isCurrent: markCurrent,
        channel: 'app' as FirmwareChannel,
      };
    })();

    return result;
  }

  addSetupFirmware(
    project: string,
    version: string,
    sha256: string,
    size: number,
    r2Key: string,
    url: string,
    uploadedBy?: string,
    markCurrent = true
  ): FirmwareMetadata {
    const uploadedAt = Date.now();

    const result = this.db.transaction(() => {
      if (markCurrent) {
        this.db.prepare(`UPDATE setup_firmware SET is_current = 0 WHERE project = ?`).run(project);
      }

      const info = this.db.prepare(`
        INSERT INTO setup_firmware (project, version, sha256, size, r2_key, url, uploaded_at, uploaded_by, is_current)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        project,
        version,
        sha256,
        size,
        r2Key,
        url,
        uploadedAt,
        uploadedBy || null,
        markCurrent ? 1 : 0
      );

      return {
        id: info.lastInsertRowid as number,
        project,
        version,
        sha256,
        size,
        r2Key,
        url,
        uploadedAt,
        uploadedBy,
        isCurrent: markCurrent,
        channel: 'setup' as FirmwareChannel,
      };
    })();

    return result;
  }

  getLatestFirmware(project: string): FirmwareVersion | null {
    const stmt = this.db.prepare(`
      SELECT project, version, url, sha256, size
      FROM firmware
      WHERE project = ? AND is_current = 1
      LIMIT 1
    `);

    const row = stmt.get(project) as any;
    if (!row) return null;

    return {
      project: row.project,
      version: row.version,
      url: row.url,
      sha256: row.sha256,
      size: row.size,
      channel: 'app',
    };
  }

  getSetupFirmware(project: string): FirmwareVersion | null {
    const row = this.db.prepare(`
      SELECT project, version, url, sha256, size
      FROM setup_firmware
      WHERE project = ? AND is_current = 1
      LIMIT 1
    `).get(project) as any;

    if (!row) return null;

    return {
      project: row.project,
      version: row.version,
      url: row.url,
      sha256: row.sha256,
      size: row.size,
      channel: 'setup',
    };
  }

  listVersions(project: string): FirmwareVersion[] {
    const stmt = this.db.prepare(`
      SELECT project, version, url, sha256, size, is_current as isCurrent
      FROM firmware
      WHERE project = ?
      ORDER BY uploaded_at DESC, id DESC
    `);

    return (stmt.all(project) as any[]).map(row => ({
      ...row,
      channel: 'app' as FirmwareChannel,
    }));
  }

  listSetupVersions(project: string): FirmwareVersion[] {
    const rows = this.db.prepare(`
      SELECT project, version, url, sha256, size, is_current as isCurrent
      FROM setup_firmware
      WHERE project = ?
      ORDER BY uploaded_at DESC, id DESC
    `).all(project) as any[];

    return rows.map(row => ({
      ...row,
      channel: 'setup' as FirmwareChannel,
    }));
  }

  setCurrentVersion(project: string, version: string): boolean {
    const result = this.db.transaction(() => {
      const checkStmt = this.db.prepare(`
        SELECT id FROM firmware WHERE project = ? AND version = ?
      `);
      const exists = checkStmt.get(project, version);
      if (!exists) {
        return false;
      }

      const clearStmt = this.db.prepare(`
        UPDATE firmware SET is_current = 0 WHERE project = ?
      `);
      clearStmt.run(project);

      const setStmt = this.db.prepare(`
        UPDATE firmware SET is_current = 1 WHERE project = ? AND version = ?
      `);
      setStmt.run(project, version);

      return true;
    })();

    return result;
  }

  setCurrentSetupVersion(project: string, version: string): boolean {
    return this.db.transaction(() => {
      const exists = this.db.prepare(`
        SELECT id FROM setup_firmware WHERE project = ? AND version = ?
      `).get(project, version);
      if (!exists) return false;

      this.db.prepare(`UPDATE setup_firmware SET is_current = 0 WHERE project = ?`).run(project);
      this.db.prepare(`
        UPDATE setup_firmware SET is_current = 1 WHERE project = ? AND version = ?
      `).run(project, version);
      return true;
    })();
  }

  firmwareExists(project: string, version: string): boolean {
    const stmt = this.db.prepare(`
      SELECT id FROM firmware WHERE project = ? AND version = ? LIMIT 1
    `);
    return !!stmt.get(project, version);
  }

  setupFirmwareExists(project: string, version: string): boolean {
    return !!this.db.prepare(`
      SELECT id FROM setup_firmware WHERE project = ? AND version = ? LIMIT 1
    `).get(project, version);
  }

  /**
   * Queue or immediately-record a revoke. Replaces any existing pending/delivered
   * revoke for the same device (cancelled/completed history is retained).
   */
  requestRevoke(params: {
    project: string;
    device: string;
    setup: FirmwareVersion;
    noticeMessage: string;
    noticeSignature: string;
    requestedBy?: string;
  }): DeviceRevoke {
    const device = normalizeDeviceAddress(params.device);
    const requestedAt = Date.now();

    return this.db.transaction(() => {
      // Supersede active revokes for this device
      this.db.prepare(`
        UPDATE device_revokes
        SET status = 'cancelled', cancelled_at = ?
        WHERE device = ? AND status IN ('pending', 'delivered', 'acknowledged')
      `).run(requestedAt, device);

      const info = this.db.prepare(`
        INSERT INTO device_revokes (
          project, device, status, setup_version, setup_sha256, setup_size, setup_url,
          notice_message, notice_signature, requested_at, requested_by
        ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.project,
        device,
        params.setup.version,
        params.setup.sha256,
        params.setup.size,
        params.setup.url,
        params.noticeMessage,
        params.noticeSignature,
        requestedAt,
        params.requestedBy || null
      );

      return this.getRevokeById(info.lastInsertRowid as number)!;
    })();
  }

  getRevokeById(id: number): DeviceRevoke | null {
    const row = this.db.prepare(`SELECT * FROM device_revokes WHERE id = ?`).get(id) as any;
    return row ? this.mapRevoke(row) : null;
  }

  getActiveRevoke(device: string): DeviceRevoke | null {
    const normalized = normalizeDeviceAddress(device);
    const row = this.db.prepare(`
      SELECT * FROM device_revokes
      WHERE device = ? AND status IN ('pending', 'delivered', 'acknowledged')
      ORDER BY requested_at DESC
      LIMIT 1
    `).get(normalized) as any;
    return row ? this.mapRevoke(row) : null;
  }

  getPendingRevoke(device: string): DeviceRevoke | null {
    const normalized = normalizeDeviceAddress(device);
    const row = this.db.prepare(`
      SELECT * FROM device_revokes
      WHERE device = ? AND status = 'pending'
      ORDER BY requested_at DESC
      LIMIT 1
    `).get(normalized) as any;
    return row ? this.mapRevoke(row) : null;
  }

  markRevokeDelivered(id: number): DeviceRevoke | null {
    const deliveredAt = Date.now();
    this.db.prepare(`
      UPDATE device_revokes
      SET status = 'delivered', delivered_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(deliveredAt, id);
    return this.getRevokeById(id);
  }

  /**
   * Device acknowledged the revoke notice over TCP (before OTA to setup).
   * Expected API response body: "revoking" (or prefix).
   */
  markRevokeAcknowledged(id: number): DeviceRevoke | null {
    const acknowledgedAt = Date.now();
    this.db.prepare(`
      UPDATE device_revokes
      SET status = 'acknowledged', acknowledged_at = ?
      WHERE id = ? AND status IN ('pending', 'delivered')
    `).run(acknowledgedAt, id);
    return this.getRevokeById(id);
  }

  markRevokeDisconnectedAfterDelivery(device: string): void {
    const active = this.getActiveRevoke(device);
    if (!active) return;
    if (active.status !== 'delivered' && active.status !== 'acknowledged') return;
    this.db.prepare(`
      UPDATE device_revokes
      SET disconnected_after_delivery = 1
      WHERE id = ?
    `).run(active.id);
  }

  markRevokeCompleted(id: number): DeviceRevoke | null {
    const completedAt = Date.now();
    this.db.prepare(`
      UPDATE device_revokes
      SET status = 'completed', completed_at = ?
      WHERE id = ? AND status IN ('pending', 'delivered', 'acknowledged')
    `).run(completedAt, id);
    return this.getRevokeById(id);
  }

  cancelRevoke(device: string, project?: string): DeviceRevoke | null {
    const normalized = normalizeDeviceAddress(device);
    const active = this.getActiveRevoke(normalized);
    if (!active) return null;
    if (project && active.project.toLowerCase() !== project.toLowerCase()) {
      return null;
    }

    const cancelledAt = Date.now();
    this.db.prepare(`
      UPDATE device_revokes
      SET status = 'cancelled', cancelled_at = ?
      WHERE id = ? AND status IN ('pending', 'delivered', 'acknowledged')
    `).run(cancelledAt, active.id);

    return this.getRevokeById(active.id);
  }

  listRevokes(project: string, options: { device?: string; status?: RevokeStatus; limit?: number } = {}): DeviceRevoke[] {
    const { device, status, limit = 100 } = options;
    let sql = `SELECT * FROM device_revokes WHERE project = ?`;
    const params: any[] = [project];

    if (device) {
      sql += ` AND device = ?`;
      params.push(normalizeDeviceAddress(device));
    }
    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY requested_at DESC LIMIT ?`;
    params.push(limit);

    return (this.db.prepare(sql).all(...params) as any[]).map(row => this.mapRevoke(row));
  }

  /** Build the updateReady arg map for a revoke notice (opcode 0x04). */
  buildRevokeNoticeArgs(revoke: DeviceRevoke): Record<string, string[]> {
    return {
      purpose: ['revoke'],
      version: [revoke.setupVersion],
      sha256: [revoke.setupSha256],
      size: [String(revoke.setupSize)],
      message: [revoke.noticeMessage],
      signature: [revoke.noticeSignature],
    };
  }

  private mapRevoke(row: any): DeviceRevoke {
    return {
      id: row.id,
      project: row.project,
      device: row.device,
      status: row.status,
      setupVersion: row.setup_version,
      setupSha256: row.setup_sha256,
      setupSize: row.setup_size,
      setupUrl: row.setup_url,
      noticeMessage: row.notice_message,
      noticeSignature: row.notice_signature,
      requestedAt: row.requested_at,
      requestedBy: row.requested_by || undefined,
      deliveredAt: row.delivered_at || undefined,
      acknowledgedAt: row.acknowledged_at || undefined,
      disconnectedAfterDelivery: !!row.disconnected_after_delivery,
      completedAt: row.completed_at || undefined,
      cancelledAt: row.cancelled_at || undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}
