#!/usr/bin/env ts-node
/**
 * Firmware Upload Tool
 * 
 * Signs and uploads firmware binaries to the proxy with admin authentication.
 * By default, automatically notifies all connected devices with older versions.
 * 
 * Usage:
 *   npm run firmware:upload -- <project> <version> <firmware.bin> [--no-notify]
 *   OR: ts-node tools/firmware/upload.ts <project> <version> <firmware.bin> [--no-notify]
 * 
 * Examples:
 *   npm run firmware:upload -- garagedoor 1.2.3 firmware.bin
 *   npm run firmware:upload -- garagedoor 1.2.3 firmware.bin --no-notify
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
  autoNotify: boolean
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

  // Upload firmware - autoNotify=true by default, unless --no-notify is passed
  const autoNotifyParam = autoNotify ? '' : '&autoNotify=false';
  const url = `${PROXY_BASE_URL}/api/firmware/${encodeURIComponent(project)}?version=${encodeURIComponent(version)}&signature=${encodeURIComponent(signature)}&message=${encodeURIComponent(message)}${autoNotifyParam}`;
  
  console.log(`Uploading ${firmwareBuffer.length} bytes to ${project} v${version}...`);
  if (!autoNotify) {
    console.log('⚠️  Auto-notify disabled - devices will NOT be notified');
  } else {
    console.log('✓ Auto-notify enabled - will notify connected devices with older versions');
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
    console.error('Usage: npm run firmware:upload -- <project> <version> <firmware.bin> [--no-notify]');
    console.error('   OR: ts-node upload.ts <project> <version> <firmware.bin> [--no-notify]');
    console.error('');
    console.error('Examples:');
    console.error('  npm run firmware:upload -- garagedoor 1.2.3 firmware.bin');
    console.error('  npm run firmware:upload -- garagedoor 1.2.3 firmware.bin --no-notify');
    console.error('');
    console.error('Version must be plain semver MAJOR.MINOR.PATCH (e.g., 1.2.3)');
    console.error('Do not include project name, v prefix, or build suffix');
    console.error('This version must match the FIRMWARE_SEMVER in your device firmware');
    console.error('');
    console.error('By default, all connected devices with older versions are automatically notified.');
    console.error('Use --no-notify to skip auto-notification for staged rollouts.');
    process.exit(1);
  }

  const noNotify = args.includes('--no-notify');
  const fileArgs = args.filter(a => a !== '--no-notify');
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
  console.log(`Auto-notify: ${!noNotify}`);

  const firmwareBuffer = readFileSync(firmwarePath);
  const stats = statSync(firmwarePath);
  console.log(`Size: ${stats.size} bytes (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  const result = await uploadFirmware(project, version, firmwareBuffer, !noNotify);
  
  console.log('\n✅ Upload successful!');
  console.log(JSON.stringify(result, null, 2));
  
  if (result.notified !== undefined) {
    console.log(`\n📢 Notified ${result.notified} device(s)`);
    if (result.devices && result.devices.length > 0) {
      console.log('\nNotified devices:');
      for (const dev of result.devices) {
        console.log(`  ${dev.address}: ${dev.oldVersion} → ${dev.newVersion}`);
      }
    }
  }
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
