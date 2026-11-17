#!/usr/bin/env ts-node
/**
 * Firmware Upload Tool
 * 
 * Signs and uploads firmware binaries to the proxy with admin authentication
 * 
 * Usage:
 *   npm run firmware:upload <project> <version> <firmware.bin> [--notify]
 *   OR: ts-node tools/firmware/upload.ts <project> <version> <firmware.bin> [--notify]
 * 
 * Example:
 *   npm run firmware:upload GarageDoor 1.2.3 firmware.bin
 *   npm run firmware:upload GarageDoor 1.2.3 firmware.bin --notify
 * 
 * Requires .env with:
 *   PROXY_BASE_URL=https://your-proxy.com
 *   FIRMWARE_ADMIN_KEY=0x... (private key for signing)
 * 
 * .env locations (checked in order):
 *   1. tools/firmware/.env
 *   2. .env (repo root)
 */

import { config } from 'dotenv';
import { readFileSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { Wallet } from 'ethers';
import { createHash } from 'crypto';

// Try loading .env from multiple locations
const envPaths = [
  join(__dirname, '.env'),                    // tools/firmware/.env
  join(__dirname, '..', '..', '.env'),        // repo root .env
];

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    config({ path: envPath });
    break;
  }
}

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
  firmwareBuffer: Buffer,
  notify: boolean
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
  const notifyParam = notify ? '&notify=true' : '';
  const url = `${PROXY_BASE_URL}/api/firmware/${encodeURIComponent(project)}?version=${encodeURIComponent(version)}&signature=${encodeURIComponent(signature)}&message=${encodeURIComponent(message)}${notifyParam}`;
  
  console.log(`Uploading ${firmwareBuffer.length} bytes to ${project} v${version}...`);
  if (notify) {
    console.log('Will notify connected devices after upload');
  }
  
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

function validatePlainSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.error('Usage: ts-node upload.ts <project> <version> <firmware.bin> [--notify]');
    console.error('Example: ts-node upload.ts GarageDoor 1.2.3 firmware.bin');
    console.error('         ts-node upload.ts GarageDoor 1.2.3 firmware.bin --notify');
    console.error('');
    console.error('Version must be plain semver MAJOR.MINOR.PATCH (e.g., 1.2.3)');
    console.error('Do not include project name, v prefix, or build suffix');
    console.error('This version must match the FIRMWARE_SEMVER in your device firmware');
    process.exit(1);
  }

  const notify = args.includes('--notify');
  const fileArgs = args.filter(a => a !== '--notify');
  const [project, version, firmwarePath] = fileArgs;

  if (!FIRMWARE_ADMIN_KEY) {
    console.error('Error: FIRMWARE_ADMIN_KEY not set in .env');
    process.exit(1);
  }

  if (!validatePlainSemver(version)) {
    console.error(`Error: Version "${version}" is not valid plain semver`);
    console.error('Version must be MAJOR.MINOR.PATCH (e.g., 1.2.3)');
    console.error('Do not include:');
    console.error('  - Project name (not "garagedoor@1.2.3")');
    console.error('  - v prefix (not "v1.2.3")');
    console.error('  - Build suffix (not "1.2.3+abc123")');
    console.error('');
    console.error('This version must match the FIRMWARE_SEMVER constant in your device firmware.');
    process.exit(1);
  }

  console.log(`Project: ${project}`);
  console.log(`Version: ${version}`);
  console.log(`File: ${firmwarePath}`);
  console.log(`Notify: ${notify}`);

  const firmwareBuffer = readFileSync(firmwarePath);
  const stats = statSync(firmwarePath);
  console.log(`Size: ${stats.size} bytes (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  const result = await uploadFirmware(project, version, firmwareBuffer, notify);
  
  console.log('\n✅ Upload successful!');
  console.log(JSON.stringify(result, null, 2));
  
  if (notify && result.notified !== undefined) {
    console.log(`\n📢 Notified ${result.notified} device(s)`);
  }
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
