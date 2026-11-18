#!/usr/bin/env ts-node
/**
 * Combined telemetry + Zigbee diagnostics pull and analyse.
 *
 * Runs:
 *   1. SmartLayer telemetry pull
 *   2. SmartLayer telemetry analyse
 *   3. Zigbee diagnostics pull
 *   4. Zigbee diagnostics analyse
 *
 * Pass-through flags (e.g. --ack, --dry-run) are forwarded to both pull scripts.
 * Zigbee events are only acked when --ack is present (same as pull-zigbee.ts).
 *
 * Usage:
 *   npm run telemetry:all
 *   npm run telemetry:all -- --ack --dry-run
 */

import { spawnSync } from 'child_process';
import { join } from 'path';

const root = join(__dirname, '..', '..');
const args = process.argv.slice(2);

function run(script: string, extraArgs: string[] = []): void {
  const result = spawnSync(
    process.execPath,
    ['-r', 'ts-node/register', join(__dirname, script), ...extraArgs],
    {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    }
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('=== SmartLayer telemetry: pull ===');
run('pull.ts', args);

console.log('\n=== SmartLayer telemetry: analyse ===');
run('analyse.ts');

console.log('\n=== Zigbee diagnostics: pull ===');
run('pull-zigbee.ts', args);

console.log('\n=== Zigbee diagnostics: analyse ===');
run('analyse-zigbee.ts');

console.log('\nDone.');
