import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FirmwareService } from '../service/FirmwareService';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB_PATH = './test-firmware.db';

describe('FirmwareService', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    FirmwareService.resetInstance();
  });

  afterEach(() => {
    const service = FirmwareService.getInstance(TEST_DB_PATH);
    service.close();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    FirmwareService.resetInstance();
  });

  describe('computeSha256', () => {
    it('should compute correct SHA256 hash', () => {
      const buffer = Buffer.from('test data');
      const hash = FirmwareService.computeSha256(buffer);
      expect(hash).toBe('916f0027a575074ce72a331777c3478d6513f786a591bd892da1a577bf2335f9');
    });
  });

  describe('addFirmware', () => {
    it('should add firmware metadata', () => {
      const service = FirmwareService.getInstance(TEST_DB_PATH);
      
      const metadata = service.addFirmware(
        'GarageDoor',
        '1.0.0',
        'abc123',
        1024,
        'firmware/GarageDoor/1.0.0/firmware.bin',
        'https://example.com/firmware.bin',
        '0x1234'
      );
      
      expect(metadata.project).toBe('GarageDoor');
      expect(metadata.version).toBe('1.0.0');
      expect(metadata.sha256).toBe('abc123');
      expect(metadata.size).toBe(1024);
      expect(metadata.isCurrent).toBe(true);
      expect(metadata.uploadedBy).toBe('0x1234');
    });

    it('should mark only one version as current', () => {
      const service = FirmwareService.getInstance(TEST_DB_PATH);
      
      service.addFirmware('GarageDoor', '1.0.0', 'hash1', 1024, 'key1', 'url1', '0x1234');
      service.addFirmware('GarageDoor', '1.1.0', 'hash2', 2048, 'key2', 'url2', '0x1234');
      
      const latest = service.getLatestFirmware('GarageDoor');
      expect(latest?.version).toBe('1.1.0');
    });

    it('should allow multiple projects', () => {
      const service = FirmwareService.getInstance(TEST_DB_PATH);
      
      service.addFirmware('GarageDoor', '1.0.0', 'hash1', 1024, 'key1', 'url1');
      service.addFirmware('RemoteCamera', '2.0.0', 'hash2', 2048, 'key2', 'url2');
      
      const garage = service.getLatestFirmware('GarageDoor');
      const camera = service.getLatestFirmware('RemoteCamera');
      
      expect(garage?.version).toBe('1.0.0');
      expect(camera?.version).toBe('2.0.0');
    });
  });

  describe('getLatestFirmware', () => {
    it('should return null for nonexistent project', () => {
      const service = FirmwareService.getInstance(TEST_DB_PATH);
      const latest = service.getLatestFirmware('Nonexistent');
      expect(latest).toBeNull();
    });

    it('should return current version', () => {
      const service = FirmwareService.getInstance(TEST_DB_PATH);
      
      service.addFirmware('GarageDoor', '1.0.0', 'hash1', 1024, 'key1', 'url1');
      service.addFirmware('GarageDoor', '1.1.0', 'hash2', 2048, 'key2', 'url2');
      
      const latest = service.getLatestFirmware('GarageDoor');
      expect(latest).toBeDefined();
      expect(latest?.version).toBe('1.1.0');
      expect(latest?.project).toBe('GarageDoor');
    });
  });

  describe('listVersions', () => {
    it('should return empty array for nonexistent project', () => {
      const service = FirmwareService.getInstance(TEST_DB_PATH);
      const versions = service.listVersions('Nonexistent');
      expect(versions).toHaveLength(0);
    });

    it('should list all versions in reverse chronological order', () => {
      const service = FirmwareService.getInstance(TEST_DB_PATH);
      
      service.addFirmware('GarageDoor', '1.0.0', 'hash1', 1024, 'key1', 'url1');
      service.addFirmware('GarageDoor', '1.1.0', 'hash2', 2048, 'key2', 'url2');
      service.addFirmware('GarageDoor', '1.2.0', 'hash3', 3072, 'key3', 'url3');
      
      const versions = service.listVersions('GarageDoor');
      expect(versions).toHaveLength(3);
      expect(versions[0].version).toBe('1.2.0');
      expect(versions[1].version).toBe('1.1.0');
      expect(versions[2].version).toBe('1.0.0');
    });
  });

  describe('setCurrentVersion', () => {
    it('should roll back to previous version', () => {
      const service = FirmwareService.getInstance(TEST_DB_PATH);
      
      service.addFirmware('GarageDoor', '1.0.0', 'hash1', 1024, 'key1', 'url1');
      service.addFirmware('GarageDoor', '1.1.0', 'hash2', 2048, 'key2', 'url2');
      
      const success = service.setCurrentVersion('GarageDoor', '1.0.0');
      expect(success).toBe(true);
      
      const latest = service.getLatestFirmware('GarageDoor');
      expect(latest?.version).toBe('1.0.0');
    });

    it('should return false for nonexistent version', () => {
      const service = FirmwareService.getInstance(TEST_DB_PATH);
      
      service.addFirmware('GarageDoor', '1.0.0', 'hash1', 1024, 'key1', 'url1');
      
      const success = service.setCurrentVersion('GarageDoor', '9.9.9');
      expect(success).toBe(false);
    });
  });

  describe('firmwareExists', () => {
    it('should return true for existing version', () => {
      const service = FirmwareService.getInstance(TEST_DB_PATH);
      
      service.addFirmware('GarageDoor', '1.0.0', 'hash1', 1024, 'key1', 'url1');
      
      expect(service.firmwareExists('GarageDoor', '1.0.0')).toBe(true);
    });

    it('should return false for nonexistent version', () => {
      const service = FirmwareService.getInstance(TEST_DB_PATH);
      
      expect(service.firmwareExists('GarageDoor', '1.0.0')).toBe(false);
    });
  });
});
