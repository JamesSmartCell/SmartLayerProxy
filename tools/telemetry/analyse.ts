#!/usr/bin/env ts-node
/**
 * Telemetry Analysis Tool
 * 
 * Analyzes telemetry data for patterns:
 * - Per-device reconnect storms
 * - Signature/auth failures
 * - Timeouts vs keepalive issues
 * - Failing/slow API methods
 * - Silent devices (expected but not connecting)
 * - Attribution: proxy vs Web3E TcpBridge/UdpBridge vs device firmware
 * 
 * Usage:
 *   npm run telemetry:analyse [-- data/telemetry-YYYYMMDD.jsonl] [--api-url=http://localhost:8081] [--api-key=...]
 *   OR: ts-node tools/telemetry/analyse.ts [data/telemetry-YYYYMMDD.jsonl] [--api-url=...] [--api-key=...]
 * 
 * For silent device analysis, provide --api-url and --api-key flags.
 * These can also be set in tools/telemetry/.env as TELEMETRY_API_URL and TELEMETRY_API_KEY.
 * 
 * Outputs markdown report to stdout
 */

import { config } from 'dotenv';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// Try loading .env from multiple locations
const envPaths = [
  join(__dirname, '.env'),                    // tools/telemetry/.env
  join(__dirname, '..', '..', '.env'),        // repo root .env
];
for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    config({ path: envPath });
    break;
  }
}

interface Event {
  id: number;
  timestamp: number;
  device: string;
  eventType:
    | 'connect'
    | 'disconnect'
    | 'api_call'
    | 'firmware_notify'
    | 'firmware_revoke_requested'
    | 'firmware_revoke_delivered'
    | 'firmware_revoke_acknowledged'
    | 'firmware_revoke_completed'
    | 'firmware_revoke_cancelled'
    | 'get_challenge_failed'
    | 'ip_pin_violation'
    | 'rpc_call';
  protocol?: 'UDP' | 'TCP';
  disconnectReason?: string;
  apiMethod?: string;
  apiSuccess?: boolean;
  apiResponseTime?: number;
  ipAddress?: string;
  firmwareVersion?: string;
  firmwareProject?: string;
  failureReason?: string;
  requests60s?: number;
  requests10m?: number;
}

interface DeviceSession {
  device: string;
  connectTime: number;
  disconnectTime?: number;
  disconnectReason?: string;
  duration?: number;
  protocol?: string;
}

interface DeviceAnalysis {
  device: string;
  totalSessions: number;
  avgSessionDuration: number;
  reconnectCount: number;
  reconnectStorm: boolean;
  authFailures: number;
  signatureFailures: number;
  timeouts: number;
  apiCalls: number;
  apiFailures: number;
  slowApiCalls: number;
  avgApiResponseTime: number;
  methodStats: Map<string, { count: number; failures: number; avgTime: number }>;
  likelyCause: string;
  firmwareVersion?: string;
}

interface SilentDevice {
  address: string;
  firstSeen: number;
  lastSeen: number;
  lastFirmwareVersion?: string;
  lastDisconnectReason?: string;
  medianReconnectGapMs?: number;
  silentDurationMs: number;
  expectedReconnectMs: number;
  lastEvents: Event[];
  lastDiagnostics?: {
    resetReason?: string;
    bootCount?: number;
    wifiAttempts?: number;
    connectTimeMs?: number;
    networkIndex?: number;
    ssidHash?: string;
    lastFailureStage?: string;
  };
  retired: boolean;
}

interface SilentDeviceAnalysis {
  device: SilentDevice;
  silentDays: number;
  likelyFailureCause: string;
  diagnosticClues: string[];
}

function parseJsonlFile(path: string): Event[] {
  const content = readFileSync(path, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

/**
 * Deduplicate API call events from historical data that were double-recorded
 * before the telemetry fix. Removes false/0 events followed by true events
 * for the same device+method within ~5 seconds.
 * 
 * NOTE: This is a heuristic for historical data cleanup. New telemetry
 * recording (post-fix) ensures exactly one event per call.
 */
function deduplicateApiCallEvents(events: Event[]): Event[] {
  const deduplicated: Event[] = [];
  let skipNext = new Set<number>();
  
  for (let i = 0; i < events.length; i++) {
    if (skipNext.has(i)) continue;
    
    const event = events[i];
    
    // Only process api_call events
    if (event.eventType !== 'api_call') {
      deduplicated.push(event);
      continue;
    }
    
    // Look for potential duplicate: false/0 followed by true within 5s
    if (event.apiSuccess === false && event.apiResponseTime === 0 && i + 1 < events.length) {
      const nextEvent = events[i + 1];
      
      // Check if next event is a matching successful call
      if (nextEvent.eventType === 'api_call' &&
          nextEvent.device === event.device &&
          nextEvent.apiMethod === event.apiMethod &&
          nextEvent.apiSuccess === true &&
          (nextEvent.timestamp - event.timestamp) < 5000) {
        
        // Skip the false/0 event, keep only the successful one
        skipNext.add(i);
        continue;
      }
    }
    
    deduplicated.push(event);
  }
  
  const removed = events.length - deduplicated.length;
  if (removed > 0) {
    console.error(`Deduplicated ${removed} historical duplicate api_call events\n`);
  }
  
  return deduplicated;
}

function analyzeDevice(events: Event[]): DeviceAnalysis {
  const sessions: DeviceSession[] = [];
  let currentSession: DeviceSession | null = null;
  
  const connects = events.filter(e => e.eventType === 'connect');
  const disconnects = events.filter(e => e.eventType === 'disconnect');
  const apiCalls = events.filter(e => e.eventType === 'api_call');

  // Build sessions
  for (const event of events) {
    if (event.eventType === 'connect') {
      if (currentSession && !currentSession.disconnectTime) {
        currentSession.disconnectTime = event.timestamp;
        currentSession.disconnectReason = 'implicit';
        currentSession.duration = currentSession.disconnectTime - currentSession.connectTime;
      }
      currentSession = {
        device: event.device,
        connectTime: event.timestamp,
        protocol: event.protocol,
      };
      sessions.push(currentSession);
    } else if (event.eventType === 'disconnect' && currentSession) {
      currentSession.disconnectTime = event.timestamp;
      currentSession.disconnectReason = event.disconnectReason;
      currentSession.duration = currentSession.disconnectTime - currentSession.connectTime;
    }
  }

  // Calculate metrics
  const authFailures = disconnects.filter(d => d.disconnectReason === 'auth_failure').length;
  const signatureFailures = disconnects.filter(d => d.disconnectReason === 'signature_failure').length;
  const timeouts = disconnects.filter(d => d.disconnectReason === 'timeout').length;
  
  const validSessions = sessions.filter(s => s.duration !== undefined && s.duration > 0);
  const avgSessionDuration = validSessions.length > 0
    ? validSessions.reduce((sum, s) => sum + s.duration!, 0) / validSessions.length
    : 0;

  // Detect reconnect storms (>3 reconnects within 5 minutes)
  let reconnectCount = 0;
  for (let i = 1; i < connects.length; i++) {
    const timeDiff = connects[i].timestamp - connects[i - 1].timestamp;
    if (timeDiff < 5 * 60 * 1000) {
      reconnectCount++;
    }
  }
  const reconnectStorm = reconnectCount > 3;

  // API method stats
  const methodStats = new Map<string, { count: number; failures: number; totalTime: number }>();
  for (const call of apiCalls) {
    if (!call.apiMethod) continue;
    const stats = methodStats.get(call.apiMethod) || { count: 0, failures: 0, totalTime: 0 };
    stats.count++;
    if (!call.apiSuccess) stats.failures++;
    if (call.apiResponseTime) stats.totalTime += call.apiResponseTime;
    methodStats.set(call.apiMethod, stats);
  }

  const apiFailures = apiCalls.filter(c => !c.apiSuccess).length;
  const slowApiCalls = apiCalls.filter(c => c.apiResponseTime && c.apiResponseTime > 5000).length;
  const totalApiTime = apiCalls.reduce((sum, c) => sum + (c.apiResponseTime || 0), 0);
  const avgApiResponseTime = apiCalls.length > 0 ? totalApiTime / apiCalls.length : 0;

  // Determine likely cause
  let likelyCause = 'Normal operation';
  if (authFailures > 2 || signatureFailures > 2) {
    likelyCause = 'Device firmware - authentication issues';
  } else if (reconnectStorm && timeouts > 3) {
    likelyCause = 'Network/Web3E bridge - connection instability';
  } else if (timeouts > 5 && avgSessionDuration < 60000) {
    likelyCause = 'Web3E bridge - keepalive failure';
  } else if (slowApiCalls > apiCalls.length * 0.3) {
    likelyCause = 'Proxy or API backend - slow processing';
  } else if (apiFailures > apiCalls.length * 0.2) {
    likelyCause = 'Device firmware or API - method failures';
  } else if (reconnectStorm) {
    likelyCause = 'Device firmware - reconnect loop';
  }

  const latestConnect = connects[connects.length - 1];

  return {
    device: events[0].device,
    totalSessions: sessions.length,
    avgSessionDuration: avgSessionDuration / 1000,
    reconnectCount,
    reconnectStorm,
    authFailures,
    signatureFailures,
    timeouts,
    apiCalls: apiCalls.length,
    apiFailures,
    slowApiCalls,
    avgApiResponseTime,
    methodStats: new Map(
      Array.from(methodStats.entries()).map(([method, stats]) => [
        method,
        {
          count: stats.count,
          failures: stats.failures,
          avgTime: stats.count > 0 ? stats.totalTime / stats.count : 0,
        },
      ])
    ),
    likelyCause,
    firmwareVersion: latestConnect?.firmwareVersion,
  };
}

function analyzeSilentDevice(device: SilentDevice): SilentDeviceAnalysis {
  const silentDays = device.silentDurationMs / (24 * 60 * 60 * 1000);
  const diagnosticClues: string[] = [];
  let likelyFailureCause = 'Unknown - no diagnostics available';

  if (device.lastDiagnostics) {
    const diag = device.lastDiagnostics;
    
    if (diag.resetReason) {
      diagnosticClues.push(`Last reset: ${diag.resetReason}`);
      if (diag.resetReason.match(/power|brownout|watchdog/i)) {
        likelyFailureCause = 'Power instability or firmware crash (watchdog/brownout reset)';
      }
    }

    if (diag.wifiAttempts && diag.wifiAttempts > 5) {
      diagnosticClues.push(`High WiFi attempts: ${diag.wifiAttempts}`);
      likelyFailureCause = 'WiFi association/credential issues';
    }

    if (diag.lastFailureStage) {
      diagnosticClues.push(`Last failure at: ${diag.lastFailureStage}`);
      if (diag.lastFailureStage.match(/dns/i)) {
        likelyFailureCause = 'DNS resolution failure (network/router config)';
      } else if (diag.lastFailureStage.match(/tls|ssl|cert/i)) {
        likelyFailureCause = 'TLS/certificate validation failure';
      } else if (diag.lastFailureStage.match(/tcp|connect/i)) {
        likelyFailureCause = 'TCP connection failure (firewall/proxy unreachable)';
      } else if (diag.lastFailureStage.match(/dhcp/i)) {
        likelyFailureCause = 'DHCP failure (network infrastructure)';
      }
    }

    if (diag.connectTimeMs && diag.connectTimeMs > 30000) {
      diagnosticClues.push(`Slow connect: ${(diag.connectTimeMs / 1000).toFixed(1)}s`);
    }

    if (diag.bootCount !== undefined) {
      diagnosticClues.push(`Boot count: ${diag.bootCount}`);
      if (diag.bootCount > 100 && silentDays < 7) {
        likelyFailureCause = 'Reboot loop (likely firmware crash or power cycling)';
      }
    }
  }

  if (device.lastDisconnectReason) {
    diagnosticClues.push(`Last disconnect: ${device.lastDisconnectReason}`);
    if (device.lastDisconnectReason === 'auth_failure' || device.lastDisconnectReason === 'signature_failure') {
      likelyFailureCause = 'Authentication failure (credential mismatch or firmware bug)';
    } else if (device.lastDisconnectReason === 'timeout') {
      likelyFailureCause = 'Network timeout (intermittent connectivity or keepalive failure)';
    }
  }

  const recentConnectFailures = device.lastEvents.filter(e => 
    e.eventType === 'disconnect' && 
    (e.disconnectReason === 'auth_failure' || e.disconnectReason === 'signature_failure')
  ).length;

  if (recentConnectFailures >= 2 && diagnosticClues.length === 0) {
    likelyFailureCause = 'Repeated authentication failures suggest credential/firmware issue';
  }

  if (diagnosticClues.length === 0 && silentDays > 30) {
    likelyFailureCause = 'Device likely decommissioned or permanently offline';
  }

  return {
    device,
    silentDays,
    likelyFailureCause,
    diagnosticClues,
  };
}

function summarizeGetChallengeFailures(events: Event[]): string {
  const failures = events.filter(e => e.eventType === 'get_challenge_failed');
  if (failures.length === 0) {
    return '';
  }

  let md = '## getChallenge Failures (DDoS / flood tracing)\n\n';
  md += `Total \`get_challenge_failed\` events: ${failures.length}\n\n`;

  const byIp = new Map<string, { count: number; reasons: Map<string, number>; max60: number; max10m: number }>();
  const byReason = new Map<string, number>();

  for (const ev of failures) {
    const ip = ev.ipAddress || 'unknown';
    const entry = byIp.get(ip) || { count: 0, reasons: new Map(), max60: 0, max10m: 0 };
    entry.count++;
    const reason = ev.failureReason || 'unknown';
    entry.reasons.set(reason, (entry.reasons.get(reason) || 0) + 1);
    entry.max60 = Math.max(entry.max60, ev.requests60s || 0);
    entry.max10m = Math.max(entry.max10m, ev.requests10m || 0);
    byIp.set(ip, entry);
    byReason.set(reason, (byReason.get(reason) || 0) + 1);
  }

  md += '**By reason:**\n\n';
  for (const [reason, count] of Array.from(byReason.entries()).sort((a, b) => b[1] - a[1])) {
    md += `- \`${reason}\`: ${count}\n`;
  }
  md += '\n';

  md += '**Top client IPs:**\n\n';
  const topIps = Array.from(byIp.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, 15);
  for (const [ip, stats] of topIps) {
    const reasons = Array.from(stats.reasons.entries()).map(([r, c]) => `${r}=${c}`).join(', ');
    md += `- \`${ip}\`: ${stats.count} failures`;
    if (stats.max60 || stats.max10m) {
      md += ` (peak counters: ${stats.max60}/60s, ${stats.max10m}/10m)`;
    }
    md += ` — ${reasons}\n`;
  }
  md += '\n';
  return md;
}

function summarizeIpPinViolations(events: Event[]): string {
  const violations = events.filter(e => e.eventType === 'ip_pin_violation');
  if (violations.length === 0) {
    return '';
  }

  let md = '## Session IP Pin Violations\n\n';
  md += `Total \`ip_pin_violation\` events: ${violations.length}\n\n`;

  const byDevice = new Map<string, number>();
  const byMethod = new Map<string, number>();

  for (const ev of violations) {
    byDevice.set(ev.device, (byDevice.get(ev.device) || 0) + 1);
    const method = ev.apiMethod || 'unknown';
    byMethod.set(method, (byMethod.get(method) || 0) + 1);
  }

  md += '**By device:**\n\n';
  for (const [device, count] of Array.from(byDevice.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    md += `- \`${device}\`: ${count}\n`;
  }
  md += '\n';

  md += '**By opcode/method:**\n\n';
  for (const [method, count] of Array.from(byMethod.entries()).sort((a, b) => b[1] - a[1])) {
    md += `- \`${method}\`: ${count}\n`;
  }
  md += '\n';

  md += '**Recent samples:**\n\n';
  for (const ev of violations.slice(-10)) {
    const time = new Date(ev.timestamp).toISOString();
    md += `- ${time}: device=\`${ev.device}\` offending=\`${ev.ipAddress || '?'}\``;
    if (ev.failureReason) md += ` ${ev.failureReason}`;
    if (ev.apiMethod) md += ` method=\`${ev.apiMethod}\``;
    if (ev.firmwareProject) md += ` project=\`${ev.firmwareProject}\``;
    md += '\n';
  }
  md += '\n';
  return md;
}

function summarizeSignedRpc(events: Event[]): string {
  const rpcEvents = events.filter(e => e.eventType === 'rpc_call');
  if (rpcEvents.length === 0) {
    return '';
  }

  let md = '## Signed RPC\n\n';
  const failures = rpcEvents.filter(e => !e.apiSuccess);
  const successes = rpcEvents.filter(e => e.apiSuccess);
  md += `Total \`rpc_call\` events: ${rpcEvents.length} (${successes.length} ok, ${failures.length} failed)\n\n`;

  const byMethod = new Map<string, { ok: number; fail: number; totalMs: number }>();
  const byChain = new Map<string, number>();
  const failByIp = new Map<string, number>();

  for (const ev of rpcEvents) {
    const method = ev.apiMethod || 'unknown';
    const entry = byMethod.get(method) || { ok: 0, fail: 0, totalMs: 0 };
    if (ev.apiSuccess) entry.ok++;
    else entry.fail++;
    entry.totalMs += ev.apiResponseTime || 0;
    byMethod.set(method, entry);

    const chain = ev.firmwareProject || 'unknown';
    byChain.set(chain, (byChain.get(chain) || 0) + 1);

    if (!ev.apiSuccess) {
      const ip = ev.ipAddress || 'unknown';
      failByIp.set(ip, (failByIp.get(ip) || 0) + 1);
    }
  }

  md += '**By method:**\n\n';
  for (const [method, stats] of Array.from(byMethod.entries()).sort((a, b) => (b[1].ok + b[1].fail) - (a[1].ok + a[1].fail))) {
    const n = stats.ok + stats.fail;
    const avg = n > 0 ? Math.round(stats.totalMs / n) : 0;
    md += `- \`${method}\`: ${n} (fail=${stats.fail}, avg=${avg}ms)\n`;
  }
  md += '\n';

  md += '**By chainId:**\n\n';
  for (const [chain, count] of Array.from(byChain.entries()).sort((a, b) => b[1] - a[1])) {
    md += `- \`${chain}\`: ${count}\n`;
  }
  md += '\n';

  if (failures.length > 0) {
    md += '**Top failure IPs:**\n\n';
    for (const [ip, count] of Array.from(failByIp.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      md += `- \`${ip}\`: ${count}\n`;
    }
    md += '\n';
  }

  return md;
}

function generateMarkdownReport(
  analyses: Map<string, DeviceAnalysis>,
  silentDevices?: SilentDeviceAnalysis[],
  allEvents?: Event[]
): string {
  let md = '# Telemetry Analysis Report\n\n';
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `Total devices analyzed: ${analyses.size}\n\n`;

  md += '## Summary\n\n';
  const withIssues = Array.from(analyses.values()).filter(
    a => a.reconnectStorm || a.authFailures > 0 || a.apiFailures > a.apiCalls * 0.1
  );
  md += `- Devices with issues: ${withIssues.length}\n`;
  md += `- Devices with reconnect storms: ${Array.from(analyses.values()).filter(a => a.reconnectStorm).length}\n`;
  md += `- Devices with auth failures: ${Array.from(analyses.values()).filter(a => a.authFailures > 0).length}\n`;
  if (allEvents) {
    const gcf = allEvents.filter(e => e.eventType === 'get_challenge_failed').length;
    md += `- getChallenge failures: ${gcf}\n`;
    const ipv = allEvents.filter(e => e.eventType === 'ip_pin_violation').length;
    md += `- IP pin violations: ${ipv}\n`;
    const rpc = allEvents.filter(e => e.eventType === 'rpc_call').length;
    const rpcFail = allEvents.filter(e => e.eventType === 'rpc_call' && !e.apiSuccess).length;
    md += `- Signed RPC calls: ${rpc} (failures: ${rpcFail})\n`;
  }
  if (silentDevices) {
    md += `- Silent devices (expected but not connecting): ${silentDevices.filter(d => !d.device.retired).length}\n`;
  }
  md += '\n';

  if (allEvents) {
    md += summarizeGetChallengeFailures(allEvents);
    md += summarizeIpPinViolations(allEvents);
    md += summarizeSignedRpc(allEvents);
  }

  if (silentDevices && silentDevices.length > 0) {
    md += '## Silent Devices\n\n';
    md += '**Survivorship-bias analysis:** Devices that should be connecting based on historical patterns but have gone silent.\n\n';
    
    const activelyMissing = silentDevices.filter(d => !d.device.retired);
    
    if (activelyMissing.length === 0) {
      md += '*All silent devices are marked as retired. No action needed.*\n\n';
    } else {
      md += `**${activelyMissing.length} device(s) need attention:**\n\n`;
      
      for (const analysis of activelyMissing) {
        const dev = analysis.device;
        md += `### 🔴 \`${dev.address}\`\n\n`;
        md += `**Silent for:** ${analysis.silentDays.toFixed(1)} days (expected reconnect: ${(dev.expectedReconnectMs / 1000 / 60).toFixed(0)} minutes)\n\n`;
        md += `**Last seen:** ${new Date(dev.lastSeen).toISOString()}\n\n`;
        
        if (dev.lastFirmwareVersion) {
          md += `**Last firmware:** ${dev.lastFirmwareVersion}\n\n`;
        }
        
        md += `**Likely cause:** ${analysis.likelyFailureCause}\n\n`;
        
        if (analysis.diagnosticClues.length > 0) {
          md += '**Diagnostic clues:**\n';
          for (const clue of analysis.diagnosticClues) {
            md += `- ${clue}\n`;
          }
          md += '\n';
        }
        
        md += '**Pre-connection failure analysis:**\n';
        if (dev.lastDiagnostics?.lastFailureStage) {
          md += `- Last failure stage: **${dev.lastDiagnostics.lastFailureStage}**\n`;
          md += '- Investigation steps:\n';
          const stage = dev.lastDiagnostics.lastFailureStage.toLowerCase();
          if (stage.includes('wifi') || stage.includes('assoc')) {
            md += '  1. Check WiFi network availability and signal strength\n';
            md += '  2. Verify WiFi credentials in device config\n';
            md += '  3. Check for MAC address filtering or network policy changes\n';
          } else if (stage.includes('dhcp')) {
            md += '  1. Verify DHCP server is running and has available leases\n';
            md += '  2. Check for IP address conflicts\n';
            md += '  3. Review router logs for DHCP denials\n';
          } else if (stage.includes('dns')) {
            md += '  1. Verify DNS server configuration in network\n';
            md += '  2. Test DNS resolution from another device on same network\n';
            md += '  3. Check for DNS blocking/filtering\n';
          } else if (stage.includes('tls') || stage.includes('ssl')) {
            md += '  1. Check device system time (TLS requires accurate time)\n';
            md += '  2. Verify certificate chain is valid\n';
            md += '  3. Check for TLS version mismatch (device may need firmware update)\n';
          } else if (stage.includes('tcp') || stage.includes('connect')) {
            md += '  1. Verify proxy/server is reachable from device network\n';
            md += '  2. Check firewall rules blocking outbound connections\n';
            md += '  3. Test connectivity with curl/telnet from same network\n';
          }
        } else {
          md += '- No diagnostic data from next boot attempt (device never reconnected)\n';
          md += '- Possible causes: power loss, physical damage, complete network loss\n';
        }
        md += '\n';
        
        if (dev.lastEvents.length > 0) {
          md += '**Last 3 events:**\n';
          for (const event of dev.lastEvents.slice(0, 3)) {
            const time = new Date(event.timestamp).toISOString();
            md += `- ${time}: ${event.eventType}`;
            if (event.disconnectReason) md += ` (${event.disconnectReason})`;
            if (event.apiMethod) md += ` - ${event.apiMethod}`;
            md += '\n';
          }
          md += '\n';
        }
        
        md += '---\n\n';
      }
    }
    
    if (silentDevices.some(d => d.device.retired)) {
      const retired = silentDevices.filter(d => d.device.retired);
      md += `### Retired Devices (${retired.length})\n\n`;
      md += 'These devices are marked as decommissioned and no longer alert:\n\n';
      for (const analysis of retired) {
        md += `- \`${analysis.device.address}\` - last seen ${analysis.silentDays.toFixed(0)} days ago\n`;
      }
      md += '\n';
    }
  }

  md += '## Device Details\n\n';
  for (const [device, analysis] of Array.from(analyses.entries()).sort((a: [string, DeviceAnalysis], b: [string, DeviceAnalysis]) => {
    if (a[1].reconnectStorm !== b[1].reconnectStorm) return a[1].reconnectStorm ? -1 : 1;
    return b[1].reconnectCount - a[1].reconnectCount;
  })) {
    md += `### Device \`${device}\`\n\n`;
    if (analysis.firmwareVersion) {
      md += `**Firmware:** ${analysis.firmwareVersion}\n\n`;
    }
    md += `**Sessions:** ${analysis.totalSessions} (avg duration: ${analysis.avgSessionDuration.toFixed(1)}s)\n\n`;
    md += `**Reconnects:** ${analysis.reconnectCount}${analysis.reconnectStorm ? ' ⚠️ **STORM DETECTED**' : ''}\n\n`;
    
    if (analysis.authFailures > 0 || analysis.signatureFailures > 0 || analysis.timeouts > 0) {
      md += '**Connection Issues:**\n';
      if (analysis.authFailures > 0) md += `- Auth failures: ${analysis.authFailures}\n`;
      if (analysis.signatureFailures > 0) md += `- Signature failures: ${analysis.signatureFailures}\n`;
      if (analysis.timeouts > 0) md += `- Timeouts: ${analysis.timeouts}\n`;
      md += '\n';
    }

    if (analysis.apiCalls > 0) {
      md += `**API Calls:** ${analysis.apiCalls} (failures: ${analysis.apiFailures}, slow: ${analysis.slowApiCalls})\n\n`;
      md += `**Avg Response Time:** ${analysis.avgApiResponseTime.toFixed(0)}ms\n\n`;

      if (analysis.methodStats.size > 0) {
        md += '**Top Methods:**\n\n';
        const topMethods = Array.from(analysis.methodStats.entries())
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 5);
        for (const [method, stats] of topMethods) {
          md += `- \`${method}\`: ${stats.count} calls, ${stats.failures} failures, ${stats.avgTime.toFixed(0)}ms avg\n`;
        }
        md += '\n';
      }
    }

    md += `**Likely Cause:** ${analysis.likelyCause}\n\n`;
    md += '---\n\n';
  }

  return md;
}

function findLatestFile(): string | null {
  const dataDir = join(__dirname, '..', '..', 'data');
  try {
    const files = readdirSync(dataDir)
      .filter(f => f.startsWith('telemetry-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();
    return files.length > 0 ? join(dataDir, files[0]) : null;
  } catch {
    return null;
  }
}

async function fetchSilentDevices(apiUrl: string, apiKey: string): Promise<SilentDevice[]> {
  const url = `${apiUrl}/api/telemetry/devices/silent`;
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { devices: SilentDevice[] };
  return data.devices;
}

function parseArgs(): { inputFile?: string; apiUrl?: string; apiKey?: string } {
  const args = process.argv.slice(2);
  let inputFile: string | undefined;
  let apiUrl: string | undefined;
  let apiKey: string | undefined;

  for (const arg of args) {
    if (arg.startsWith('--api-url=')) {
      apiUrl = arg.substring('--api-url='.length);
    } else if (arg.startsWith('--api-key=')) {
      apiKey = arg.substring('--api-key='.length);
    } else if (!arg.startsWith('--')) {
      inputFile = arg;
    }
  }

  // Fall back to environment variables if not provided via CLI
  if (!apiUrl) apiUrl = process.env.TELEMETRY_API_URL;
  if (!apiKey) apiKey = process.env.TELEMETRY_API_KEY;

  return { inputFile, apiUrl, apiKey };
}

async function main() {
  const { inputFile: argFile, apiUrl, apiKey } = parseArgs();
  let inputFile = argFile;
  
  if (!inputFile) {
    const latestFile = findLatestFile();
    if (!latestFile) {
      console.error('Error: No telemetry file found. Run pull.ts first or specify a file.');
      process.exit(1);
    }
    inputFile = latestFile;
    console.error(`Using latest file: ${inputFile}\n`);
  }

  console.error(`Analyzing: ${inputFile}\n`);
  let events = parseJsonlFile(inputFile);
  console.error(`Loaded ${events.length} events\n`);
  
  // Deduplicate historical double-recorded API calls
  events = deduplicateApiCallEvents(events);

  const deviceEvents = new Map<string, Event[]>();
  for (const event of events) {
    const list = deviceEvents.get(event.device) || [];
    list.push(event);
    deviceEvents.set(event.device, list);
  }

  const analyses = new Map<string, DeviceAnalysis>();
  for (const [device, devEvents] of Array.from(deviceEvents.entries())) {
    analyses.set(device, analyzeDevice(devEvents.sort((a, b) => a.timestamp - b.timestamp)));
  }

  let silentAnalyses: SilentDeviceAnalysis[] | undefined;
  if (apiUrl && apiKey) {
    console.error('Fetching silent devices from API...\n');
    try {
      const silentDevices = await fetchSilentDevices(apiUrl, apiKey);
      console.error(`Found ${silentDevices.length} silent devices\n`);
      silentAnalyses = silentDevices.map(analyzeSilentDevice);
    } catch (err) {
      console.error(`Warning: Could not fetch silent devices: ${err}\n`);
    }
  }

  const report = generateMarkdownReport(analyses, silentAnalyses, events);
  console.log(report);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
