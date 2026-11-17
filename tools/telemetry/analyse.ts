#!/usr/bin/env ts-node
/**
 * Telemetry Analysis Tool
 * 
 * Analyzes telemetry data for patterns:
 * - Per-device reconnect storms
 * - Signature/auth failures
 * - Timeouts vs keepalive issues
 * - Failing/slow API methods
 * - Attribution: proxy vs Web3E TcpBridge/UdpBridge vs device firmware
 * 
 * Usage:
 *   npm run telemetry:analyse [-- data/telemetry-YYYYMMDD.jsonl]
 *   OR: ts-node tools/telemetry/analyse.ts [data/telemetry-YYYYMMDD.jsonl]
 * 
 * Outputs markdown report to stdout
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

interface Event {
  id: number;
  timestamp: number;
  device: string;
  eventType: 'connect' | 'disconnect' | 'api_call';
  protocol?: 'UDP' | 'TCP';
  disconnectReason?: string;
  apiMethod?: string;
  apiSuccess?: boolean;
  apiResponseTime?: number;
  ipAddress?: string;
  firmwareVersion?: string;
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

function parseJsonlFile(path: string): Event[] {
  const content = readFileSync(path, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
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

function generateMarkdownReport(analyses: Map<string, DeviceAnalysis>): string {
  let md = '# Telemetry Analysis Report\n\n';
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `Total devices analyzed: ${analyses.size}\n\n`;

  md += '## Summary\n\n';
  const withIssues = Array.from(analyses.values()).filter(
    a => a.reconnectStorm || a.authFailures > 0 || a.apiFailures > a.apiCalls * 0.1
  );
  md += `- Devices with issues: ${withIssues.length}\n`;
  md += `- Devices with reconnect storms: ${Array.from(analyses.values()).filter(a => a.reconnectStorm).length}\n`;
  md += `- Devices with auth failures: ${Array.from(analyses.values()).filter(a => a.authFailures > 0).length}\n\n`;

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

async function main() {
  let inputFile: string | undefined = process.argv[2];
  
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
  const events = parseJsonlFile(inputFile);
  console.error(`Loaded ${events.length} events\n`);

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

  const report = generateMarkdownReport(analyses);
  console.log(report);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
