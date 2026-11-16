import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AdminAuthService } from '../service/AdminAuthService';
import { Wallet, HDNodeWallet } from 'ethers';

describe('AdminAuthService', () => {
  let adminAuth: AdminAuthService;
  let wallet: HDNodeWallet;

  beforeEach(() => {
    AdminAuthService.resetInstance();
    adminAuth = AdminAuthService.getInstance();
    wallet = Wallet.createRandom();
  });

  afterEach(() => {
    AdminAuthService.resetInstance();
  });

  describe('generateChallenge', () => {
    it('should generate a unique nonce', () => {
      const challenge1 = adminAuth.generateChallenge();
      const challenge2 = adminAuth.generateChallenge();
      
      expect(challenge1.nonce).toBeDefined();
      expect(challenge1.expiresAt).toBeGreaterThan(Date.now());
      expect(challenge1.nonce).not.toBe(challenge2.nonce);
    });

    it('should set expiry to 60 seconds', () => {
      const before = Date.now();
      const challenge = adminAuth.generateChallenge();
      const after = Date.now();
      
      const expectedExpiry = before + 60 * 1000;
      expect(challenge.expiresAt).toBeGreaterThanOrEqual(expectedExpiry);
      expect(challenge.expiresAt).toBeLessThanOrEqual(after + 60 * 1000);
    });
  });

  describe('verifyAdminSignature', () => {
    it('should verify valid signature', async () => {
      const message = 'test:message:12345';
      const signature = await wallet.signMessage(message);
      
      const result = adminAuth.verifyAdminSignature(
        message,
        signature,
        [wallet.address.toLowerCase()]
      );
      
      expect(result.valid).toBe(true);
      expect(result.address).toBe(wallet.address.toLowerCase());
    });

    it('should reject signature from non-admin address', async () => {
      const message = 'test:message:12345';
      const signature = await wallet.signMessage(message);
      
      const result = adminAuth.verifyAdminSignature(
        message,
        signature,
        ['0x0000000000000000000000000000000000000001']
      );
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not in admin list');
    });

    it('should handle invalid signature', () => {
      const message = 'test:message:12345';
      const invalidSig = '0x' + '00'.repeat(65);
      
      const result = adminAuth.verifyAdminSignature(
        message,
        invalidSig,
        [wallet.address]
      );
      
      expect(result.valid).toBe(false);
    });
  });

  describe('verifyAndBurnNonce', () => {
    it('should verify and burn valid nonce', async () => {
      const challenge = adminAuth.generateChallenge();
      const message = `ack:12345:${challenge.nonce}`;
      const signature = await wallet.signMessage(message);
      
      const result = adminAuth.verifyAndBurnNonce(
        challenge.nonce,
        message,
        signature,
        [wallet.address]
      );
      
      expect(result.valid).toBe(true);
      expect(result.address).toBe(wallet.address.toLowerCase());
      
      // Nonce should be burned
      const result2 = adminAuth.verifyAndBurnNonce(
        challenge.nonce,
        message,
        signature,
        [wallet.address]
      );
      
      expect(result2.valid).toBe(false);
      expect(result2.error).toContain('Invalid or expired nonce');
    });

    it('should reject message without nonce', async () => {
      const challenge = adminAuth.generateChallenge();
      const message = 'ack:12345';
      const signature = await wallet.signMessage(message);
      
      const result = adminAuth.verifyAndBurnNonce(
        challenge.nonce,
        message,
        signature,
        [wallet.address]
      );
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('does not contain nonce');
    });

    it('should reject expired nonce', async () => {
      const challenge = adminAuth.generateChallenge();
      
      // Manually expire the nonce
      await new Promise(resolve => setTimeout(resolve, 100));
      adminAuth['nonces'].get(challenge.nonce)!.expiresAt = Date.now() - 1000;
      
      const message = `ack:12345:${challenge.nonce}`;
      const signature = await wallet.signMessage(message);
      
      const result = adminAuth.verifyAndBurnNonce(
        challenge.nonce,
        message,
        signature,
        [wallet.address]
      );
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('expired');
    });

    it('should reject nonexistent nonce', async () => {
      const fakeNonce = 'a'.repeat(64);
      const message = `ack:12345:${fakeNonce}`;
      const signature = await wallet.signMessage(message);
      
      const result = adminAuth.verifyAndBurnNonce(
        fakeNonce,
        message,
        signature,
        [wallet.address]
      );
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid or expired nonce');
    });
  });

  describe('constantTimeCompare', () => {
    it('should return true for equal strings', () => {
      expect(AdminAuthService.constantTimeCompare('hello', 'hello')).toBe(true);
      expect(AdminAuthService.constantTimeCompare('test123', 'test123')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(AdminAuthService.constantTimeCompare('hello', 'world')).toBe(false);
      expect(AdminAuthService.constantTimeCompare('test123', 'test124')).toBe(false);
    });

    it('should return false for different lengths', () => {
      expect(AdminAuthService.constantTimeCompare('hello', 'hello!')).toBe(false);
      expect(AdminAuthService.constantTimeCompare('test', 'testing')).toBe(false);
    });

    it('should handle non-string inputs', () => {
      expect(AdminAuthService.constantTimeCompare(null as any, 'test')).toBe(false);
      expect(AdminAuthService.constantTimeCompare('test', undefined as any)).toBe(false);
    });
  });
});
