#!/usr/bin/env ts-node
/**
 * Firmware Revoke Tool
 *
 * Revokes a device so it OTA-installs the project's setup firmware and reboots
 * into the provisioning portal. Uses the same admin auth as firmware upload.
 *
 * Usage:
 *   npm run firmware:revoke <project> <deviceAddress>
 *   npm run firmware:revoke:cancel <project> <deviceAddress>
 *
 * Or:
 *   ts-node tools/firmware/revoke.ts <project> <deviceAddress>
 *   ts-node tools/firmware/revoke.ts --cancel <project> <deviceAddress>
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
import { existsSync } from 'fs';
import { join } from 'path';
import { Wallet } from 'ethers';

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

const PROXY_BASE_URL = process.env.PROXY_BASE_URL || 'http://localhost:8081';
const FIRMWARE_ADMIN_KEY = process.env.FIRMWARE_ADMIN_KEY || '';

function normalizeDeviceAddress(addr: string): string {
  const hex = addr.replace(/^0x/i, '').toLowerCase();
  return `0x${hex}`;
}

async function getChallenge(): Promise<string> {
  const response = await fetch(`${PROXY_BASE_URL}/api/admin/challenge`);
  if (!response.ok) {
    throw new Error(`Challenge request failed: ${response.status} ${response.statusText}`);
  }
  const { nonce } = (await response.json()) as { nonce: string };
  return nonce;
}

async function getSetupFirmware(project: string): Promise<{
  version: string;
  sha256: string;
  size: number;
  url: string;
}> {
  const response = await fetch(
    `${PROXY_BASE_URL}/api/firmware/${encodeURIComponent(project)}/setup`
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Setup firmware lookup failed: ${response.status} - ${error}`);
  }
  return response.json() as Promise<{
    version: string;
    sha256: string;
    size: number;
    url: string;
  }>;
}

async function revokeDevice(project: string, device: string): Promise<any> {
  if (!FIRMWARE_ADMIN_KEY) {
    throw new Error('FIRMWARE_ADMIN_KEY not set in .env');
  }

  const setup = await getSetupFirmware(project);
  console.log(`Setup firmware: v${setup.version} sha256=${setup.sha256}`);

  const nonce = await getChallenge();
  const normalized = normalizeDeviceAddress(device);
  const message = `revoke:${project}:${normalized}:${setup.sha256}:${nonce}`;

  const wallet = new Wallet(FIRMWARE_ADMIN_KEY);
  console.log(`Signing message: ${message}`);
  const signature = await wallet.signMessage(message);
  console.log(`Signing address: ${wallet.address}`);

  const response = await fetch(
    `${PROXY_BASE_URL}/api/firmware/${encodeURIComponent(project)}/revoke`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: normalized, message, signature }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Revoke failed: ${response.status} - ${error}`);
  }

  return response.json();
}

async function cancelRevoke(project: string, device: string): Promise<any> {
  if (!FIRMWARE_ADMIN_KEY) {
    throw new Error('FIRMWARE_ADMIN_KEY not set in .env');
  }

  const nonce = await getChallenge();
  const normalized = normalizeDeviceAddress(device);
  const message = `revoke-cancel:${project}:${normalized}:${nonce}`;

  const wallet = new Wallet(FIRMWARE_ADMIN_KEY);
  console.log(`Signing message: ${message}`);
  const signature = await wallet.signMessage(message);
  console.log(`Signing address: ${wallet.address}`);

  const response = await fetch(
    `${PROXY_BASE_URL}/api/firmware/${encodeURIComponent(project)}/revoke/cancel`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: normalized, message, signature }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cancel failed: ${response.status} - ${error}`);
  }

  return response.json();
}

async function main() {
  const args = process.argv.slice(2);
  const cancel = args.includes('--cancel');
  const positional = args.filter(a => a !== '--cancel');

  if (positional.length < 2) {
    console.error('Usage: ts-node revoke.ts <project> <deviceAddress>');
    console.error('       ts-node revoke.ts --cancel <project> <deviceAddress>');
    console.error('Example: ts-node revoke.ts garagedoor 0xabc123...');
    process.exit(1);
  }

  const [project, device] = positional;

  if (!FIRMWARE_ADMIN_KEY) {
    console.error('Error: FIRMWARE_ADMIN_KEY not set in .env');
    process.exit(1);
  }

  console.log(`Project: ${project}`);
  console.log(`Device:  ${normalizeDeviceAddress(device)}`);
  console.log(`Action:  ${cancel ? 'cancel' : 'revoke'}`);

  const result = cancel
    ? await cancelRevoke(project, device)
    : await revokeDevice(project, device);

  console.log('\n✅ Success!');
  console.log(JSON.stringify(result, null, 2));

  if (!cancel) {
    if (result.queued) {
      console.log('\n⏳ Device offline — revoke queued for next login');
    } else {
      console.log('\n📢 Revoke notice delivered to connected device');
    }
  }
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
