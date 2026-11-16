/**
 * FirmwareService - Manages firmware metadata and coordinates with R2 storage
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';

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
}

export interface FirmwareVersion {
  project: string;
  version: string;
  url: string;
  sha256: string;
  size: number;
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
    `);
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
    };
  }

  listVersions(project: string): FirmwareVersion[] {
    const stmt = this.db.prepare(`
      SELECT project, version, url, sha256, size, is_current as isCurrent
      FROM firmware
      WHERE project = ?
      ORDER BY uploaded_at DESC, id DESC
    `);

    return stmt.all(project) as any[];
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

  firmwareExists(project: string, version: string): boolean {
    const stmt = this.db.prepare(`
      SELECT id FROM firmware WHERE project = ? AND version = ? LIMIT 1
    `);
    return !!stmt.get(project, version);
  }

  close(): void {
    this.db.close();
  }
}
