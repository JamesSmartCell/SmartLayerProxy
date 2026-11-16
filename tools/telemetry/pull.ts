#!/usr/bin/env ts-node
/**
 * Telemetry Pull Tool
 * 
 * Pulls telemetry events from /api/telemetry/feed and writes to data/telemetry-YYYYMMDD.jsonl
 * Optionally acknowledges (deletes) events from server after successful pull using admin signature
 * 
 * Usage:
 *   ts-node tools/telemetry/pull.ts [--ack] [--dry-run]
 * 
 * Requires .env with:
 *   PROXY_BASE_URL=https://your-proxy.com
 *   TELEMETRY_API_KEY=your-api-key
 *   TELEMETRY_ADMIN_KEY=0x... (private key, only for --ack)
 */

import { config } from 'dotenv';
import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { Wallet } from 'ethers';

config({ path: join(__dirname, '..', '..', '.env') });

const PROXY_BASE_URL = process.env.PROXY_BASE_URL || 'http://localhost:8081';
const TELEMETRY_API_KEY = process.env.TELEMETRY_API_KEY || '';
const TELEMETRY_ADMIN_KEY = process.env.TELEMETRY_ADMIN_KEY || '';

interface FeedResponse {
  rows: any[];
  maxId: number;
  hasMore: boolean;
  serverTime: number;
}

async function fetchFeed(afterId: number, limit = 1000): Promise<FeedResponse> {
  const url = `${PROXY_BASE_URL}/api/telemetry/feed?afterId=${afterId}&limit=${limit}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${TELEMETRY_API_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Feed request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<FeedResponse>;
}

async function acknowledgeEvents(upToId: number, dryRun: boolean): Promise<any> {
  if (!TELEMETRY_ADMIN_KEY) {
    throw new Error('TELEMETRY_ADMIN_KEY not set in .env');
  }

  // Get challenge nonce
  const challengeResp = await fetch(`${PROXY_BASE_URL}/api/admin/challenge`);
  if (!challengeResp.ok) {
    throw new Error(`Challenge request failed: ${challengeResp.status}`);
  }
  const { nonce } = await challengeResp.json() as { nonce: string };

  // Sign message: 'ack:<upToId>:<nonce>'
  const wallet = new Wallet(TELEMETRY_ADMIN_KEY);
  const message = `ack:${upToId}:${nonce}`;
  const signature = await wallet.signMessage(message);

  // Send ack
  const ackResp = await fetch(`${PROXY_BASE_URL}/api/telemetry/ack`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TELEMETRY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      upToId,
      signature,
      message,
      dryRun,
    }),
  });

  if (!ackResp.ok) {
    const error = await ackResp.text();
    throw new Error(`Ack request failed: ${ackResp.status} - ${error}`);
  }

  return ackResp.json() as Promise<any>;
}

async function main() {
  const args = process.argv.slice(2);
  const shouldAck = args.includes('--ack');
  const dryRun = args.includes('--dry-run');

  if (!TELEMETRY_API_KEY) {
    console.error('Error: TELEMETRY_API_KEY not set in .env');
    process.exit(1);
  }

  const dataDir = join(__dirname, '..', '..', 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const outputFile = join(dataDir, `telemetry-${today}.jsonl`);

  let afterId = 0;
  let totalRows = 0;
  let maxIdSeen = 0;

  console.log(`Pulling telemetry events from ${PROXY_BASE_URL}`);
  console.log(`Writing to: ${outputFile}`);

  while (true) {
    console.log(`Fetching events after ID ${afterId}...`);
    const feed = await fetchFeed(afterId, 1000);

    if (feed.rows.length === 0) {
      console.log('No more events.');
      break;
    }

    for (const row of feed.rows) {
      appendFileSync(outputFile, JSON.stringify(row) + '\n');
      maxIdSeen = Math.max(maxIdSeen, row.id);
    }

    totalRows += feed.rows.length;
    console.log(`  Retrieved ${feed.rows.length} events (total: ${totalRows})`);

    if (!feed.hasMore) {
      console.log('Reached end of feed.');
      break;
    }

    afterId = feed.rows[feed.rows.length - 1].id;
  }

  console.log(`\nTotal events written: ${totalRows}`);
  console.log(`Max ID: ${maxIdSeen}`);

  if (shouldAck && maxIdSeen > 0) {
    console.log(`\n${dryRun ? '[DRY RUN]' : ''} Acknowledging events up to ID ${maxIdSeen}...`);
    try {
      const ackResult = await acknowledgeEvents(maxIdSeen, dryRun);
      console.log('Ack result:', JSON.stringify(ackResult, null, 2));
    } catch (err) {
      console.error('Ack failed:', err);
      process.exit(1);
    }
  } else if (shouldAck) {
    console.log('\nNo events to acknowledge.');
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
