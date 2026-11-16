#!/usr/bin/env ts-node
/**
 * Firmware Upload Tool
 * 
 * Signs and uploads firmware binaries to the proxy with admin authentication
 * 
 * Usage:
 *   ts-node tools/firmware/upload.ts <project> <version> <firmware.bin>
 *   ts-node tools/firmware/upload.ts GarageDoor 1.2.3 firmware.bin
 * 
 * Requires .env with:
 *   PROXY_BASE_URL=https://your-proxy.com
 *   FIRMWARE_ADMIN_KEY=0x... (private key for signing)
 */

import { config } from 'dotenv';
import { readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { Wallet } from 'ethers';
import { createHash } from 'crypto';

config({ path: join(__dirname, '..', '..', '.env') });

const PROXY_BASE_URL = process.env.PROXY_BASE_URL || 'http://localhost:8081';
const FIRMWARE_ADMIN_KEY = process.env.FIRMWARE_ADMIN_KEY || '';

function computeSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function getChallenge(): Promise<string> {
  const response = await fetch(`${PROXY_BASE_URL}/api/admin/challenge`);
  if (!response.ok) {
    throw new Error(`Challenge request failed: ${response.status} ${response.statusText}`);
  }
  const { nonce } = await response.json() as { nonce: string };
  return nonce;
}

async function uploadFirmware(
  project: string,
  version: string,
  firmwareBuffer: Buffer
): Promise<any> {
  if (!FIRMWARE_ADMIN_KEY) {
    throw new Error('FIRMWARE_ADMIN_KEY not set in .env');
  }

  const sha256 = computeSha256(firmwareBuffer);
  console.log(`SHA256: ${sha256}`);

  // Get challenge nonce
  console.log('Getting challenge nonce...');
  const nonce = await getChallenge();

  // Sign message: 'firmware:<project>:<version>:<sha256>:<nonce>'
  const wallet = new Wallet(FIRMWARE_ADMIN_KEY);
  const message = `firmware:${project}:${version}:${sha256}:${nonce}`;
  console.log(`Signing message: ${message}`);
  const signature = await wallet.signMessage(message);
  console.log(`Signature: ${signature}`);
  console.log(`Signing address: ${wallet.address}`);

  // Upload firmware
  const url = `${PROXY_BASE_URL}/api/firmware/${encodeURIComponent(project)}?version=${encodeURIComponent(version)}&signature=${encodeURIComponent(signature)}&message=${encodeURIComponent(message)}`;
  
  console.log(`Uploading ${firmwareBuffer.length} bytes to ${project} v${version}...`);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: new Uint8Array(firmwareBuffer),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Upload failed: ${response.status} - ${error}`);
  }

  return response.json() as Promise<any>;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.error('Usage: ts-node upload.ts <project> <version> <firmware.bin>');
    console.error('Example: ts-node upload.ts GarageDoor 1.2.3 firmware.bin');
    process.exit(1);
  }

  const [project, version, firmwarePath] = args;

  if (!FIRMWARE_ADMIN_KEY) {
    console.error('Error: FIRMWARE_ADMIN_KEY not set in .env');
    process.exit(1);
  }

  console.log(`Project: ${project}`);
  console.log(`Version: ${version}`);
  console.log(`File: ${firmwarePath}`);

  const firmwareBuffer = readFileSync(firmwarePath);
  const stats = statSync(firmwarePath);
  console.log(`Size: ${stats.size} bytes (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  const result = await uploadFirmware(project, version, firmwareBuffer);
  
  console.log('\n✅ Upload successful!');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
