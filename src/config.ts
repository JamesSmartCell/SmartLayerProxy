import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseTrustedProxies } from './util/ip';
import type { ProxyProtocolUntrustedAction } from './util/proxyProtocol';

export interface Config {
  serverPort: number;
  udpPort: number;
  tcpPort: number;
  telemetryDbPath: string;
  telemetryRetentionDays: number;
  telemetryApiKey?: string;
  telemetryAdminAddresses: string[];
  adminAddresses: string[];
  telemetryAckEnabled: boolean;
  telemetryFeedMaxLimit: number;
  firmwareUploadMaxSizeMb: number;
  trustProxy: boolean;
  /**
   * Peers allowed to send PROXY protocol / whose X-Forwarded-For we trust.
   * Default: 127.0.0.1,::1 (SSH reverse-tunnel / local Caddy).
   */
  proxyProtocolTrusted: string[];
  /**
   * When an untrusted peer sends a PROXY-looking header:
   * - ignore (default): treat bytes as application data (do not rewrite IP)
   * - reject: close the connection
   */
  proxyProtocolUntrusted: ProxyProtocolUntrustedAction;
  /** Comma-separated shared product tokens for Zigbee gateway diagnostics (X-ZBGW-Diag). */
  zbgwDiagTokens: string[];
  zigbeeDbPath: string;
}

function loadProperties(): Record<string, string> {
  const paths = [
    join(process.cwd(), 'application.properties'),
    join(__dirname, '..', 'application.properties'),
    join(process.cwd(), '..', 'src', 'main', 'resources', 'application.properties'),
    join(__dirname, '..', '..', 'src', 'main', 'resources', 'application.properties'),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8');
      const props: Record<string, string> = {};
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith(';') && !trimmed.startsWith('#')) {
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const key = trimmed.substring(0, eq).trim();
            const val = trimmed.substring(eq + 1).trim();
            props[key] = val;
          }
        }
      }
      return props;
    }
  }

  return {};
}

function parseAddressList(value?: string): string[] {
  if (!value) return [];
  return value.split(',').map(a => a.trim()).filter(a => a.length > 0);
}

export function loadConfig(): Config {
  const props = loadProperties();
  const telemetryDbPath = process.env.TELEMETRY_DB_PATH || props['telemetry.db.path'] || './data/telemetry.db';
  return {
    serverPort: parseInt(props['server.port'] || '8081', 10),
    udpPort: parseInt(props['udp.port'] || '8083', 10),
    tcpPort: parseInt(props['tcp.port'] || '8082', 10),
    telemetryDbPath,
    telemetryRetentionDays: parseInt(process.env.TELEMETRY_RETENTION_DAYS || props['telemetry.retention.days'] || '30', 10),
    telemetryApiKey: process.env.TELEMETRY_API_KEY || props['telemetry.api.key'],
    telemetryAdminAddresses: parseAddressList(
      process.env.TELEMETRY_ADMIN_ADDRESSES || props['telemetry.admin.addresses']
    ),
    adminAddresses: parseAddressList(
      process.env.ADMIN_ADDRESSES || props['admin.addresses']
    ),
    telemetryAckEnabled: (process.env.TELEMETRY_ACK_ENABLED || props['telemetry.ack.enabled'] || 'false').toLowerCase() === 'true',
    telemetryFeedMaxLimit: parseInt(
      process.env.TELEMETRY_FEED_MAX_LIMIT || props['telemetry.feed.max.limit'] || '5000', 10
    ),
    firmwareUploadMaxSizeMb: parseInt(
      process.env.FIRMWARE_UPLOAD_MAX_SIZE_MB || props['firmware.upload.max.size.mb'] || '10', 10
    ),
    trustProxy: (process.env.TRUST_PROXY || props['trust.proxy'] || 'false').toLowerCase() === 'true',
    proxyProtocolTrusted: parseTrustedProxies(
      process.env.PROXY_PROTOCOL_TRUSTED ||
        process.env.TRUSTED_PROXIES ||
        props['proxy.protocol.trusted'] ||
        props['trusted.proxies']
    ),
    proxyProtocolUntrusted: parseUntrustedAction(
      process.env.PROXY_PROTOCOL_UNTRUSTED || props['proxy.protocol.untrusted']
    ),
    zbgwDiagTokens: parseAddressList(
      process.env.ZBGW_DIAG_TOKENS || props['zbgw.diag.tokens']
    ),
    zigbeeDbPath:
      process.env.ZIGBEE_DB_PATH ||
      props['zigbee.db.path'] ||
      telemetryDbPath.replace(/telemetry\.db$/, 'zigbee.db'),
  };
}

function parseUntrustedAction(value?: string): ProxyProtocolUntrustedAction {
  const v = (value || 'ignore').toLowerCase().trim();
  return v === 'reject' ? 'reject' : 'ignore';
}
