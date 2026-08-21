/**
 * Durable on-disk store for passkey credentials + recovery records.
 * Survives proxy restarts (unlike the previous in-memory Maps).
 *
 * Set PASSKEY_DATA_PATH to override the default ./data/passkeys.json
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { WebAuthnCredential } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';

export interface RecoveryRecord {
  credentialId: string;
  rpId: string;
  xyHex: string;
}

interface StoredCredential {
  id: string;
  publicKeyBase64: string;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
}

interface StoreFile {
  version: 1;
  credentials: Record<string, StoredCredential>;
  recovery: Record<string, RecoveryRecord>;
}

function defaultPath(): string {
  return process.env.PASSKEY_DATA_PATH || join(process.cwd(), 'data', 'passkeys.json');
}

function emptyStore(): StoreFile {
  return { version: 1, credentials: {}, recovery: {} };
}

function encodePublicKey(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString('base64');
}

function decodePublicKey(publicKeyBase64: string): Uint8Array {
  return Buffer.from(publicKeyBase64, 'base64') as unknown as Uint8Array;
}

/**
 * Build a COSE_Key (EC2 / P-256 / ES256) from uncompressed x||y hex (64 bytes = 128 hex chars).
 * Used when recovery has xyHex but the full credential record is missing.
 */
export function xyHexToCosePublicKey(xyHex: string): Uint8Array {
  let h = xyHex.startsWith('0x') ? xyHex.slice(2) : xyHex;
  if (h.startsWith('04') && h.length === 130) h = h.slice(2);
  if (h.length !== 128) {
    throw new Error(`Invalid xyHex length: ${h.length} (expected 128)`);
  }
  const x = Buffer.from(h.slice(0, 64), 'hex');
  const y = Buffer.from(h.slice(64, 128), 'hex');
  if (x.length !== 32 || y.length !== 32) {
    throw new Error('Invalid xyHex: x/y must be 32 bytes each');
  }

  // CBOR map(5): {1:2, 3:-7, -1:1, -2:x, -3:y}
  const out = Buffer.alloc(77);
  let o = 0;
  out[o++] = 0xa5; // map(5)
  out[o++] = 0x01; // kty
  out[o++] = 0x02; // EC2
  out[o++] = 0x03; // alg
  out[o++] = 0x26; // -7 (ES256)
  out[o++] = 0x20; // crv (-1)
  out[o++] = 0x01; // P-256
  out[o++] = 0x21; // x (-2)
  out[o++] = 0x58; // bytes
  out[o++] = 0x20; // len 32
  x.copy(out, o);
  o += 32;
  out[o++] = 0x22; // y (-3)
  out[o++] = 0x58;
  out[o++] = 0x20;
  y.copy(out, o);
  return Buffer.from(out) as unknown as Uint8Array;
}

export class PasskeyStore {
  private path: string;
  private data: StoreFile;

  constructor(filePath?: string) {
    this.path = filePath || defaultPath();
    this.data = this.load();
  }

  private load(): StoreFile {
    try {
      if (!existsSync(this.path)) {
        console.log(`[PasskeyStore] No store at ${this.path} — starting empty`);
        return emptyStore();
      }
      const raw = readFileSync(this.path, 'utf-8');
      const parsed = JSON.parse(raw) as StoreFile;
      if (!parsed || parsed.version !== 1) {
        console.warn('[PasskeyStore] Unknown store version — starting empty');
        return emptyStore();
      }
      parsed.credentials = parsed.credentials || {};
      parsed.recovery = parsed.recovery || {};
      const n = Object.keys(parsed.credentials).length;
      console.log(`[PasskeyStore] Loaded ${n} credential(s) from ${this.path}`);
      return parsed;
    } catch (err) {
      console.error('[PasskeyStore] Failed to load — starting empty:', err);
      return emptyStore();
    }
  }

  private persist(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    renameSync(tmp, this.path);
  }

  getCredential(credentialId: string): WebAuthnCredential | null {
    const stored = this.data.credentials[credentialId];
    if (!stored) return null;
    return {
      id: stored.id,
      publicKey: decodePublicKey(stored.publicKeyBase64),
      counter: stored.counter,
      transports: stored.transports,
    } as WebAuthnCredential;
  }

  /**
   * Resolve credential for auth: full record first, else rebuild from recovery xyHex.
   */
  resolveCredential(credentialId: string): WebAuthnCredential | null {
    const existing = this.getCredential(credentialId);
    if (existing) return existing;

    const recovery = this.data.recovery[credentialId];
    if (!recovery?.xyHex) return null;

    try {
      const rebuilt = {
        id: credentialId,
        publicKey: xyHexToCosePublicKey(recovery.xyHex),
        counter: 0,
      } as WebAuthnCredential;
      // Persist rebuilt credential so subsequent auths have a counter
      this.putCredential(rebuilt);
      return rebuilt;
    } catch (err) {
      console.error('[PasskeyStore] Failed to rebuild credential from xyHex:', err);
      return null;
    }
  }

  putCredential(credential: WebAuthnCredential): void {
    this.data.credentials[credential.id] = {
      id: credential.id,
      publicKeyBase64: encodePublicKey(new Uint8Array(credential.publicKey)),
      counter: credential.counter ?? 0,
      transports: credential.transports,
    };
    this.persist();
  }

  updateCounter(credentialId: string, counter: number): void {
    const stored = this.data.credentials[credentialId];
    if (!stored) return;
    stored.counter = counter;
    this.persist();
  }

  upsertRecovery(record: RecoveryRecord): void {
    let xyHex = record.xyHex.startsWith('0x') ? record.xyHex.slice(2) : record.xyHex;
    if (xyHex.startsWith('04') && xyHex.length === 130) xyHex = xyHex.slice(2);
    this.data.recovery[record.credentialId] = {
      credentialId: record.credentialId,
      rpId: record.rpId,
      xyHex,
    };

    // Ensure auth can verify even if only recovery was upserted
    if (!this.data.credentials[record.credentialId]) {
      try {
        this.data.credentials[record.credentialId] = {
          id: record.credentialId,
          publicKeyBase64: encodePublicKey(xyHexToCosePublicKey(xyHex)),
          counter: 0,
        };
      } catch (err) {
        console.warn('[PasskeyStore] Could not derive credential from recovery upsert:', err);
      }
    }

    this.persist();
  }

  getRecovery(credentialId: string): RecoveryRecord | null {
    return this.data.recovery[credentialId] ?? null;
  }
}

export const passkeyStore = new PasskeyStore();
