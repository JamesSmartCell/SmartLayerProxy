/**
 * AdminAuthService - Manages signed-challenge admin authentication
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { recoverAddressFromSignature, getEthereumMessageHash } from '../crypto/signature';

interface Nonce {
  value: string;
  createdAt: number;
  expiresAt: number;
}

export class AdminAuthService {
  private static instance: AdminAuthService;
  private nonces = new Map<string, Nonce>();
  private readonly NONCE_TTL_MS = 60 * 1000; // 60 seconds
  private readonly CLEANUP_INTERVAL_MS = 30 * 1000; // 30 seconds
  private cleanupTimer?: NodeJS.Timeout;

  private constructor() {
    this.startCleanup();
  }

  static getInstance(): AdminAuthService {
    if (!AdminAuthService.instance) {
      AdminAuthService.instance = new AdminAuthService();
    }
    return AdminAuthService.instance;
  }

  static resetInstance(): void {
    if (AdminAuthService.instance) {
      AdminAuthService.instance.stop();
      AdminAuthService.instance = null as any;
    }
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.cleanupExpiredNonces(), this.CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  private cleanupExpiredNonces(): void {
    const now = Date.now();
    for (const [nonce, info] of this.nonces.entries()) {
      if (now > info.expiresAt) {
        this.nonces.delete(nonce);
      }
    }
  }

  generateChallenge(): { nonce: string; expiresAt: number } {
    const nonce = randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + this.NONCE_TTL_MS;

    this.nonces.set(nonce, {
      value: nonce,
      createdAt: now,
      expiresAt,
    });

    return { nonce, expiresAt };
  }

  verifyAdminSignature(
    message: string,
    signatureHex: string,
    adminAddresses: string[]
  ): { valid: boolean; address?: string; error?: string } {
    try {
      const messageBytes = Buffer.from(message, 'utf-8');
      const messageHash = getEthereumMessageHash(messageBytes);
      const signatureBytes = Buffer.from(signatureHex.replace(/^0x/i, ''), 'hex');

      const recoveredAddress = recoverAddressFromSignature(messageHash, signatureBytes);
      if (!recoveredAddress) {
        return { valid: false, error: 'Failed to recover address from signature' };
      }

      const normalizedRecovered = recoveredAddress.toLowerCase();
      const normalizedAdmins = adminAddresses.map(a => a.toLowerCase());

      if (!normalizedAdmins.includes(normalizedRecovered)) {
        return { valid: false, error: 'Address not in admin list' };
      }

      return { valid: true, address: normalizedRecovered };
    } catch (err) {
      return { valid: false, error: `Signature verification failed: ${err}` };
    }
  }

  verifyAndBurnNonce(
    nonce: string,
    message: string,
    signatureHex: string,
    adminAddresses: string[]
  ): { valid: boolean; address?: string; error?: string } {
    const nonceInfo = this.nonces.get(nonce);
    if (!nonceInfo) {
      return { valid: false, error: 'Invalid or expired nonce' };
    }

    const now = Date.now();
    if (now > nonceInfo.expiresAt) {
      this.nonces.delete(nonce);
      return { valid: false, error: 'Nonce expired' };
    }

    // Verify the message includes the nonce
    if (!message.includes(nonce)) {
      return { valid: false, error: 'Message does not contain nonce' };
    }

    // Burn the nonce immediately
    this.nonces.delete(nonce);

    // Verify the signature
    return this.verifyAdminSignature(message, signatureHex, adminAddresses);
  }

  /**
   * Constant-time comparison for bearer tokens
   */
  static constantTimeCompare(a: string, b: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') {
      return false;
    }

    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');

    if (bufA.length !== bufB.length) {
      return false;
    }

    try {
      return timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }
}
