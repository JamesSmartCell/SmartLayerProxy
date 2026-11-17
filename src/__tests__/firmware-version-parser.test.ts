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

  describe('extractSemver', () => {
    it('should extract from plain semver', () => {
      expect(FirmwareVersionParser.extractSemver('1.2.3')).toBe('1.2.3');
      expect(FirmwareVersionParser.extractSemver('0.0.1')).toBe('0.0.1');
      expect(FirmwareVersionParser.extractSemver('10.20.30')).toBe('10.20.30');
    });

    it('should extract from semver with v prefix', () => {
      expect(FirmwareVersionParser.extractSemver('v1.2.3')).toBe('1.2.3');
      expect(FirmwareVersionParser.extractSemver('v0.0.1')).toBe('0.0.1');
    });

    it('should extract from full device format', () => {
      expect(FirmwareVersionParser.extractSemver('garagedoor@1.2.3+abc123')).toBe('1.2.3');
      expect(FirmwareVersionParser.extractSemver('project@0.5.1')).toBe('0.5.1');
    });

    it('should extract from semver with build suffix', () => {
      expect(FirmwareVersionParser.extractSemver('1.2.3+abc123')).toBe('1.2.3');
      expect(FirmwareVersionParser.extractSemver('2.0.0+def4567')).toBe('2.0.0');
    });

    it('should return null for invalid formats', () => {
      expect(FirmwareVersionParser.extractSemver('invalid')).toBeNull();
      expect(FirmwareVersionParser.extractSemver('1.2')).toBeNull();
      expect(FirmwareVersionParser.extractSemver('a.b.c')).toBeNull();
      expect(FirmwareVersionParser.extractSemver('')).toBeNull();
    });
  });

  describe('isPlainSemver', () => {
    it('should return true for plain semver', () => {
      expect(FirmwareVersionParser.isPlainSemver('1.2.3')).toBe(true);
      expect(FirmwareVersionParser.isPlainSemver('0.0.0')).toBe(true);
      expect(FirmwareVersionParser.isPlainSemver('10.20.30')).toBe(true);
    });

    it('should return false for non-plain semver', () => {
      expect(FirmwareVersionParser.isPlainSemver('v1.2.3')).toBe(false);
      expect(FirmwareVersionParser.isPlainSemver('1.2.3+abc')).toBe(false);
      expect(FirmwareVersionParser.isPlainSemver('project@1.2.3')).toBe(false);
      expect(FirmwareVersionParser.isPlainSemver('1.2')).toBe(false);
      expect(FirmwareVersionParser.isPlainSemver('')).toBe(false);
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

    it('should compare versions with different formats', () => {
      expect(FirmwareVersionParser.compareSemver('1.2.3', 'v1.2.4')).toBeLessThan(0);
      expect(FirmwareVersionParser.compareSemver('v1.2.3', 'project@1.2.2+abc')).toBeGreaterThan(0);
      expect(FirmwareVersionParser.compareSemver('1.2.3+build', '1.2.3')).toBe(0);
    });

    it('should return null for unparseable versions', () => {
      expect(FirmwareVersionParser.compareSemver('invalid', '1.2.3')).toBeNull();
      expect(FirmwareVersionParser.compareSemver('1.2.3', 'invalid')).toBeNull();
      expect(FirmwareVersionParser.compareSemver('1.2', '1.2.3')).toBeNull();
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

    it('should compare versions with different formats', () => {
      expect(FirmwareVersionParser.isOlder('1.2.3', 'v1.2.4')).toBe(true);
      expect(FirmwareVersionParser.isOlder('v1.2.3', 'project@1.2.4+abc')).toBe(true);
      expect(FirmwareVersionParser.isOlder('1.2.3', '1.2.3+build')).toBe(false);
    });

    it('should return null for unparseable versions', () => {
      expect(FirmwareVersionParser.isOlder('invalid', '1.2.3')).toBeNull();
      expect(FirmwareVersionParser.isOlder('1.2.3', 'invalid')).toBeNull();
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
