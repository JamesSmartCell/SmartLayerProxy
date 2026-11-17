import { describe, it, expect } from 'vitest';
import { FirmwareVersionParser } from '../service/FirmwareVersionParser';

describe('FirmwareVersionParser', () => {
  describe('parse', () => {
    it('should parse valid new-format version strings', () => {
      const result = FirmwareVersionParser.parse('garagedoor@1.2.3+abc123');
      expect(result).toEqual({
        project: 'garagedoor',
        semver: '1.2.3',
        hash: 'abc123',
        major: 1,
        minor: 2,
        patch: 3,
      });
    });

    it('should parse version without hash', () => {
      const result = FirmwareVersionParser.parse('remotecamera@2.0.1');
      expect(result).toEqual({
        project: 'remotecamera',
        semver: '2.0.1',
        hash: undefined,
        major: 2,
        minor: 0,
        patch: 1,
      });
    });

    it('should normalize project name to lowercase', () => {
      const result = FirmwareVersionParser.parse('GarageDoor@1.0.0+abc');
      expect(result?.project).toBe('garagedoor');
    });

    it('should return null for legacy format', () => {
      expect(FirmwareVersionParser.parse('legacy-version')).toBeNull();
      expect(FirmwareVersionParser.parse('1.2.3')).toBeNull();
      expect(FirmwareVersionParser.parse('v1.2.3')).toBeNull();
    });

    it('should return null for empty or invalid strings', () => {
      expect(FirmwareVersionParser.parse('')).toBeNull();
      expect(FirmwareVersionParser.parse('invalid')).toBeNull();
      expect(FirmwareVersionParser.parse('project@')).toBeNull();
      expect(FirmwareVersionParser.parse('project@invalid')).toBeNull();
    });

    it('should handle project names with hyphens and underscores', () => {
      const result = FirmwareVersionParser.parse('my-project_v2@1.0.0');
      expect(result?.project).toBe('my-project_v2');
    });

    it('should handle version 0.0.0', () => {
      const result = FirmwareVersionParser.parse('project@0.0.0');
      expect(result).toEqual({
        project: 'project',
        semver: '0.0.0',
        hash: undefined,
        major: 0,
        minor: 0,
        patch: 0,
      });
    });
  });

  describe('compareSemver', () => {
    it('should return 0 for equal versions', () => {
      expect(FirmwareVersionParser.compareSemver('1.2.3', '1.2.3')).toBe(0);
      expect(FirmwareVersionParser.compareSemver('0.0.0', '0.0.0')).toBe(0);
    });

    it('should return negative when first version is older', () => {
      expect(FirmwareVersionParser.compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
      expect(FirmwareVersionParser.compareSemver('1.2.3', '1.3.0')).toBeLessThan(0);
      expect(FirmwareVersionParser.compareSemver('1.2.3', '2.0.0')).toBeLessThan(0);
    });

    it('should return positive when first version is newer', () => {
      expect(FirmwareVersionParser.compareSemver('1.2.4', '1.2.3')).toBeGreaterThan(0);
      expect(FirmwareVersionParser.compareSemver('1.3.0', '1.2.3')).toBeGreaterThan(0);
      expect(FirmwareVersionParser.compareSemver('2.0.0', '1.2.3')).toBeGreaterThan(0);
    });

    it('should handle major version differences', () => {
      expect(FirmwareVersionParser.compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
      expect(FirmwareVersionParser.compareSemver('1.0.0', '2.0.0')).toBeLessThan(0);
    });

    it('should handle minor version differences', () => {
      expect(FirmwareVersionParser.compareSemver('1.3.0', '1.2.9')).toBeGreaterThan(0);
      expect(FirmwareVersionParser.compareSemver('1.2.0', '1.3.0')).toBeLessThan(0);
    });

    it('should handle patch version differences', () => {
      expect(FirmwareVersionParser.compareSemver('1.2.4', '1.2.3')).toBeGreaterThan(0);
      expect(FirmwareVersionParser.compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
    });
  });

  describe('isOlder', () => {
    it('should return true when device version is older', () => {
      expect(FirmwareVersionParser.isOlder('1.2.3', '1.2.4')).toBe(true);
      expect(FirmwareVersionParser.isOlder('1.2.3', '1.3.0')).toBe(true);
      expect(FirmwareVersionParser.isOlder('1.2.3', '2.0.0')).toBe(true);
    });

    it('should return false when device version is equal or newer', () => {
      expect(FirmwareVersionParser.isOlder('1.2.4', '1.2.3')).toBe(false);
      expect(FirmwareVersionParser.isOlder('1.2.3', '1.2.3')).toBe(false);
      expect(FirmwareVersionParser.isOlder('2.0.0', '1.9.9')).toBe(false);
    });
  });

  describe('isNewFormat', () => {
    it('should return true for new format strings', () => {
      expect(FirmwareVersionParser.isNewFormat('garagedoor@1.2.3+abc')).toBe(true);
      expect(FirmwareVersionParser.isNewFormat('project@0.0.1')).toBe(true);
      expect(FirmwareVersionParser.isNewFormat('my-proj@1.0.0+abc123')).toBe(true);
    });

    it('should return false for legacy format strings', () => {
      expect(FirmwareVersionParser.isNewFormat('legacy')).toBe(false);
      expect(FirmwareVersionParser.isNewFormat('1.2.3')).toBe(false);
      expect(FirmwareVersionParser.isNewFormat('v1.2.3')).toBe(false);
      expect(FirmwareVersionParser.isNewFormat('')).toBe(false);
    });
  });
});
