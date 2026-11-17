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

const FIRMWARE_VERSION_REGEX = /^([a-z0-9_-]+)@(\d+\.\d+\.\d+)(?:\+([a-f0-9]+))?$/i;

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
   * Compare two semver strings
   * Returns:
   *   - negative if v1 < v2
   *   - 0 if v1 === v2
   *   - positive if v1 > v2
   */
  static compareSemver(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(n => parseInt(n, 10));
    const parts2 = v2.split('.').map(n => parseInt(n, 10));

    for (let i = 0; i < 3; i++) {
      const diff = (parts1[i] || 0) - (parts2[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  /**
   * Check if a device version is older than the latest version
   */
  static isOlder(deviceVersion: string, latestVersion: string): boolean {
    return this.compareSemver(deviceVersion, latestVersion) < 0;
  }

  /**
   * Check if a firmware version string is in the new format
   */
  static isNewFormat(versionString: string): boolean {
    return FIRMWARE_VERSION_REGEX.test(versionString);
  }
}
