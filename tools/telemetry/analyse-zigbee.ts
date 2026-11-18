#!/usr/bin/env ts-node
/**
 * Zigbee Diagnostics Analysis Tool
 *
 * Analyzes Zigbee gateway JSONL for:
 * - Silent gateways (no recent poll/ok/boot)
 * - Watchdog / reset reasons
 * - Wi-Fi / MQTT flaps
 * - OTA failures
 * - Unknown-device descriptor dumps
 *
 * Usage:
 *   npm run telemetry:zigbee:analyse [-- data/zigbee-YYYYMMDD.jsonl]
 *   OR: ts-node tools/telemetry/analyse-zigbee.ts [data/zigbee-YYYYMMDD.jsonl]
 */

import { config } from 'dotenv';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const envPaths = [
  join(__dirname, '.env'),
  join(__dirname, '..', '..', '.env'),
];
for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    config({ path: envPath });
    break;
  }
}

interface ZigbeeEventRow {
  id: number;
  mac: string;
  kind: string;
  payload: Record<string, any>;
  receivedAt: number;
}

interface GatewayAnalysis {
  mac: string;
  eventCount: number;
  lastSeen: number;
  lastKind: string;
  firmwareVersion?: string;
  silent: boolean;
  silentHours: number;
  resetReasons: Map<string, number>;
  watchdogRestarts: number;
  wifiFlaps: number;
  mqttFlaps: number;
  otaFailures: Array<{ code?: string; message?: string; at: number }>;
  unknownDevices: Array<{ at: number; dump: Record<string, any> }>;
  errorCodes: Map<string, number>;
}

const SILENT_THRESHOLD_MS = 10 * 60 * 1000; // ~5 poll intervals of 2 min

function parseJsonlFile(path: string): ZigbeeEventRow[] {
  const content = readFileSync(path, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

function findLatestFile(): string | null {
  const dataDir = join(__dirname, '..', '..', 'data');
  try {
    const files = readdirSync(dataDir)
      .filter(f => f.startsWith('zigbee-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();
    return files.length > 0 ? join(dataDir, files[0]) : null;
  } catch {
    return null;
  }
}

function analyzeGateway(mac: string, events: ZigbeeEventRow[], now: number): GatewayAnalysis {
  const sorted = [...events].sort((a, b) => a.receivedAt - b.receivedAt);
  const last = sorted[sorted.length - 1];
  const resetReasons = new Map<string, number>();
  const errorCodes = new Map<string, number>();
  const otaFailures: GatewayAnalysis['otaFailures'] = [];
  const unknownDevices: GatewayAnalysis['unknownDevices'] = [];

  let wifiFlaps = 0;
  let mqttFlaps = 0;
  let prevMqtt: boolean | undefined;
  let prevWifiOk: boolean | undefined;
  let watchdogRestarts = 0;
  let firmwareVersion: string | undefined;

  for (const ev of sorted) {
    const p = ev.payload || {};
    if (typeof p.fw === 'string') firmwareVersion = p.fw;

    const reset = typeof p.reset === 'string' ? p.reset : undefined;
    if (reset) {
      resetReasons.set(reset, (resetReasons.get(reset) || 0) + 1);
      if (reset === 'watchdog' || /wdt/i.test(reset)) {
        watchdogRestarts++;
      }
    }

    if (ev.kind === 'boot' && reset === 'watchdog') {
      watchdogRestarts++;
    }

    if (typeof p.mqtt_ok === 'boolean') {
      if (prevMqtt === true && p.mqtt_ok === false) mqttFlaps++;
      prevMqtt = p.mqtt_ok;
    }

    const wifiDown = typeof p.wifi_rssi === 'number' ? p.wifi_rssi === 0 : undefined;
    if (wifiDown !== undefined) {
      if (prevWifiOk === true && wifiDown) wifiFlaps++;
      prevWifiOk = !wifiDown;
    }

    const code = typeof p.code === 'string' ? p.code : undefined;
    if (ev.kind === 'error' && code) {
      errorCodes.set(code, (errorCodes.get(code) || 0) + 1);
      if (/^ota_/i.test(code)) {
        otaFailures.push({
          code,
          message: typeof p.message === 'string' ? p.message : undefined,
          at: ev.receivedAt,
        });
      }
    }

    const unknown =
      p.unknown_device ||
      p.unknownDevice ||
      (ev.kind === 'device-added' || ev.kind === 'device' ? p.device || p.descriptor : undefined);

    if (unknown && typeof unknown === 'object') {
      unknownDevices.push({ at: ev.receivedAt, dump: unknown });
    } else if (
      (ev.kind === 'device-added' || (ev.kind === 'device' && code === 'device-added')) &&
      (p.endpoints || p.clusters || p.manufacturer || p.model)
    ) {
      unknownDevices.push({
        at: ev.receivedAt,
        dump: {
          endpoints: p.endpoints,
          clusters: p.clusters,
          manufacturer: p.manufacturer,
          model: p.model,
          power_source: p.power_source || p.powerSource,
          message: p.message,
          code: p.code,
        },
      });
    }
  }

  const silentDuration = now - (last?.receivedAt || 0);
  const silent = !last || silentDuration > SILENT_THRESHOLD_MS;

  return {
    mac,
    eventCount: sorted.length,
    lastSeen: last?.receivedAt || 0,
    lastKind: last?.kind || 'none',
    firmwareVersion,
    silent,
    silentHours: silentDuration / (60 * 60 * 1000),
    resetReasons,
    watchdogRestarts,
    wifiFlaps,
    mqttFlaps,
    otaFailures,
    unknownDevices,
    errorCodes,
  };
}

function generateReport(analyses: GatewayAnalysis[], now: number): string {
  let md = '# Zigbee Gateway Diagnostics Report\n\n';
  md += `Generated: ${new Date(now).toISOString()}\n\n`;
  md += `Total gateways: ${analyses.length}\n\n`;

  const silent = analyses.filter(a => a.silent);
  const withWatchdog = analyses.filter(a => a.watchdogRestarts > 0);
  const withOtaFail = analyses.filter(a => a.otaFailures.length > 0);
  const withUnknown = analyses.filter(a => a.unknownDevices.length > 0);

  md += '## Summary\n\n';
  md += `- Silent gateways (>${SILENT_THRESHOLD_MS / 60000} min since last event): ${silent.length}\n`;
  md += `- Watchdog restarts observed: ${withWatchdog.length} gateway(s)\n`;
  md += `- OTA failures: ${withOtaFail.length} gateway(s)\n`;
  md += `- Unknown-device dumps: ${withUnknown.length} gateway(s)\n\n`;

  if (silent.length > 0) {
    md += '## Silent Gateways\n\n';
    for (const a of silent.sort((x, y) => y.silentHours - x.silentHours)) {
      md += `### \`${a.mac}\`\n\n`;
      md += `- Silent for: ${a.silentHours.toFixed(1)} hours\n`;
      md += `- Last seen: ${a.lastSeen ? new Date(a.lastSeen).toISOString() : 'never'} (${a.lastKind})\n`;
      if (a.firmwareVersion) md += `- Firmware: ${a.firmwareVersion}\n`;
      md += '\n';
    }
  }

  md += '## Gateway Details\n\n';
  for (const a of analyses.sort((x, y) => y.lastSeen - x.lastSeen)) {
    md += `### \`${a.mac}\`\n\n`;
    if (a.firmwareVersion) md += `**Firmware:** ${a.firmwareVersion}\n\n`;
    md += `**Events:** ${a.eventCount} | **Last:** ${a.lastSeen ? new Date(a.lastSeen).toISOString() : 'n/a'} (${a.lastKind})\n\n`;

    if (a.resetReasons.size > 0) {
      md += '**Reset reasons:**\n';
      for (const [reason, count] of Array.from(a.resetReasons.entries()).sort((x, y) => y[1] - x[1])) {
        md += `- ${reason}: ${count}\n`;
      }
      md += '\n';
    }

    if (a.watchdogRestarts > 0) {
      md += `**Watchdog restarts:** ${a.watchdogRestarts}\n\n`;
    }

    if (a.wifiFlaps > 0 || a.mqttFlaps > 0) {
      md += `**Connectivity flaps:** Wi-Fi ${a.wifiFlaps}, MQTT ${a.mqttFlaps}\n\n`;
    }

    if (a.errorCodes.size > 0) {
      md += '**Error codes:**\n';
      for (const [code, count] of Array.from(a.errorCodes.entries()).sort((x, y) => y[1] - x[1])) {
        md += `- \`${code}\`: ${count}\n`;
      }
      md += '\n';
    }

    if (a.otaFailures.length > 0) {
      md += '**OTA failures:**\n';
      for (const f of a.otaFailures.slice(-5)) {
        md += `- ${new Date(f.at).toISOString()}: ${f.code || '?'}${f.message ? ` — ${f.message}` : ''}\n`;
      }
      md += '\n';
    }

    if (a.unknownDevices.length > 0) {
      md += '**Unknown-device dumps:**\n';
      for (const u of a.unknownDevices.slice(-5)) {
        md += `- ${new Date(u.at).toISOString()}:\n`;
        md += '```json\n' + JSON.stringify(u.dump, null, 2) + '\n```\n';
      }
      md += '\n';
    }

    md += '---\n\n';
  }

  return md;
}

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  let inputFile = args[0];

  if (!inputFile) {
    const latest = findLatestFile();
    if (!latest) {
      console.error('Error: No zigbee-*.jsonl file found. Run telemetry:zigbee:pull first.');
      process.exit(1);
    }
    inputFile = latest;
    console.error(`Using latest file: ${inputFile}\n`);
  }

  console.error(`Analyzing: ${inputFile}\n`);
  const events = parseJsonlFile(inputFile);
  console.error(`Loaded ${events.length} events\n`);

  const byMac = new Map<string, ZigbeeEventRow[]>();
  for (const ev of events) {
    const list = byMac.get(ev.mac) || [];
    list.push(ev);
    byMac.set(ev.mac, list);
  }

  const now = Date.now();
  const analyses = Array.from(byMac.entries()).map(([mac, evs]) => analyzeGateway(mac, evs, now));
  console.log(generateReport(analyses, now));
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
