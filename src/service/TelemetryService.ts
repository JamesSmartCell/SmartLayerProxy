/**
 * TelemetryService - Tracks device events and API metrics with SQLite persistence
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export type DisconnectReason = 'timeout' | 'socket_error' | 'auth_failure' | 'signature_failure' | 'client_close' | 'terminated' | 'unknown';

export interface DeviceEvent {
  id: number;
  timestamp: number;
  device: string;
  eventType: 'connect' | 'disconnect' | 'api_call';
  protocol?: 'UDP' | 'TCP';
  disconnectReason?: DisconnectReason;
  apiMethod?: string;
  apiSuccess?: boolean;
  apiResponseTime?: number;
  ipAddress?: string;
}

export interface DeviceMetrics {
  address: string;
  connectionCount: number;
  disconnectCount: number;
  lastConnected: number;
  firstConnected: number;
  apiCalls: number;
  failedCalls: number;
  methodUsage: Record<string, number>;
  avgResponseTime: number;
  protocol: 'UDP' | 'TCP' | 'BOTH';
  ipAddress?: string;
  uptimePercent: number;
  totalSessionDuration: number;
  disconnectsByReason: Record<DisconnectReason, number>;
  medianReconnectTime?: number;
  p95ReconnectTime?: number;
}

export interface SystemMetrics {
  totalDevices: number;
  totalApiCalls: number;
  totalFailedCalls: number;
  activeDevices: number;
  uptime: number;
  startTime: number;
  totalEvents: number;
}

interface SessionInfo {
  connectTime: number;
  protocol: 'UDP' | 'TCP';
  ipAddress?: string;
}

export class TelemetryService {
  private static instance: TelemetryService;
  private db: Database.Database;
  private systemStartTime: number = Date.now();
  private activeSessions = new Map<string, SessionInfo>();
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

  static getInstance(dbPath?: string, retentionDays?: number): TelemetryService {
    if (!TelemetryService.instance) {
      if (!dbPath) {
        throw new Error('Database path required for first initialization');
      }
      TelemetryService.instance = new TelemetryService(dbPath, retentionDays);
    }
    return TelemetryService.instance;
  }

  static resetInstance(): void {
    if (TelemetryService.instance) {
      TelemetryService.instance.close();
      TelemetryService.instance = null as any;
    }
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_events (
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

      CREATE INDEX IF NOT EXISTS idx_device_timestamp ON device_events(device, timestamp);
      CREATE INDEX IF NOT EXISTS idx_timestamp ON device_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_event_type ON device_events(event_type);
    `);
  }

  private startCleanupSchedule(): void {
    setInterval(() => this.cleanupOldEvents(), 24 * 60 * 60 * 1000);
  }

  private cleanupOldEvents(): void {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare('DELETE FROM device_events WHERE timestamp < ?');
    const result = stmt.run(cutoff);
    if (result.changes > 0) {
      console.log(`[Telemetry] Cleaned up ${result.changes} events older than ${this.retentionDays} days`);
    }
  }

  recordDeviceConnection(address: string, protocol: 'UDP' | 'TCP', ipAddress?: string): void {
    const normalized = address.toLowerCase();
    const now = Date.now();

    this.activeSessions.set(normalized, {
      connectTime: now,
      protocol,
      ipAddress,
    });

    const stmt = this.db.prepare(`
      INSERT INTO device_events (timestamp, device, event_type, protocol, ip_address)
      VALUES (?, ?, 'connect', ?, ?)
    `);
    stmt.run(now, normalized, protocol, ipAddress || null);
  }

  recordDeviceDisconnect(address: string, reason: DisconnectReason): void {
    const normalized = address.toLowerCase();
    const now = Date.now();

    this.activeSessions.delete(normalized);

    const stmt = this.db.prepare(`
      INSERT INTO device_events (timestamp, device, event_type, disconnect_reason)
      VALUES (?, ?, 'disconnect', ?)
    `);
    stmt.run(now, normalized, reason);
  }

  recordApiCall(
    address: string,
    method: string,
    success: boolean,
    responseTimeMs: number
  ): void {
    const normalized = address.toLowerCase();
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO device_events (timestamp, device, event_type, api_method, api_success, api_response_time)
      VALUES (?, ?, 'api_call', ?, ?, ?)
    `);
    stmt.run(now, normalized, method, success ? 1 : 0, responseTimeMs);
  }

  getDeviceMetrics(address: string, since?: number): DeviceMetrics | undefined {
    const normalized = address.toLowerCase();
    const sinceTime = since || 0;

    const events = this.db.prepare(`
      SELECT * FROM device_events
      WHERE device = ? AND timestamp >= ?
      ORDER BY timestamp ASC
    `).all(normalized, sinceTime) as any[];

    if (events.length === 0) return undefined;

    const connects = events.filter(e => e.event_type === 'connect');
    const disconnects = events.filter(e => e.event_type === 'disconnect');
    const apiCalls = events.filter(e => e.event_type === 'api_call');

    const connectionCount = connects.length;
    const disconnectCount = disconnects.length;
    const firstConnected = connects[0]?.timestamp || 0;
    const lastConnected = connects[connects.length - 1]?.timestamp || 0;

    const methodUsage: Record<string, number> = {};
    let totalResponseTime = 0;
    let failedCalls = 0;

    for (const call of apiCalls) {
      methodUsage[call.api_method] = (methodUsage[call.api_method] || 0) + 1;
      totalResponseTime += call.api_response_time || 0;
      if (!call.api_success) failedCalls++;
    }

    const disconnectsByReason: Record<DisconnectReason, number> = {
      timeout: 0,
      socket_error: 0,
      auth_failure: 0,
      signature_failure: 0,
      client_close: 0,
      terminated: 0,
      unknown: 0,
    };

    for (const dc of disconnects) {
      const reason = dc.disconnect_reason as DisconnectReason || 'unknown';
      disconnectsByReason[reason]++;
    }

    let totalSessionDuration = 0;
    const reconnectTimes: number[] = [];

    for (let i = 0; i < connects.length; i++) {
      const connectTime = connects[i].timestamp;
      const nextDisconnect = disconnects.find(d => d.timestamp > connectTime);
      
      if (nextDisconnect) {
        totalSessionDuration += nextDisconnect.timestamp - connectTime;
      } else if (this.activeSessions.has(normalized)) {
        totalSessionDuration += Date.now() - connectTime;
      }

      if (i > 0) {
        const prevDisconnect = disconnects.find(d => 
          d.timestamp < connectTime && d.timestamp > connects[i - 1].timestamp
        );
        if (prevDisconnect) {
          reconnectTimes.push(connectTime - prevDisconnect.timestamp);
        }
      }
    }

    const timeWindow = since ? Date.now() - since : Date.now() - firstConnected;
    const uptimePercent = timeWindow > 0 ? (totalSessionDuration / timeWindow) * 100 : 0;

    reconnectTimes.sort((a, b) => a - b);
    const medianReconnectTime = reconnectTimes.length > 0
      ? reconnectTimes[Math.floor(reconnectTimes.length / 2)]
      : undefined;
    const p95ReconnectTime = reconnectTimes.length > 0
      ? reconnectTimes[Math.floor(reconnectTimes.length * 0.95)]
      : undefined;

    const protocol = connects.length > 0
      ? (connects.some(c => c.protocol === 'UDP') && connects.some(c => c.protocol === 'TCP')
        ? 'BOTH'
        : connects[connects.length - 1].protocol as 'UDP' | 'TCP')
      : 'UDP';

    return {
      address: normalized,
      connectionCount,
      disconnectCount,
      lastConnected,
      firstConnected,
      apiCalls: apiCalls.length,
      failedCalls,
      methodUsage,
      avgResponseTime: apiCalls.length > 0 ? totalResponseTime / apiCalls.length : 0,
      protocol,
      ipAddress: connects[connects.length - 1]?.ip_address,
      uptimePercent: Math.min(100, uptimePercent),
      totalSessionDuration,
      disconnectsByReason,
      medianReconnectTime,
      p95ReconnectTime,
    };
  }

  getAllDeviceMetrics(since?: number): DeviceMetrics[] {
    const sinceTime = since || 0;
    
    const devices = this.db.prepare(`
      SELECT DISTINCT device FROM device_events WHERE timestamp >= ?
    `).all(sinceTime) as { device: string }[];

    return devices
      .map(d => this.getDeviceMetrics(d.device, since))
      .filter((m): m is DeviceMetrics => m !== undefined);
  }

  getSystemMetrics(since?: number): SystemMetrics {
    const sinceTime = since || 0;
    const now = Date.now();

    const stats = this.db.prepare(`
      SELECT
        COUNT(DISTINCT device) as totalDevices,
        COUNT(CASE WHEN event_type = 'api_call' THEN 1 END) as totalApiCalls,
        COUNT(CASE WHEN event_type = 'api_call' AND api_success = 0 THEN 1 END) as totalFailedCalls,
        COUNT(*) as totalEvents
      FROM device_events
      WHERE timestamp >= ?
    `).get(sinceTime) as any;

    const fiveMinutesAgo = now - 5 * 60 * 1000;
    const activeDevices = this.db.prepare(`
      SELECT COUNT(DISTINCT device) as count
      FROM device_events
      WHERE timestamp >= ? AND event_type = 'connect'
    `).get(fiveMinutesAgo) as any;

    return {
      totalDevices: stats.totalDevices || 0,
      totalApiCalls: stats.totalApiCalls || 0,
      totalFailedCalls: stats.totalFailedCalls || 0,
      activeDevices: activeDevices.count || 0,
      uptime: now - this.systemStartTime,
      startTime: this.systemStartTime,
      totalEvents: stats.totalEvents || 0,
    };
  }

  getTopMethods(limit: number = 10, since?: number): Array<{ method: string; count: number }> {
    const sinceTime = since || 0;

    const methods = this.db.prepare(`
      SELECT api_method as method, COUNT(*) as count
      FROM device_events
      WHERE event_type = 'api_call' AND timestamp >= ?
      GROUP BY api_method
      ORDER BY count DESC
      LIMIT ?
    `).all(sinceTime, limit) as any[];

    return methods;
  }

  getEvents(options: {
    since?: number;
    device?: string;
    limit?: number;
    offset?: number;
  }): { events: DeviceEvent[]; total: number } {
    const { since = 0, device, limit = 100, offset = 0 } = options;

    let whereClause = 'WHERE timestamp >= ?';
    const params: any[] = [since];

    if (device) {
      whereClause += ' AND device = ?';
      params.push(device.toLowerCase());
    }

    const countStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM device_events ${whereClause}
    `);
    const { count } = countStmt.get(...params) as any;

    const eventsStmt = this.db.prepare(`
      SELECT
        id,
        timestamp,
        device,
        event_type as eventType,
        protocol,
        disconnect_reason as disconnectReason,
        api_method as apiMethod,
        api_success as apiSuccess,
        api_response_time as apiResponseTime,
        ip_address as ipAddress
      FROM device_events
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);

    const rawEvents = eventsStmt.all(...params, limit, offset) as any[];

    return {
      events: rawEvents.map(e => ({
        ...e,
        apiSuccess: e.apiSuccess !== null && e.apiSuccess !== undefined ? e.apiSuccess === 1 : undefined,
      })) as DeviceEvent[],
      total: count,
    };
  }

  close(): void {
    this.db.close();
  }

  reset(): void {
    this.db.exec('DELETE FROM device_events');
    this.activeSessions.clear();
    this.systemStartTime = Date.now();
  }
}
