import express, { Router, Request, Response, NextFunction } from 'express';
import { ASyncService } from '../service/ASyncService';
import { ASyncTCPService } from '../service/ASyncTCPService';
import * as passkey from './passkey';
import { uploadToR2, uploadFirmwareToR2, isR2Configured } from '../service/CloudflareR2';
import { randomUUID } from 'crypto';
import { TelemetryService } from '../service/TelemetryService';
import {
  FirmwareService,
  buildRevokeNoticeMessage,
  normalizeDeviceAddress,
} from '../service/FirmwareService';
import { AdminAuthService } from '../service/AdminAuthService';
import {
  ZigbeeDiagnosticsService,
  ZBGW_MAX_PAYLOAD_BYTES,
  isAllowedAction,
} from '../service/ZigbeeDiagnosticsService';
import { loadConfig } from '../config';
import { FirmwareVersionParser } from '../service/FirmwareVersionParser';
import { deriveHttpClientIpFromRequest, IpRateCounter } from '../util/ip';
import type { GetChallengeFailReason } from '../service/TelemetryService';

const CHECK_CONNECTION_INTERVAL_MS = 5 * 60 * 1000;
/** In-memory getChallenge request counts per client IP (success + failure). */
const getChallengeIpCounter = new IpRateCounter();

/** Base URL for camera upload (e.g. https://proxy.percolate.one) */
function getProxyBaseUrl(req: Request): string {
  const env = process.env.PROXY_PUBLIC_URL;
  if (env) return env.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host') || 'localhost:8081';
  return `${proto}://${host}`;
}

function normalizeAddress(addr: string): string {
  return '0x' + addr.replace(/^0x/i, '').toLowerCase();
}

function getClientIp(req: Request): string {
  const config = loadConfig();
  return deriveHttpClientIpFromRequest(req, {
    trustedProxies: config.proxyProtocolTrusted,
    trustProxy: config.trustProxy,
  });
}

function classifyGetChallengeFailure(response: string): GetChallengeFailReason {
  if (response === 'No device found') return 'device_offline';
  if (response === 'Timed out') return 'timeout';
  if (response === '') return 'empty_response';
  if (response === 'API send error') return 'bad_response';
  return 'bad_response';
}

function parseQueryParams(req: Request): Record<string, string[]> {
  const params: Record<string, string[]> = {};
  for (const [key, val] of Object.entries(req.query)) {
    if (typeof val === 'string') params[key] = [val];
    else if (Array.isArray(val)) params[key] = val as string[];
    else params[key] = [];
  }
  // Merge POST body (for checkGarageSigP256 - avoids long URLs on mobile)
  if (req.body && typeof req.body === 'object') {
    for (const [key, val] of Object.entries(req.body)) {
      if (val !== undefined && val !== null) {
        params[key] = [String(val)];
      }
    }
  }
  return params;
}

function telemetryAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const config = loadConfig();
  
  if (!config.telemetryApiKey) {
    res.status(503).json({ error: 'Telemetry endpoints are disabled' });
    return;
  }

  const authHeader = req.get('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

  if (!token || !AdminAuthService.constantTimeCompare(token, config.telemetryApiKey)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

function zbgwTokenMatches(provided: string | undefined, tokens: string[]): boolean {
  if (!provided || tokens.length === 0) {
    return false;
  }
  let matched = false;
  for (const token of tokens) {
    if (AdminAuthService.constantTimeCompare(provided, token)) {
      matched = true;
    }
  }
  return matched;
}

function zbgwDiagAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const config = loadConfig();

  if (config.zbgwDiagTokens.length === 0) {
    res.status(503).json({ error: 'Zigbee diagnostics endpoints are disabled' });
    return;
  }

  const token = req.get('X-ZBGW-Diag') || undefined;
  if (!zbgwTokenMatches(token, config.zbgwDiagTokens)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

function getAdminAddresses(): string[] {
  const config = loadConfig();
  return [...config.adminAddresses, ...config.telemetryAdminAddresses];
}

export function createRouter(service: ASyncService, tcpService: ASyncTCPService): Router {
  const router = Router();
  const telemetry = TelemetryService.getInstance();
  const adminAuth = AdminAuthService.getInstance();
  const config = loadConfig();

  let zigbee: ZigbeeDiagnosticsService | null = null;
  try {
    // Initialized in index.ts (or tests); do not create a side-effect DB here.
    zigbee = ZigbeeDiagnosticsService.getInstance();
  } catch (err) {
    console.warn('[ZigbeeDiag] Service not initialized:', err);
  }
  
  let firmware: FirmwareService | null = null;
  try {
    const firmwareDbPath = config.telemetryDbPath.replace(/telemetry\.db$/, 'firmware.db');
    firmware = FirmwareService.getInstance(firmwareDbPath);
  } catch (err) {
    console.warn('[Firmware] Service initialization skipped:', err);
  }

  setInterval(() => service.checkServices(), CHECK_CONNECTION_INTERVAL_MS);

  router.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Max-Age', '10000');
    res.set('Access-Control-Allow-Credentials', 'false');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-ZBGW-Diag');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // ========== Admin authentication ==========
  router.get('/admin/challenge', (req, res) => {
    try {
      const challenge = adminAuth.generateChallenge();
      res.json(challenge);
    } catch (err) {
      console.error('[Admin] Challenge generation error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ========== Telemetry feed & ack (Part B) ==========
  router.get('/telemetry/feed', telemetryAuthMiddleware, (req, res) => {
    try {
      const afterId = parseInt(req.query.afterId as string) || 0;
      const limit = Math.min(
        parseInt(req.query.limit as string) || 1000,
        config.telemetryFeedMaxLimit
      );

      const stmt = telemetry['db'].prepare(`
        SELECT
          id, timestamp, device, event_type as eventType, protocol,
          disconnect_reason as disconnectReason, api_method as apiMethod,
          api_success as apiSuccess, api_response_time as apiResponseTime,
          ip_address as ipAddress, firmware_version as firmwareVersion,
          firmware_project as firmwareProject,
          firmware_notify_version as firmwareNotifyVersion,
          failure_reason as failureReason,
          requests_60s as requests60s,
          requests_10m as requests10m
        FROM device_events
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?
      `);

      const rows = stmt.all(afterId, limit) as any[];
      
      const maxIdStmt = telemetry['db'].prepare('SELECT MAX(id) as maxId FROM device_events');
      const { maxId } = maxIdStmt.get() as any;
      
      const hasMore = rows.length === limit && maxId > (rows[rows.length - 1]?.id || 0);

      res.json({
        rows: rows.map(r => ({
          ...r,
          apiSuccess: r.apiSuccess !== null && r.apiSuccess !== undefined ? r.apiSuccess === 1 : undefined,
        })),
        maxId: maxId || 0,
        hasMore,
        serverTime: Date.now(),
      });
    } catch (err) {
      console.error('[Telemetry] Feed error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/telemetry/diagnostics/feed', telemetryAuthMiddleware, (req, res) => {
    try {
      const afterId = parseInt(req.query.afterId as string) || 0;
      const limit = Math.min(
        parseInt(req.query.limit as string) || 1000,
        config.telemetryFeedMaxLimit
      );

      const stmt = telemetry['db'].prepare(`
        SELECT
          id, timestamp, device,
          reset_reason as resetReason,
          boot_count as bootCount,
          wifi_attempts as wifiAttempts,
          connect_time_ms as connectTimeMs,
          network_index as networkIndex,
          last_failure_stage as lastFailureStage,
          wifi_disconnect_reason as wifiDisconnectReason,
          ip_address as ipAddress
        FROM device_diagnostics
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?
      `);

      const rows = stmt.all(afterId, limit) as any[];
      
      const maxIdStmt = telemetry['db'].prepare('SELECT MAX(id) as maxId FROM device_diagnostics');
      const { maxId } = maxIdStmt.get() as any;
      
      const hasMore = rows.length === limit && maxId > (rows[rows.length - 1]?.id || 0);

      res.json({
        rows,
        maxId: maxId || 0,
        hasMore,
        serverTime: Date.now(),
      });
    } catch (err) {
      console.error('[Telemetry] Diagnostics feed error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/telemetry/ack', telemetryAuthMiddleware, async (req, res) => {
    try {
      const { upToId, signature, message, dryRun } = req.body || {};
      
      if (!upToId || typeof upToId !== 'number') {
        res.status(400).json({ error: 'Missing or invalid upToId' });
        return;
      }

      const adminAddresses = getAdminAddresses();
      if (adminAddresses.length === 0) {
        res.status(503).json({ error: 'Admin addresses not configured' });
        return;
      }

      if (!signature || !message) {
        res.status(400).json({ error: 'Missing signature or message' });
        return;
      }

      // Extract nonce from message
      const nonceMatch = message.match(/:([a-f0-9]{64})$/);
      if (!nonceMatch) {
        res.status(400).json({ error: 'Message does not contain valid nonce' });
        return;
      }
      const nonce = nonceMatch[1];

      // Verify message format: 'ack:<upToId>:<nonce>'
      const expectedMessagePrefix = `ack:${upToId}:`;
      if (!message.startsWith(expectedMessagePrefix)) {
        res.status(400).json({ error: 'Message format mismatch' });
        return;
      }

      const result = adminAuth.verifyAndBurnNonce(nonce, message, signature, adminAddresses);
      if (!result.valid) {
        res.status(403).json({ error: result.error || 'Signature verification failed' });
        return;
      }

      const forceDryRun = !config.telemetryAckEnabled;
      const effectiveDryRun = dryRun || forceDryRun;

      if (effectiveDryRun) {
        const countStmt = telemetry['db'].prepare('SELECT COUNT(*) as count FROM device_events WHERE id <= ?');
        const { count } = countStmt.get(upToId) as any;
        res.json({
          wouldDelete: count,
          dryRun: true,
          reason: forceDryRun ? 'TELEMETRY_ACK_ENABLED=false' : 'dryRun requested',
        });
        return;
      }

      const deleteStmt = telemetry['db'].prepare('DELETE FROM device_events WHERE id <= ?');
      const deleteResult = deleteStmt.run(upToId);

      const remainingStmt = telemetry['db'].prepare('SELECT COUNT(*) as count FROM device_events');
      const { count: remaining } = remainingStmt.get() as any;

      // Optional incremental vacuum
      if (deleteResult.changes > 1000) {
        try {
          telemetry['db'].pragma('incremental_vacuum');
        } catch (vacErr) {
          console.warn('[Telemetry] Vacuum warning:', vacErr);
        }
      }

      res.json({
        deleted: deleteResult.changes,
        remaining,
        deletedBy: result.address,
      });
    } catch (err) {
      console.error('[Telemetry] Ack error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ========== Firmware coordinator (Part C) ==========
  router.get('/firmware/:project/latest', (req, res) => {
    try {
      if (!firmware) {
        res.status(503).json({ error: 'Firmware service not initialized' });
        return;
      }

      const project = req.params.project;
      const latest = firmware.getLatestFirmware(project);
      
      if (!latest) {
        res.status(404).json({ error: 'No firmware found for this project' });
        return;
      }

      res.json(latest);
    } catch (err) {
      console.error('[Firmware] Latest query error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Current setup (provisioning portal) firmware for a project — distinct from app /latest
  router.get('/firmware/:project/setup', (req, res) => {
    try {
      if (!firmware) {
        res.status(503).json({ error: 'Firmware service not initialized' });
        return;
      }

      const project = req.params.project;
      const setup = firmware.getSetupFirmware(project);

      if (!setup) {
        res.status(404).json({ error: 'No setup firmware found for this project' });
        return;
      }

      res.json(setup);
    } catch (err) {
      console.error('[Firmware] Setup query error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/firmware/:project', (req, res) => {
    try {
      if (!firmware) {
        res.status(503).json({ error: 'Firmware service not initialized' });
        return;
      }

      const project = req.params.project;
      const versions = firmware.listVersions(project);
      const setupVersions = firmware.listSetupVersions(project);

      res.json({ project, versions, setupVersions });
    } catch (err) {
      console.error('[Firmware] List versions error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/firmware/:project/current', async (req, res) => {
    try {
      if (!firmware) {
        res.status(503).json({ error: 'Firmware service not initialized' });
        return;
      }

      const project = req.params.project;
      const { version, signature, message } = req.body || {};

      if (!version) {
        res.status(400).json({ error: 'Missing version' });
        return;
      }

      const adminAddresses = getAdminAddresses();
      if (adminAddresses.length === 0) {
        res.status(503).json({ error: 'Admin addresses not configured' });
        return;
      }

      if (!signature || !message) {
        res.status(400).json({ error: 'Missing signature or message' });
        return;
      }

      // Extract nonce from message
      const nonceMatch = message.match(/:([a-f0-9]{64})$/);
      if (!nonceMatch) {
        res.status(400).json({ error: 'Message does not contain valid nonce' });
        return;
      }
      const nonce = nonceMatch[1];

      // Verify message format: 'current:<project>:<version>:<nonce>'
      const expectedMessage = `current:${project}:${version}:${nonce}`;
      if (message !== expectedMessage) {
        res.status(400).json({ error: 'Message format mismatch' });
        return;
      }

      const result = adminAuth.verifyAndBurnNonce(nonce, message, signature, adminAddresses);
      if (!result.valid) {
        res.status(403).json({ error: result.error || 'Signature verification failed' });
        return;
      }

      const success = firmware.setCurrentVersion(project, version);
      if (!success) {
        res.status(404).json({ error: 'Version not found' });
        return;
      }

      const shouldNotify = req.query.notify === 'true';
      let notifyResult;
      
      if (shouldNotify) {
        try {
          const latest = firmware.getLatestFirmware(project);
          if (latest && FirmwareVersionParser.extractSemver(latest.version)) {
            const connectedDevices = tcpService.getConnectedDevices();
            const notified: Array<{ address: string; version: string }> = [];
            
            for (const device of connectedDevices) {
              if (device.project?.toLowerCase() === project.toLowerCase() && device.semver) {
                const isOlderResult = FirmwareVersionParser.isOlder(device.semver, latest.version);
                if (isOlderResult === true) {
                  await tcpService.sendApiCallToDevice(device.address, 'updateReady', {});
                  notified.push({ address: device.address, version: device.semver });
                  telemetry.recordFirmwareNotify(device.address, project, latest.version);
                }
              }
            }
            notifyResult = { notified: notified.length };
          }
        } catch (err) {
          console.error('[Firmware] Auto-notify error:', err);
        }
      }

      res.json({ 
        success: true, 
        project, 
        version, 
        setBy: result.address,
        ...(notifyResult ? { notified: notifyResult.notified } : {})
      });
    } catch (err) {
      console.error('[Firmware] Set current error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/firmware/:project/notify', express.json(), async (req, res) => {
    try {
      if (!firmware) {
        res.status(503).json({ error: 'Firmware service not initialized' });
        return;
      }

      const project = req.params.project;
      const { devices, force, signature, message } = req.body || {};

      const adminAddresses = getAdminAddresses();
      if (adminAddresses.length === 0) {
        res.status(503).json({ error: 'Admin addresses not configured' });
        return;
      }

      if (!signature || !message) {
        res.status(400).json({ error: 'Missing signature or message' });
        return;
      }

      const nonceMatch = message.match(/:([a-f0-9]{64})$/);
      if (!nonceMatch) {
        res.status(400).json({ error: 'Message does not contain valid nonce' });
        return;
      }
      const nonce = nonceMatch[1];

      const expectedMessagePrefix = `notify:${project}:`;
      if (!message.startsWith(expectedMessagePrefix)) {
        res.status(400).json({ error: 'Message format mismatch' });
        return;
      }

      const authResult = adminAuth.verifyAndBurnNonce(nonce, message, signature, adminAddresses);
      if (!authResult.valid) {
        res.status(403).json({ error: authResult.error || 'Signature verification failed' });
        return;
      }

      const latest = firmware.getLatestFirmware(project);
      if (!latest) {
        res.status(404).json({ error: 'No firmware found for this project' });
        return;
      }

      const latestSemver = FirmwareVersionParser.extractSemver(latest.version);
      if (!latestSemver) {
        res.status(500).json({ error: 'Latest version format is invalid, cannot compare versions' });
        return;
      }

      const connectedDevices = tcpService.getConnectedDevices();
      
      const notified: Array<{ address: string; version: string }> = [];
      const skipped: Array<{ address: string; reason: string }> = [];

      const targetAddresses = devices ? devices.map((d: string) => d.toLowerCase()) : null;

      for (const device of connectedDevices) {
        if (targetAddresses && !targetAddresses.includes(device.address.toLowerCase())) {
          continue;
        }

        if (!device.project || device.project.toLowerCase() !== project.toLowerCase()) {
          if (targetAddresses && targetAddresses.includes(device.address.toLowerCase())) {
            skipped.push({ address: device.address, reason: 'different project or legacy format' });
          }
          continue;
        }

        if (!device.semver) {
          skipped.push({ address: device.address, reason: 'no semver available' });
          continue;
        }

        const isOlderResult = FirmwareVersionParser.isOlder(device.semver, latest.version);
        
        if (isOlderResult === null) {
          skipped.push({ address: device.address, reason: 'version comparison failed' });
          continue;
        }
        
        const shouldNotify = force || isOlderResult;
        
        if (!shouldNotify) {
          skipped.push({ address: device.address, reason: 'already up to date' });
          continue;
        }

        try {
          await tcpService.sendApiCallToDevice(device.address, 'updateReady', {});
          notified.push({ address: device.address, version: device.semver });
          telemetry.recordFirmwareNotify(device.address, project, latest.version);
          console.log('Notified device', device.address, 'about firmware update:', project, latest.version);
        } catch (err) {
          console.error('Failed to notify device', device.address, err);
          skipped.push({ address: device.address, reason: 'send failed' });
        }
      }

      res.json({
        success: true,
        project,
        latest: latest.version,
        notified,
        skipped,
        notifiedBy: authResult.address,
      });
    } catch (err) {
      console.error('[Firmware] Notify error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Upload setup (provisioning) firmware — same admin signing scheme as app firmware,
  // message format: setup-firmware:<project>:<version>:<sha256>:<nonce>
  router.post(
    '/firmware/:project/setup',
    express.raw({
      type: ['application/octet-stream', 'application/x-binary'],
      limit: `${config.firmwareUploadMaxSizeMb}mb`,
    }),
    async (req, res) => {
      try {
        if (!firmware) {
          res.status(503).json({ error: 'Firmware service not initialized' });
          return;
        }

        if (!isR2Configured(req.params.project)) {
          res.status(503).json({ error: 'R2 storage not configured' });
          return;
        }

        const project = req.params.project;
        const version = req.query.version as string;
        const signature = req.query.signature as string;
        const message = req.query.message as string;

        if (!version) {
          res.status(400).json({ error: 'Missing version query parameter' });
          return;
        }

        if (!FirmwareVersionParser.isPlainSemver(version)) {
          res.status(400).json({
            error:
              'Version must be plain semver MAJOR.MINOR.PATCH (e.g., 1.2.3). Do not include project name, v prefix, or build suffix.',
          });
          return;
        }

        const adminAddresses = getAdminAddresses();
        if (adminAddresses.length === 0) {
          res.status(503).json({ error: 'Admin addresses not configured' });
          return;
        }

        if (!signature || !message) {
          res.status(400).json({ error: 'Missing signature or message query parameters' });
          return;
        }

        const body = req.body as Buffer | undefined;
        if (!body || body.length === 0) {
          res.status(400).json({ error: 'No firmware data' });
          return;
        }

        const sha256 = FirmwareService.computeSha256(body);

        const nonceMatch = message.match(/:([a-f0-9]{64})$/);
        if (!nonceMatch) {
          res.status(400).json({ error: 'Message does not contain valid nonce' });
          return;
        }
        const nonce = nonceMatch[1];

        const expectedMessage = `setup-firmware:${project}:${version}:${sha256}:${nonce}`;
        if (message !== expectedMessage) {
          res.status(400).json({
            error:
              'Message format mismatch (expected setup-firmware:<project>:<version>:<sha256>:<nonce>)',
          });
          return;
        }

        const authResult = adminAuth.verifyAndBurnNonce(nonce, message, signature, adminAddresses);
        if (!authResult.valid) {
          res.status(403).json({ error: authResult.error || 'Signature verification failed' });
          return;
        }

        if (firmware.setupFirmwareExists(project, version)) {
          res.status(409).json({ error: 'Setup version already exists' });
          return;
        }

        const r2Key = `firmware/${project}/setup/${version}/firmware.bin`;
        const url = await uploadFirmwareToR2(project, r2Key, body);
        if (!url) {
          res.status(500).json({ error: 'R2 upload failed' });
          return;
        }

        const metadata = firmware.addSetupFirmware(
          project,
          version,
          sha256,
          body.length,
          r2Key,
          url,
          authResult.address,
          true
        );

        res.json({
          success: true,
          channel: 'setup',
          project: metadata.project,
          version: metadata.version,
          sha256: metadata.sha256,
          size: metadata.size,
          url: metadata.url,
          uploadedBy: metadata.uploadedBy,
        });
      } catch (err) {
        console.error('[Firmware] Setup upload error:', err);
        res.status(500).json({ error: 'Internal error' });
      }
    }
  );

  // Revoke a device: push admin-signed updateReady(purpose=revoke) notice, or queue if offline
  router.post('/firmware/:project/revoke', express.json(), async (req, res) => {
    try {
      if (!firmware) {
        res.status(503).json({ error: 'Firmware service not initialized' });
        return;
      }

      const project = req.params.project;
      const { device, signature, message } = req.body || {};

      if (!device || typeof device !== 'string') {
        res.status(400).json({ error: 'Missing device address' });
        return;
      }

      const adminAddresses = getAdminAddresses();
      if (adminAddresses.length === 0) {
        res.status(503).json({ error: 'Admin addresses not configured' });
        return;
      }

      if (!signature || !message) {
        res.status(400).json({ error: 'Missing signature or message' });
        return;
      }

      const setup = firmware.getSetupFirmware(project);
      if (!setup) {
        res.status(404).json({ error: 'No setup firmware registered for this project' });
        return;
      }

      const nonceMatch = message.match(/:([a-f0-9]{64})$/);
      if (!nonceMatch) {
        res.status(400).json({ error: 'Message does not contain valid nonce' });
        return;
      }
      const nonce = nonceMatch[1];

      const expectedMessage = buildRevokeNoticeMessage(project, device, setup.sha256, nonce);
      if (message !== expectedMessage) {
        res.status(400).json({
          error:
            'Message format mismatch (expected revoke:<project>:<device>:<setupSha256>:<nonce>)',
        });
        return;
      }

      const authResult = adminAuth.verifyAndBurnNonce(nonce, message, signature, adminAddresses);
      if (!authResult.valid) {
        res.status(403).json({ error: authResult.error || 'Signature verification failed' });
        return;
      }

      const revoke = firmware.requestRevoke({
        project,
        device,
        setup,
        noticeMessage: message,
        noticeSignature: signature,
        requestedBy: authResult.address,
      });

      telemetry.recordFirmwareRevoke(
        revoke.device,
        project,
        'requested',
        setup.version,
        undefined,
        getClientIp(req)
      );

      const delivered = tcpService.deliverPendingRevoke(normalizeDeviceAddress(device));

      res.json({
        success: true,
        project,
        device: revoke.device,
        status: delivered ? 'delivered' : 'pending',
        setup: {
          version: setup.version,
          sha256: setup.sha256,
          size: setup.size,
          url: setup.url,
        },
        revokeId: revoke.id,
        revokedBy: authResult.address,
        queued: !delivered,
      });
    } catch (err) {
      console.error('[Firmware] Revoke error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Cancel a pending or delivered-but-not-completed revoke
  router.post('/firmware/:project/revoke/cancel', express.json(), async (req, res) => {
    try {
      if (!firmware) {
        res.status(503).json({ error: 'Firmware service not initialized' });
        return;
      }

      const project = req.params.project;
      const { device, signature, message } = req.body || {};

      if (!device || typeof device !== 'string') {
        res.status(400).json({ error: 'Missing device address' });
        return;
      }

      const adminAddresses = getAdminAddresses();
      if (adminAddresses.length === 0) {
        res.status(503).json({ error: 'Admin addresses not configured' });
        return;
      }

      if (!signature || !message) {
        res.status(400).json({ error: 'Missing signature or message' });
        return;
      }

      const nonceMatch = message.match(/:([a-f0-9]{64})$/);
      if (!nonceMatch) {
        res.status(400).json({ error: 'Message does not contain valid nonce' });
        return;
      }
      const nonce = nonceMatch[1];

      const normalizedDevice = normalizeDeviceAddress(device);
      const expectedMessage = `revoke-cancel:${project}:${normalizedDevice}:${nonce}`;
      if (message !== expectedMessage) {
        res.status(400).json({
          error:
            'Message format mismatch (expected revoke-cancel:<project>:<device>:<nonce>)',
        });
        return;
      }

      const authResult = adminAuth.verifyAndBurnNonce(nonce, message, signature, adminAddresses);
      if (!authResult.valid) {
        res.status(403).json({ error: authResult.error || 'Signature verification failed' });
        return;
      }

      const cancelled = firmware.cancelRevoke(normalizedDevice, project);
      if (!cancelled) {
        res.status(404).json({ error: 'No active revoke found for this device' });
        return;
      }

      telemetry.recordFirmwareRevoke(
        cancelled.device,
        project,
        'cancelled',
        cancelled.setupVersion,
        undefined,
        getClientIp(req)
      );

      res.json({
        success: true,
        project,
        device: cancelled.device,
        status: 'cancelled',
        revokeId: cancelled.id,
        cancelledBy: authResult.address,
      });
    } catch (err) {
      console.error('[Firmware] Revoke cancel error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/firmware/:project/revokes', (req, res) => {
    try {
      if (!firmware) {
        res.status(503).json({ error: 'Firmware service not initialized' });
        return;
      }

      const project = req.params.project;
      const device = typeof req.query.device === 'string' ? req.query.device : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const revokes = firmware.listRevokes(project, {
        device,
        status: status as any,
        limit: 100,
      });

      res.json({ project, revokes });
    } catch (err) {
      console.error('[Firmware] List revokes error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/firmware/:project', express.raw({ type: ['application/octet-stream', 'application/x-binary'], limit: `${config.firmwareUploadMaxSizeMb}mb` }), async (req, res) => {
    try {
      if (!firmware) {
        res.status(503).json({ error: 'Firmware service not initialized' });
        return;
      }

      if (!isR2Configured()) {
        res.status(503).json({ error: 'R2 storage not configured' });
        return;
      }

      const project = req.params.project;
      const version = req.query.version as string;
      const signature = req.query.signature as string;
      const message = req.query.message as string;

      if (!version) {
        res.status(400).json({ error: 'Missing version query parameter' });
        return;
      }

      if (!FirmwareVersionParser.isPlainSemver(version)) {
        res.status(400).json({ 
          error: 'Version must be plain semver MAJOR.MINOR.PATCH (e.g., 1.2.3). Do not include project name, v prefix, or build suffix. This version must match the FIRMWARE_SEMVER in your device firmware.' 
        });
        return;
      }

      const adminAddresses = getAdminAddresses();
      if (adminAddresses.length === 0) {
        res.status(503).json({ error: 'Admin addresses not configured' });
        return;
      }

      if (!signature || !message) {
        res.status(400).json({ error: 'Missing signature or message query parameters' });
        return;
      }

      const body = req.body as Buffer | undefined;
      if (!body || body.length === 0) {
        res.status(400).json({ error: 'No firmware data' });
        return;
      }

      const sha256 = FirmwareService.computeSha256(body);

      // Extract nonce from message
      const nonceMatch = message.match(/:([a-f0-9]{64})$/);
      if (!nonceMatch) {
        res.status(400).json({ error: 'Message does not contain valid nonce' });
        return;
      }
      const nonce = nonceMatch[1];

      // Verify message format: 'firmware:<project>:<version>:<sha256>:<nonce>'
      const expectedMessage = `firmware:${project}:${version}:${sha256}:${nonce}`;
      if (message !== expectedMessage) {
        res.status(400).json({ error: 'Message format mismatch (expected firmware:<project>:<version>:<sha256>:<nonce>)' });
        return;
      }

      const authResult = adminAuth.verifyAndBurnNonce(nonce, message, signature, adminAddresses);
      if (!authResult.valid) {
        res.status(403).json({ error: authResult.error || 'Signature verification failed' });
        return;
      }

      // Check if version already exists
      if (firmware.firmwareExists(project, version)) {
        res.status(409).json({ error: 'Version already exists' });
        return;
      }

      // Upload to R2 (per-project bucket/URL/creds via R2_FIRMWARE_*__PROJECT overrides)
      const r2Key = `firmware/${project}/${version}/firmware.bin`;
      const url = await uploadFirmwareToR2(project, r2Key, body);
      
      if (!url) {
        res.status(500).json({ error: 'R2 upload failed' });
        return;
      }

      // Record metadata
      const metadata = firmware.addFirmware(
        project,
        version,
        sha256,
        body.length,
        r2Key,
        url,
        authResult.address,
        true
      );

      const shouldNotify = req.query.notify === 'true';
      let notifyResult;
      
      if (shouldNotify) {
        try {
          const connectedDevices = tcpService.getConnectedDevices();
          const notified: Array<{ address: string; version: string }> = [];
          
          for (const device of connectedDevices) {
            if (device.project?.toLowerCase() === project.toLowerCase() && device.semver) {
              const isOlderResult = FirmwareVersionParser.isOlder(device.semver, version);
              if (isOlderResult === true) {
                await tcpService.sendApiCallToDevice(device.address, 'updateReady', {});
                notified.push({ address: device.address, version: device.semver });
                telemetry.recordFirmwareNotify(device.address, project, version);
              }
            }
          }
          notifyResult = { notified: notified.length };
        } catch (err) {
          console.error('[Firmware] Auto-notify error:', err);
        }
      }

      res.json({
        success: true,
        project: metadata.project,
        version: metadata.version,
        sha256: metadata.sha256,
        size: metadata.size,
        url: metadata.url,
        uploadedBy: metadata.uploadedBy,
        ...(notifyResult ? { notified: notifyResult.notified } : {})
      });
    } catch (err) {
      console.error('[Firmware] Upload error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ========== Passkey / WebAuthn routes (GarageDoorKey wallet) ==========
  router.get('/passkey/registration-challenge', async (req, res) => {
    try {
      const username = (req.query.username as string) || 'garage-user';
      const result = await passkey.getRegistrationChallenge(username);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  router.post('/passkey/verify-registration-challenge', async (req, res) => {
    try {
      const { sessionId, attestationResponse } = req.body || {};
      if (!sessionId || !attestationResponse) {
        res.status(400).json({ success: false, error: 'Missing sessionId or attestationResponse' });
        return;
      }
      const result = await passkey.verifyRegistration(sessionId, attestationResponse);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  router.get('/passkey/build-auth-challenge', async (req, res) => {
    try {
      const result = await passkey.getAuthChallenge();
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  router.get('/passkey/build-auth-challenge/:credentialId', async (req, res) => {
    try {
      const credentialId = req.params.credentialId;
      const result = await passkey.getAuthChallenge(credentialId);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  router.post('/passkey/verify-auth-challenge', async (req, res) => {
    try {
      const { sessionId, assertionResponse } = req.body || {};
      if (!sessionId || !assertionResponse) {
        res.status(400).json({ success: false, error: 'Missing sessionId or assertionResponse' });
        return;
      }
      const result = await passkey.verifyAuth(sessionId, assertionResponse);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  // Recovery API: passkey storage for cross-device sync
  router.put('/v1/passkeys', async (req, res) => {
    try {
      const { credentialId, rpId, xyHex } = req.body || {};
      if (!credentialId || !rpId || !xyHex) {
        res.status(400).json({ error: 'Missing credentialId, rpId, or xyHex' });
        return;
      }
      passkey.upsertPasskey(credentialId, rpId, xyHex);
      res.status(200).send();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/v1/passkeys/:credentialId', async (req, res) => {
    try {
      const credentialId = req.params.credentialId;
      const record = passkey.getPasskey(credentialId);
      if (!record) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json(record);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ========== Telemetry routes (must come before catch-all device routes) ==========
  router.get('/telemetry/system', telemetryAuthMiddleware, (req, res) => {
    try {
      const since = req.query.since ? new Date(req.query.since as string).getTime() : undefined;
      if (req.query.since && isNaN(since!)) {
        res.status(400).json({ error: 'Invalid since timestamp' });
        return;
      }
      const metrics = telemetry.getSystemMetrics(since);
      res.json(metrics);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/telemetry/devices', telemetryAuthMiddleware, (req, res) => {
    try {
      const since = req.query.since ? new Date(req.query.since as string).getTime() : undefined;
      if (req.query.since && isNaN(since!)) {
        res.status(400).json({ error: 'Invalid since timestamp' });
        return;
      }
      const devices = telemetry.getAllDeviceMetrics(since);
      
      if (firmware) {
        for (const device of devices) {
          if (device.firmwareVersion) {
            const parsed = FirmwareVersionParser.parse(device.firmwareVersion);
            if (parsed) {
              const latest = firmware.getLatestFirmware(parsed.project);
              if (latest && latest.version !== parsed.semver) {
                const isOlder = FirmwareVersionParser.isOlder(parsed.semver, latest.version);
                (device as any).project = parsed.project;
                (device as any).version = parsed.semver;
                (device as any).updateAvailable = isOlder;
              } else {
                (device as any).project = parsed.project;
                (device as any).version = parsed.semver;
                (device as any).updateAvailable = false;
              }
            }
          }
        }
      }
      
      res.json(devices);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/telemetry/devices/silent', telemetryAuthMiddleware, (req, res) => {
    try {
      const cadenceMultiplier = req.query.cadenceMultiplier 
        ? parseFloat(req.query.cadenceMultiplier as string)
        : 3;
      const minSilenceMs = req.query.minSilenceMs
        ? parseInt(req.query.minSilenceMs as string)
        : 15 * 60 * 1000;
      const includeRetired = req.query.includeRetired === 'true';

      if (cadenceMultiplier < 0 || minSilenceMs < 0) {
        res.status(400).json({ error: 'Invalid parameters' });
        return;
      }

      const silentDevices = telemetry.getSilentDevices({
        cadenceMultiplier,
        minSilenceMs,
        includeRetired,
      });

      res.json({ 
        devices: silentDevices,
        params: { cadenceMultiplier, minSilenceMs, includeRetired },
        serverTime: Date.now(),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/telemetry/devices/:address', telemetryAuthMiddleware, (req, res) => {
    try {
      const address = normalizeAddress(req.params.address);
      const since = req.query.since ? new Date(req.query.since as string).getTime() : undefined;
      if (req.query.since && isNaN(since!)) {
        res.status(400).json({ error: 'Invalid since timestamp' });
        return;
      }
      const metrics = telemetry.getDeviceMetrics(address, since);
      if (!metrics) {
        res.status(404).json({ error: 'Device not found' });
        return;
      }
      res.json(metrics);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/telemetry/methods', telemetryAuthMiddleware, (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const since = req.query.since ? new Date(req.query.since as string).getTime() : undefined;
      if (req.query.since && isNaN(since!)) {
        res.status(400).json({ error: 'Invalid since timestamp' });
        return;
      }
      const methods = telemetry.getTopMethods(limit, since);
      res.json(methods);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/telemetry/events', telemetryAuthMiddleware, (req, res) => {
    try {
      const since = req.query.since ? new Date(req.query.since as string).getTime() : undefined;
      if (req.query.since && isNaN(since!)) {
        res.status(400).json({ error: 'Invalid since timestamp' });
        return;
      }
      const device = req.query.device as string | undefined;
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;

      if (limit < 1 || limit > 1000) {
        res.status(400).json({ error: 'Limit must be between 1 and 1000' });
        return;
      }

      const result = telemetry.getEvents({ since, device, limit, offset });
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/telemetry/devices/:address/retired', telemetryAuthMiddleware, (req, res) => {
    try {
      const address = normalizeAddress(req.params.address);
      const { retired, notes } = req.body || {};

      if (typeof retired !== 'boolean') {
        res.status(400).json({ error: 'Missing or invalid retired boolean' });
        return;
      }

      telemetry.markDeviceRetired(address, retired, notes);
      res.json({ success: true, address, retired, notes: notes || null });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/telemetry/devices/:address/diagnostics', telemetryAuthMiddleware, (req, res) => {
    try {
      const address = normalizeAddress(req.params.address);
      const diagnostics = req.body || {};

      telemetry.recordDeviceDiagnostics(address, diagnostics);
      res.json({ success: true, address });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ========== Zigbee gateway diagnostics ==========
  // Device POST path matches firmware (diag.c): Host header independent.
  router.post('/diag/zbgw', zbgwDiagAuthMiddleware, (req, res) => {
    try {
      if (!zigbee) {
        res.status(503).json({ error: 'Zigbee diagnostics service not initialized' });
        return;
      }

      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ error: 'Expected JSON object body' });
        return;
      }

      const payloadBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
      if (payloadBytes > ZBGW_MAX_PAYLOAD_BYTES) {
        res.status(413).json({ error: `Payload exceeds ${ZBGW_MAX_PAYLOAD_BYTES} bytes` });
        return;
      }

      const deviceId = body.device_id ?? body.mac ?? body.deviceId;
      if (typeof deviceId !== 'string' || !deviceId.trim()) {
        res.status(400).json({ error: 'Missing device_id' });
        return;
      }

      const kind = typeof body.kind === 'string' && body.kind ? body.kind : 'unknown';
      const clientIp = getClientIp(req);
      const result = zigbee.recordEvent(deviceId, kind, body as Record<string, unknown>, clientIp);

      // Firmware (diag.c) expects { "commands": [ { "action": "restart" }, ... ] }
      res.json({ commands: result.commands });
    } catch (err) {
      console.error('[ZigbeeDiag] Device POST error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/diag/zbgw/gateways', telemetryAuthMiddleware, (_req, res) => {
    try {
      if (!zigbee) {
        res.status(503).json({ error: 'Zigbee diagnostics service not initialized' });
        return;
      }
      res.json({
        gateways: zigbee.listGateways(),
        serverTime: Date.now(),
      });
    } catch (err) {
      console.error('[ZigbeeDiag] List gateways error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/diag/zbgw/events', telemetryAuthMiddleware, (req, res) => {
    try {
      if (!zigbee) {
        res.status(503).json({ error: 'Zigbee diagnostics service not initialized' });
        return;
      }

      const afterId = parseInt(req.query.afterId as string) || 0;
      const limit = Math.min(
        parseInt(req.query.limit as string) || 1000,
        config.telemetryFeedMaxLimit
      );

      const feed = zigbee.getEventsFeed(afterId, limit);
      res.json({
        rows: feed.rows,
        maxId: feed.maxId,
        hasMore: feed.hasMore,
        serverTime: Date.now(),
      });
    } catch (err) {
      console.error('[ZigbeeDiag] Events feed error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/diag/zbgw/ack', telemetryAuthMiddleware, async (req, res) => {
    try {
      if (!zigbee) {
        res.status(503).json({ error: 'Zigbee diagnostics service not initialized' });
        return;
      }

      const { upToId, signature, message, dryRun } = req.body || {};

      if (!upToId || typeof upToId !== 'number') {
        res.status(400).json({ error: 'Missing or invalid upToId' });
        return;
      }

      const adminAddresses = getAdminAddresses();
      if (adminAddresses.length === 0) {
        res.status(503).json({ error: 'Admin addresses not configured' });
        return;
      }

      if (!signature || !message) {
        res.status(400).json({ error: 'Missing signature or message' });
        return;
      }

      const nonceMatch = message.match(/:([a-f0-9]{64})$/);
      if (!nonceMatch) {
        res.status(400).json({ error: 'Message does not contain valid nonce' });
        return;
      }
      const nonce = nonceMatch[1];

      // Message format: 'zbgw-ack:<upToId>:<nonce>'
      const expectedMessagePrefix = `zbgw-ack:${upToId}:`;
      if (!message.startsWith(expectedMessagePrefix)) {
        res.status(400).json({ error: 'Message format mismatch' });
        return;
      }

      const result = adminAuth.verifyAndBurnNonce(nonce, message, signature, adminAddresses);
      if (!result.valid) {
        res.status(403).json({ error: result.error || 'Signature verification failed' });
        return;
      }

      const forceDryRun = !config.telemetryAckEnabled;
      const effectiveDryRun = dryRun || forceDryRun;

      if (effectiveDryRun) {
        res.json({
          wouldDelete: zigbee.countEventsUpTo(upToId),
          dryRun: true,
          reason: forceDryRun ? 'TELEMETRY_ACK_ENABLED=false' : 'dryRun requested',
        });
        return;
      }

      const { deleted, remaining } = zigbee.deleteEventsUpTo(upToId);
      res.json({
        deleted,
        remaining,
        deletedBy: result.address,
      });
    } catch (err) {
      console.error('[ZigbeeDiag] Ack error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/diag/zbgw/commands', telemetryAuthMiddleware, async (req, res) => {
    try {
      if (!zigbee) {
        res.status(503).json({ error: 'Zigbee diagnostics service not initialized' });
        return;
      }

      const { mac, action, signature, message } = req.body || {};

      if (!mac || typeof mac !== 'string') {
        res.status(400).json({ error: 'Missing mac' });
        return;
      }
      if (!action || typeof action !== 'string') {
        res.status(400).json({ error: 'Missing action' });
        return;
      }
      if (!isAllowedAction(action)) {
        res.status(400).json({ error: `Unsupported action (allowed: restart, ota_check)` });
        return;
      }

      const adminAddresses = getAdminAddresses();
      if (adminAddresses.length === 0) {
        res.status(503).json({ error: 'Admin addresses not configured' });
        return;
      }

      if (!signature || !message) {
        res.status(400).json({ error: 'Missing signature or message' });
        return;
      }

      const nonceMatch = message.match(/:([a-f0-9]{64})$/);
      if (!nonceMatch) {
        res.status(400).json({ error: 'Message does not contain valid nonce' });
        return;
      }
      const nonce = nonceMatch[1];

      // Message format: 'zbgw-cmd:<mac>:<action>:<nonce>'
      const expectedMessage = `zbgw-cmd:${mac}:${action}:${nonce}`;
      if (message !== expectedMessage) {
        res.status(400).json({ error: 'Message format mismatch' });
        return;
      }

      const authResult = adminAuth.verifyAndBurnNonce(nonce, message, signature, adminAddresses);
      if (!authResult.valid) {
        res.status(403).json({ error: authResult.error || 'Signature verification failed' });
        return;
      }

      const command = zigbee.queueCommand(mac, action, authResult.address);
      res.json({
        success: true,
        command,
        queuedBy: authResult.address,
      });
    } catch (err) {
      console.error('[ZigbeeDiag] Queue command error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ========== Camera upload (called by Remote Camera device) ==========
  router.post('/camera/upload', express.raw({ type: 'image/jpeg', limit: '3mb' }), async (req, res) => {
    try {
      const requestId = (req.query.requestId as string) || '';
      if (!requestId) {
        res.status(400).send('Missing requestId');
        return;
      }
      if (!isR2Configured()) {
        res.status(503).send('R2 not configured');
        return;
      }
      const body = req.body as Buffer | undefined;
      if (!body || body.length === 0) {
        res.status(400).send('No image data');
        return;
      }
      const key = `camera/${requestId}.jpg`;
      const url = await uploadToR2(key, body);
      if (!url) {
        res.status(500).send('Upload failed');
        return;
      }
      res.status(200).send(url);
    } catch (err) {
      console.error('[Camera upload]', err);
      res.status(500).send('Internal error');
    }
  });

  // ========== IoT device routes ==========
  async function handleApiCall(req: Request, res: Response, asyncPath: boolean): Promise<void> {
    const startTime = Date.now();
    const address = normalizeAddress(req.params.Address);
    const method = req.params.method;
    const clientIp = getClientIp(req);
    const clientDesignator = clientIp + '-' + address + method;
    console.log('[TS-Proxy] ADDRESS:', address, 'METHOD:', method);
    const argMap = parseQueryParams(req);

    // takePicture: inject requestId and uploadUrl for the camera
    if (method === 'takePicture') {
      const requestId = randomUUID();
      const base = getProxyBaseUrl(req);
      const uploadUrl = `${base}/api/camera/upload?requestId=${requestId}`;
      argMap['requestId'] = [requestId];
      argMap['uploadUrl'] = [uploadUrl];
    }

    const isGetChallenge = method === 'getChallenge';
    let rateCounts: { last60s: number; last10m: number } | undefined;
    if (isGetChallenge) {
      rateCounts = getChallengeIpCounter.record(clientIp);
    }

    // Prefer successful responses over error messages
    const isSuccess = (r: string) =>
      r !== 'No device found' &&
      r !== 'Timed out' &&
      r !== 'API send error' &&
      r !== '';

    let response: string;
    let success: boolean;
    try {
      const [responseUDP, responseTCP] = await Promise.all([
        service.getResponse(address, method, argMap, clientDesignator),
        tcpService.getResponse(address, method, argMap, clientDesignator),
      ]);

      if (isSuccess(responseTCP)) {
        response = responseTCP;
      } else if (isSuccess(responseUDP)) {
        response = responseUDP;
      } else {
        // Both failed, prefer TCP error message
        response = responseTCP ?? responseUDP;
      }
      success = isSuccess(response);
    } catch (err) {
      const responseTime = Date.now() - startTime;
      if (isGetChallenge) {
        const connected = tcpService.getConnectedDevices().find((d) => d.address === address.toLowerCase());
        telemetry.recordGetChallengeFailed({
          address,
          ipAddress: clientIp,
          reason: 'exception',
          durationMs: responseTime,
          project: connected?.project,
          requests60s: rateCounts?.last60s,
          requests10m: rateCounts?.last10m,
        });
        console.warn(
          '[getChallenge] failed',
          'ip=' + clientIp,
          'device=' + address,
          'reason=exception',
          'ms=' + responseTime,
          'req60s=' + rateCounts?.last60s,
          'req10m=' + rateCounts?.last10m,
          err instanceof Error ? err.message : err
        );
      }
      throw err;
    }

    const responseTime = Date.now() - startTime;

    // Always record api_call (existing behaviour). getChallenge successes are also
    // counted in the in-memory per-IP rate counter for flood spotting (no extra row).
    telemetry.recordApiCall(address, method, success, responseTime, clientIp);

    if (isGetChallenge && !success) {
      const connected = tcpService.getConnectedDevices().find((d) => d.address === address.toLowerCase());
      const reason = classifyGetChallengeFailure(response);
      telemetry.recordGetChallengeFailed({
        address,
        ipAddress: clientIp,
        reason,
        durationMs: responseTime,
        project: connected?.project,
        requests60s: rateCounts?.last60s,
        requests10m: rateCounts?.last10m,
      });
      console.warn(
        '[getChallenge] failed',
        'ip=' + clientIp,
        'device=' + address,
        'reason=' + reason,
        'ms=' + responseTime,
        'req60s=' + rateCounts?.last60s,
        'req10m=' + rateCounts?.last10m
      );
    } else if (isGetChallenge && success && rateCounts && rateCounts.last60s >= 30) {
      console.warn(
        '[getChallenge] high rate',
        'ip=' + clientIp,
        'device=' + address,
        'req60s=' + rateCounts.last60s,
        'req10m=' + rateCounts.last10m
      );
    }

    res.status(201).send(response);
  }

  router.all('/:Address/:method', async (req, res) => {
    try {
      await handleApiCall(req, res, false);
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal error');
    }
  });

  router.all('/async/:Address/:method', async (req, res) => {
    try {
      await handleApiCall(req, res, true);
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal error');
    }
  });

  router.all('/getEthAddress', async (req, res) => {
    try {
      const ipAddress = getClientIp(req);
      const [udpAddrs, tcpAddrs] = await Promise.all([
        service.getDeviceAddress(ipAddress),
        tcpService.getDeviceAddress(ipAddress),
      ]);
      const returnAddrs = 'UDP: ' + udpAddrs + '\n' + 'TCP: ' + tcpAddrs;
      res.status(201).send(returnAddrs);
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal error');
    }
  });

  router.all('/bridge/:Address/:data', async (req, res) => {
    try {
      const address = normalizeAddress(req.params.Address);
      const method = req.params.data;
      const clientIp = getClientIp(req);
      const clientDesignator = clientIp + '-' + address + method;
      console.log('ADDRESS:', address);
      console.log('METHOD:', method);
      console.log('Designator:', clientDesignator);

      const response = tcpService.handleDeviceConnection(address, method, clientIp);
      res.status(201).send(response);
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal error');
    }
  });

  router.all('/bridge/login', async (req, res) => {
    try {
      const clientIp = getClientIp(req);
      console.log('Login:', clientIp);
      const response = tcpService.getLoginChallenge(clientIp);
      res.status(201).send(response);
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal error');
    }
  });

  router.all('/smartpass/:attestation', (_req, res) => {
    const response = '{"quests": 4, "points": 450, "level": 1 }';
    res.status(201).send(response);
  });

  // Unrecognised /api/* paths: immediately reset connection
  router.use((req, _res) => {
    if (req.socket?.writable) {
      req.socket.destroy();
    }
  });

  return router;
}
