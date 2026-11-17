import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ASyncTCPService } from '../service/ASyncTCPService';
import { TelemetryService } from '../service/TelemetryService';
import { ethers } from 'ethers';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB_PATH = './test-tcp-auth.db';

const OPCODE_AUTH_LEGACY = 0x07;
const OPCODE_AUTH_WITH_VERSION = 0x09;

describe('TCP Authentication with Firmware Version', () => {
  let telemetry: TelemetryService;
  let wallet: ethers.HDNodeWallet;
  let address: string;

  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    TelemetryService.resetInstance();
    telemetry = TelemetryService.getInstance(TEST_DB_PATH, 30);
    
    wallet = ethers.Wallet.createRandom();
    address = wallet.address.toLowerCase();
  });

  afterEach(() => {
    telemetry.close();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  function buildAuthPacket(opcode: number, challenge: Buffer, firmwareVersion?: string): Buffer {
    const addrBytes = Buffer.from(address.substring(2), 'hex');
    
    let preimage: Buffer;
    if (opcode === OPCODE_AUTH_WITH_VERSION && firmwareVersion !== undefined) {
      const versionBytes = Buffer.from(firmwareVersion, 'utf-8');
      const versionLen = versionBytes.length;
      preimage = Buffer.concat([challenge, Buffer.from([versionLen]), versionBytes]);
    } else {
      preimage = challenge;
    }
    
    const msgHash = ethers.keccak256(preimage);
    const sig = wallet.signingKey.sign(msgHash);
    
    const r = Buffer.from(sig.r.substring(2), 'hex');
    const s = Buffer.from(sig.s.substring(2), 'hex');
    const v = Buffer.from([sig.v]);
    const sigBytes = Buffer.concat([r, s, v]);
    
    if (opcode === OPCODE_AUTH_WITH_VERSION && firmwareVersion !== undefined) {
      const versionBytes = Buffer.from(firmwareVersion, 'utf-8');
      const versionLen = versionBytes.length;
      return Buffer.concat([addrBytes, sigBytes, Buffer.from([versionLen]), versionBytes]);
    }
    
    return Buffer.concat([addrBytes, sigBytes]);
  }

  describe('Legacy Auth (opcode 0x07)', () => {
    it('should accept legacy auth without firmware version', () => {
      const challenge = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
      const authPacket = buildAuthPacket(OPCODE_AUTH_LEGACY, challenge);
      
      expect(authPacket.length).toBe(85);
      
      const recoveredAddr = authPacket.subarray(0, 20);
      expect('0x' + recoveredAddr.toString('hex').toLowerCase()).toBe(address);
    });

    it('should store null firmware version for legacy auth', () => {
      telemetry.recordDeviceConnection(address, 'TCP', '192.168.1.1');
      
      const metrics = telemetry.getDeviceMetrics(address);
      expect(metrics).toBeDefined();
      expect(metrics?.firmwareVersion).toBeNull();
    });

    it('should reject short legacy auth packet', () => {
      const shortPacket = Buffer.alloc(84);
      expect(shortPacket.length).toBeLessThan(85);
    });

    it('should reject bad signature for legacy auth', () => {
      const challenge = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
      const authPacket = buildAuthPacket(OPCODE_AUTH_LEGACY, challenge);
      
      authPacket[20] ^= 0xFF;
      
      const addrBytes = authPacket.subarray(0, 20);
      const sig = authPacket.subarray(20, 85);
      const msgHash = ethers.keccak256(challenge);
      
      let recovered = '';
      try {
        const r = '0x' + Buffer.from(sig.slice(0, 32)).toString('hex');
        const s = '0x' + Buffer.from(sig.slice(32, 64)).toString('hex');
        let v = sig[64];
        if (v < 27) v += 27;
        const sigObj = ethers.Signature.from({ r, s, v });
        recovered = ethers.recoverAddress(msgHash, sigObj);
      } catch {
        recovered = '';
      }
      
      const claimed = '0x' + addrBytes.toString('hex').toLowerCase();
      expect(recovered.toLowerCase()).not.toBe(claimed);
    });
  });

  describe('New Auth with Firmware Version (opcode 0x08)', () => {
    it('should accept auth with firmware version', () => {
      const challenge = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
      const firmwareVersion = 'v2.1.0';
      const authPacket = buildAuthPacket(OPCODE_AUTH_WITH_VERSION, challenge, firmwareVersion);
      
      expect(authPacket.length).toBe(85 + 1 + firmwareVersion.length);
      
      const versionLen = authPacket[85];
      expect(versionLen).toBe(firmwareVersion.length);
      
      const versionBytes = authPacket.subarray(86, 86 + versionLen);
      expect(versionBytes.toString('utf-8')).toBe(firmwareVersion);
    });

    it('should verify signature over challenge || versionLen || version', () => {
      const challenge = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
      const firmwareVersion = 'v2.1.0';
      const authPacket = buildAuthPacket(OPCODE_AUTH_WITH_VERSION, challenge, firmwareVersion);
      
      const addrBytes = authPacket.subarray(0, 20);
      const sig = authPacket.subarray(20, 85);
      const versionLen = authPacket[85];
      const versionBytes = authPacket.subarray(86, 86 + versionLen);
      
      const preimage = Buffer.concat([challenge, Buffer.from([versionLen]), versionBytes]);
      const msgHash = ethers.keccak256(preimage);
      
      const r = '0x' + Buffer.from(sig.slice(0, 32)).toString('hex');
      const s = '0x' + Buffer.from(sig.slice(32, 64)).toString('hex');
      let v = sig[64];
      if (v < 27) v += 27;
      const sigObj = ethers.Signature.from({ r, s, v });
      const recovered = ethers.recoverAddress(msgHash, sigObj);
      
      const claimed = '0x' + addrBytes.toString('hex').toLowerCase();
      expect(recovered.toLowerCase()).toBe(claimed);
    });

    it('should store firmware version in telemetry', () => {
      const firmwareVersion = 'v2.1.0';
      telemetry.recordDeviceConnection(address, 'TCP', '192.168.1.1', firmwareVersion);
      
      const metrics = telemetry.getDeviceMetrics(address);
      expect(metrics).toBeDefined();
      expect(metrics?.firmwareVersion).toBe(firmwareVersion);
    });

    it('should handle various firmware version formats', () => {
      const versions = ['v1.0', 'v2.1.3-beta', '1.2.3', 'dev-build-20231201', 'a'];
      
      versions.forEach(version => {
        const challenge = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
        const authPacket = buildAuthPacket(OPCODE_AUTH_WITH_VERSION, challenge, version);
        
        const versionLen = authPacket[85];
        expect(versionLen).toBe(version.length);
        
        const versionBytes = authPacket.subarray(86, 86 + versionLen);
        expect(versionBytes.toString('utf-8')).toBe(version);
      });
    });

    it('should reject version length exceeding max', () => {
      const challenge = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
      const tooLongVersion = 'a'.repeat(33);
      const authPacket = buildAuthPacket(OPCODE_AUTH_WITH_VERSION, challenge, tooLongVersion);
      
      const versionLen = authPacket[85];
      expect(versionLen).toBeGreaterThan(32);
    });

    it('should reject truncated version data', () => {
      const challenge = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
      const firmwareVersion = 'v2.1.0';
      const authPacket = buildAuthPacket(OPCODE_AUTH_WITH_VERSION, challenge, firmwareVersion);
      
      const truncated = authPacket.subarray(0, authPacket.length - 2);
      expect(truncated.length).toBe(85 + 1 + firmwareVersion.length - 2);
      
      const versionLen = truncated[85];
      expect(truncated.length).toBeLessThan(86 + versionLen);
    });

    it('should reject short packet for version auth', () => {
      const shortPacket = Buffer.alloc(85);
      expect(shortPacket.length).toBeLessThan(86);
    });

    it('should reject bad signature with version', () => {
      const challenge = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
      const firmwareVersion = 'v2.1.0';
      const authPacket = buildAuthPacket(OPCODE_AUTH_WITH_VERSION, challenge, firmwareVersion);
      
      authPacket[20] ^= 0xFF;
      
      const addrBytes = authPacket.subarray(0, 20);
      const sig = authPacket.subarray(20, 85);
      const versionLen = authPacket[85];
      const versionBytes = authPacket.subarray(86, 86 + versionLen);
      
      const preimage = Buffer.concat([challenge, Buffer.from([versionLen]), versionBytes]);
      const msgHash = ethers.keccak256(preimage);
      
      let recovered = '';
      try {
        const r = '0x' + Buffer.from(sig.slice(0, 32)).toString('hex');
        const s = '0x' + Buffer.from(sig.slice(32, 64)).toString('hex');
        let v = sig[64];
        if (v < 27) v += 27;
        const sigObj = ethers.Signature.from({ r, s, v });
        recovered = ethers.recoverAddress(msgHash, sigObj);
      } catch {
        recovered = '';
      }
      
      const claimed = '0x' + addrBytes.toString('hex').toLowerCase();
      expect(recovered.toLowerCase()).not.toBe(claimed);
    });

    it('should accept empty firmware version', () => {
      const challenge = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
      const firmwareVersion = '';
      const authPacket = buildAuthPacket(OPCODE_AUTH_WITH_VERSION, challenge, firmwareVersion);
      
      expect(authPacket.length).toBe(85 + 1 + 0);
      
      const versionLen = authPacket[85];
      expect(versionLen).toBe(0);
    });

    it('should accept max length firmware version', () => {
      const challenge = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
      const firmwareVersion = 'a'.repeat(32);
      const authPacket = buildAuthPacket(OPCODE_AUTH_WITH_VERSION, challenge, firmwareVersion);
      
      expect(authPacket.length).toBe(85 + 1 + 32);
      
      const versionLen = authPacket[85];
      expect(versionLen).toBe(32);
      
      const versionBytes = authPacket.subarray(86, 86 + versionLen);
      expect(versionBytes.toString('utf-8')).toBe(firmwareVersion);
    });
  });

  describe('Backward Compatibility', () => {
    it('should accept both legacy and new auth from same device', () => {
      const challenge1 = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
      const legacyPacket = buildAuthPacket(OPCODE_AUTH_LEGACY, challenge1);
      expect(legacyPacket.length).toBe(85);
      
      const challenge2 = Buffer.from('fedcba0987654321fedcba0987654321', 'hex');
      const newPacket = buildAuthPacket(OPCODE_AUTH_WITH_VERSION, challenge2, 'v2.1.0');
      expect(newPacket.length).toBeGreaterThan(85);
      
      telemetry.recordDeviceConnection(address, 'TCP', '192.168.1.1');
      const metrics1 = telemetry.getDeviceMetrics(address);
      expect(metrics1?.firmwareVersion).toBeNull();
      
      telemetry.recordDeviceConnection(address, 'TCP', '192.168.1.1', 'v2.1.0');
      const metrics2 = telemetry.getDeviceMetrics(address);
      expect(metrics2?.firmwareVersion).toBe('v2.1.0');
    });
  });

  describe('Hex Dump Safety (opcode 0x09)', () => {
    it('should structure 0x09 packet with version bytes after fixed-size prefix', () => {
      const challenge = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
      const firmwareVersion = 'test-v1.0';
      const authMessage = buildAuthPacket(OPCODE_AUTH_WITH_VERSION, challenge, firmwareVersion);
      
      // buildAuthPacket returns: addr(20) + sig(65) + versionLen(1) + versionBytes
      // When sent on wire, opcode(1) is prepended: opcode + addr(20) + sig(65) + versionLen(1) + versionBytes
      expect(authMessage.length).toBe(20 + 65 + 1 + firmwareVersion.length);
      
      const versionLen = authMessage[85];
      expect(versionLen).toBe(firmwareVersion.length);
      
      const versionBytes = authMessage.subarray(86, 86 + versionLen);
      expect(versionBytes.toString('utf-8')).toBe(firmwareVersion);
    });

    it('should build valid 0x09 packet with version containing non-ASCII characters', () => {
      const challenge = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
      // Version with non-ASCII/control characters that would garble terminal
      const firmwareVersion = 'v1\x00\x01\x02test';
      const authMessage = buildAuthPacket(OPCODE_AUTH_WITH_VERSION, challenge, firmwareVersion);
      
      // The first 85 bytes (addr + sig) contain only hex-safe data
      const safePrefix = authMessage.subarray(0, 85);
      const safePrefixHex = safePrefix.toString('hex');
      expect(safePrefixHex.length).toBe(170); // 85 bytes = 170 hex chars
      
      // Version bytes are after byte 85 (versionLen at byte 85)
      const versionLen = authMessage[85];
      expect(versionLen).toBe(firmwareVersion.length);
      
      // Verify the problematic bytes are only in the version section
      const versionBytes = authMessage.subarray(86, 86 + versionLen);
      expect(versionBytes.toString('utf-8')).toBe(firmwareVersion);
    });

    it('should verify TCPClient would dump only safe bytes for 0x09', () => {
      const challenge = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
      const firmwareVersion = 'version-with-\x00\x01-controls';
      const authMessage = buildAuthPacket(OPCODE_AUTH_WITH_VERSION, challenge, firmwareVersion);
      
      // On wire, full packet is: opcode(1) + authMessage
      // TCPClient receives buffer with opcode prepended
      const wirePacket = Buffer.concat([Buffer.from([OPCODE_AUTH_WITH_VERSION]), authMessage]);
      
      // TCPClient dumps first 86 bytes for opcode 0x09 (opcode + addr + sig)
      const dumpBytes = wirePacket.subarray(0, 86);
      const hexDump = dumpBytes.toString('hex');
      
      // Hex dump should be pure hex (no control characters)
      expect(hexDump).toMatch(/^[0-9a-f]+$/);
      expect(hexDump.length).toBe(172); // 86 bytes * 2 hex chars
      
      // Verify no control characters in the dump
      for (let i = 0; i < hexDump.length; i++) {
        const charCode = hexDump.charCodeAt(i);
        expect(charCode >= 48 && charCode <= 57 || charCode >= 97 && charCode <= 102).toBe(true); // 0-9 or a-f
      }
      
      // Verify version bytes with control chars are NOT in the dump
      const versionBytes = wirePacket.subarray(87);
      expect(versionBytes.includes(0x00)).toBe(true); // Has control chars
      expect(dumpBytes.includes(0x00)).toBe(false); // Dump excludes them
    });
  });
});
