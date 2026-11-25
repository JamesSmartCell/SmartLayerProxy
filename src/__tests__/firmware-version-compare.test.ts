import { describe, it, expect } from 'vitest';
import { FirmwareVersionParser } from '../service/FirmwareVersionParser';

describe('Firmware Version Comparison for Auto-Notify', () => {
  describe('1.2.10 > 1.2.7 comparison (issue from requirements)', () => {
    it('should correctly identify 1.2.7 as older than 1.2.10', () => {
      const result = FirmwareVersionParser.isOlder('1.2.7', '1.2.10');
      expect(result).toBe(true);
    });

    it('should correctly identify 1.2.9 as older than 1.2.10', () => {
      const result = FirmwareVersionParser.isOlder('1.2.9', '1.2.10');
      expect(result).toBe(true);
    });

    it('should correctly identify 1.2.10 as NOT older than 1.2.10', () => {
      const result = FirmwareVersionParser.isOlder('1.2.10', '1.2.10');
      expect(result).toBe(false);
    });

    it('should correctly identify 1.2.11 as NOT older than 1.2.10', () => {
      const result = FirmwareVersionParser.isOlder('1.2.11', '1.2.10');
      expect(result).toBe(false);
    });
  });

  describe('compareSemver numeric comparison', () => {
    it('should compare patch versions numerically', () => {
      expect(FirmwareVersionParser.compareSemver('1.2.7', '1.2.10')).toBeLessThan(0);
      expect(FirmwareVersionParser.compareSemver('1.2.9', '1.2.10')).toBeLessThan(0);
      expect(FirmwareVersionParser.compareSemver('1.2.10', '1.2.7')).toBeGreaterThan(0);
      expect(FirmwareVersionParser.compareSemver('1.2.10', '1.2.10')).toBe(0);
    });

    it('should compare minor versions numerically', () => {
      expect(FirmwareVersionParser.compareSemver('1.9.0', '1.10.0')).toBeLessThan(0);
      expect(FirmwareVersionParser.compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0);
    });

    it('should compare major versions numerically', () => {
      expect(FirmwareVersionParser.compareSemver('9.0.0', '10.0.0')).toBeLessThan(0);
      expect(FirmwareVersionParser.compareSemver('10.0.0', '9.0.0')).toBeGreaterThan(0);
    });
  });

  describe('version string format handling', () => {
    it('should ignore +hash suffix when comparing', () => {
      expect(FirmwareVersionParser.isOlder('1.2.7+e0a8bb6', '1.2.10')).toBe(true);
      expect(FirmwareVersionParser.isOlder('garagedoor@1.2.7+e0a8bb6', '1.2.10')).toBe(true);
    });

    it('should handle full device format with project name', () => {
      expect(FirmwareVersionParser.isOlder('garagedoor@1.2.7+abc', 'garagedoor@1.2.10+def')).toBe(true);
    });

    it('should return null for unparseable versions', () => {
      expect(FirmwareVersionParser.isOlder('invalid', '1.2.10')).toBeNull();
      expect(FirmwareVersionParser.isOlder('1.2.7', 'invalid')).toBeNull();
      expect(FirmwareVersionParser.isOlder('', '1.2.10')).toBeNull();
    });
  });

  describe('project name handling', () => {
    it('should extract project name correctly', () => {
      const parsed = FirmwareVersionParser.parse('garagedoor@1.2.7+abc');
      expect(parsed).not.toBeNull();
      expect(parsed!.project).toBe('garagedoor');
      expect(parsed!.semver).toBe('1.2.7');
    });

    it('should normalize project names to lowercase', () => {
      const parsed = FirmwareVersionParser.parse('GarageDoor@1.2.7+abc');
      expect(parsed).not.toBeNull();
      expect(parsed!.project).toBe('garagedoor');
    });

    it('should handle different project names', () => {
      const gd = FirmwareVersionParser.parse('garagedoor@1.2.7+abc');
      const rc = FirmwareVersionParser.parse('remotecamera@1.2.7+abc');
      const zb = FirmwareVersionParser.parse('zigbee-gateway@1.2.7+abc');

      expect(gd!.project).toBe('garagedoor');
      expect(rc!.project).toBe('remotecamera');
      expect(zb!.project).toBe('zigbee-gateway');
    });
  });

  describe('edge cases for auto-notify', () => {
    it('should handle devices with same version correctly', () => {
      expect(FirmwareVersionParser.isOlder('1.2.10', '1.2.10')).toBe(false);
      expect(FirmwareVersionParser.isOlder('garagedoor@1.2.10+abc', '1.2.10')).toBe(false);
    });

    it('should handle devices with newer versions correctly', () => {
      expect(FirmwareVersionParser.isOlder('1.2.11', '1.2.10')).toBe(false);
      expect(FirmwareVersionParser.isOlder('1.3.0', '1.2.10')).toBe(false);
      expect(FirmwareVersionParser.isOlder('2.0.0', '1.2.10')).toBe(false);
    });

    it('should handle legacy format gracefully', () => {
      expect(FirmwareVersionParser.parse('legacy-format')).toBeNull();
      expect(FirmwareVersionParser.isOlder('legacy-format', '1.2.10')).toBeNull();
    });

    it('should handle missing versions gracefully', () => {
      expect(FirmwareVersionParser.parse('')).toBeNull();
      expect(FirmwareVersionParser.parse(undefined as any)).toBeNull();
      expect(FirmwareVersionParser.isOlder('', '1.2.10')).toBeNull();
    });
  });
});
