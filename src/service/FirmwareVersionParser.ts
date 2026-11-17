/**
 * FirmwareVersionParser - Parse and compare firmware version strings
 * 
 * Expected format: "<project>@<semver>+<hash>"
 * Examples:
 *   - garagedoor@1.2.0+ab12cd3
 *   - remotecamera@0.5.1+def4567
 */

export interface ParsedFirmwareVersion {
  project: string;
  semver: string;
  hash?: string;
  major: number;
  minor: number;
  patch: number;
}

const FIRMWARE_VERSION_REGEX = /^([a-z0-9_-]+)@(\d+\.\d+\.\d+)(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/i;
const PLAIN_SEMVER_REGEX = /^v?(\d+)\.(\d+)\.(\d+)$/;

export class FirmwareVersionParser {
  /**
   * Parse a firmware version string in the format "<project>@<semver>+<hash>"
   * Returns null if the format doesn't match
   */
  static parse(versionString: string): ParsedFirmwareVersion | null {
    if (!versionString) return null;
    
    const match = versionString.match(FIRMWARE_VERSION_REGEX);
    if (!match) return null;

    const [, project, semver, hash] = match;
    const [major, minor, patch] = semver.split('.').map(n => parseInt(n, 10));

    if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
      return null;
    }

    return {
      project: project.toLowerCase(),
      semver,
      hash,
      major,
      minor,
      patch,
    };
  }

  /**
   * Extract MAJOR.MINOR.PATCH from a version string that may be:
   * - Plain semver: "1.2.3" or "v1.2.3"
   * - Full device format: "project@1.2.3+hash"
   * - With build suffix: "1.2.3+hash"
   * 
   * Returns null if the version cannot be parsed
   */
  static extractSemver(versionString: string): string | null {
    if (!versionString) return null;

    // Try plain semver first (with optional leading v)
    const plainMatch = versionString.match(PLAIN_SEMVER_REGEX);
    if (plainMatch) {
      const [, major, minor, patch] = plainMatch;
      return `${major}.${minor}.${patch}`;
    }

    // Try full device format: project@semver+hash
    const fullMatch = versionString.match(/^[a-z0-9_-]+@(\d+\.\d+\.\d+)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i);
    if (fullMatch) {
      return fullMatch[1];
    }

    // Try semver with build suffix: semver+hash (any alphanumeric suffix)
    const buildMatch = versionString.match(/^(\d+\.\d+\.\d+)\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/i);
    if (buildMatch) {
      return buildMatch[1];
    }

    return null;
  }

  /**
   * Validate that a string is plain semver MAJOR.MINOR.PATCH (no v prefix, no suffix)
   * Returns true if valid, false otherwise
   */
  static isPlainSemver(versionString: string): boolean {
    if (!versionString) return false;
    const match = versionString.match(/^(\d+)\.(\d+)\.(\d+)$/);
    return match !== null;
  }

  /**
   * Compare two version strings, extracting semver from either format
   * Returns:
   *   - negative if v1 < v2
   *   - 0 if v1 === v2
   *   - positive if v1 > v2
   *   - null if either version cannot be parsed
   */
  static compareSemver(v1: string, v2: string): number | null {
    const semver1 = this.extractSemver(v1);
    const semver2 = this.extractSemver(v2);

    if (!semver1 || !semver2) return null;

    const parts1 = semver1.split('.').map(n => parseInt(n, 10));
    const parts2 = semver2.split('.').map(n => parseInt(n, 10));

    for (let i = 0; i < 3; i++) {
      const diff = (parts1[i] || 0) - (parts2[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  /**
   * Check if a device version is older than the latest version
   * Returns null if versions cannot be compared
   */
  static isOlder(deviceVersion: string, latestVersion: string): boolean | null {
    const result = this.compareSemver(deviceVersion, latestVersion);
    return result !== null ? result < 0 : null;
  }

  /**
   * Check if a firmware version string is in the new format
   */
  static isNewFormat(versionString: string): boolean {
    return FIRMWARE_VERSION_REGEX.test(versionString);
  }
}
