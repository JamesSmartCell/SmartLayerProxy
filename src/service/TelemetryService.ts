/**
 * TelemetryService - Tracks device and API metrics
 */

export interface DeviceMetrics {
  address: string;
  connectionCount: number;
  lastConnected: number;
  firstConnected: number;
  apiCalls: number;
  failedCalls: number;
  methodUsage: Record<string, number>;
  avgResponseTime: number;
  totalResponseTime: number;
  protocol: 'UDP' | 'TCP' | 'BOTH';
  ipAddress?: string;
}

export interface SystemMetrics {
  totalDevices: number;
  totalApiCalls: number;
  totalFailedCalls: number;
  activeDevices: number;
  uptime: number;
  startTime: number;
}

export class TelemetryService {
  private static instance: TelemetryService;
  private deviceMetrics: Map<string, DeviceMetrics> = new Map();
  private systemStartTime: number = Date.now();

  private constructor() {}

  static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService();
    }
    return TelemetryService.instance;
  }

  /**
   * Record a device connection
   */
  recordDeviceConnection(address: string, protocol: 'UDP' | 'TCP', ipAddress?: string): void {
    const normalized = address.toLowerCase();
    let metrics = this.deviceMetrics.get(normalized);

    if (!metrics) {
      metrics = {
        address: normalized,
        connectionCount: 0,
        lastConnected: Date.now(),
        firstConnected: Date.now(),
        apiCalls: 0,
        failedCalls: 0,
        methodUsage: {},
        avgResponseTime: 0,
        totalResponseTime: 0,
        protocol,
        ipAddress,
      };
      this.deviceMetrics.set(normalized, metrics);
    }

    metrics.connectionCount++;
    metrics.lastConnected = Date.now();
    if (ipAddress) metrics.ipAddress = ipAddress;

    // Update protocol if device uses both
    if (metrics.protocol !== protocol) {
      metrics.protocol = 'BOTH';
    }
  }

  /**
   * Record an API call
   */
  recordApiCall(
    address: string,
    method: string,
    success: boolean,
    responseTimeMs: number
  ): void {
    const normalized = address.toLowerCase();
    let metrics = this.deviceMetrics.get(normalized);

    if (!metrics) {
      // Create metrics if they don't exist
      metrics = {
        address: normalized,
        connectionCount: 0,
        lastConnected: Date.now(),
        firstConnected: Date.now(),
        apiCalls: 0,
        failedCalls: 0,
        methodUsage: {},
        avgResponseTime: 0,
        totalResponseTime: 0,
        protocol: 'UDP',
      };
      this.deviceMetrics.set(normalized, metrics);
    }

    metrics.apiCalls++;
    if (!success) metrics.failedCalls++;

    // Track method usage
    metrics.methodUsage[method] = (metrics.methodUsage[method] || 0) + 1;

    // Update response time
    metrics.totalResponseTime += responseTimeMs;
    metrics.avgResponseTime = metrics.totalResponseTime / metrics.apiCalls;
  }

  /**
   * Get metrics for a specific device
   */
  getDeviceMetrics(address: string): DeviceMetrics | undefined {
    return this.deviceMetrics.get(address.toLowerCase());
  }

  /**
   * Get all device metrics
   */
  getAllDeviceMetrics(): DeviceMetrics[] {
    return Array.from(this.deviceMetrics.values());
  }

  /**
   * Get system-wide metrics
   */
  getSystemMetrics(): SystemMetrics {
    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;

    let totalApiCalls = 0;
    let totalFailedCalls = 0;
    let activeDevices = 0;

    for (const metrics of this.deviceMetrics.values()) {
      totalApiCalls += metrics.apiCalls;
      totalFailedCalls += metrics.failedCalls;
      if (metrics.lastConnected > fiveMinutesAgo) {
        activeDevices++;
      }
    }

    return {
      totalDevices: this.deviceMetrics.size,
      totalApiCalls,
      totalFailedCalls,
      activeDevices,
      uptime: now - this.systemStartTime,
      startTime: this.systemStartTime,
    };
  }

  /**
   * Get top methods by usage
   */
  getTopMethods(limit: number = 10): Array<{ method: string; count: number }> {
    const methodCounts: Record<string, number> = {};

    for (const metrics of this.deviceMetrics.values()) {
      for (const [method, count] of Object.entries(metrics.methodUsage)) {
        methodCounts[method] = (methodCounts[method] || 0) + count;
      }
    }

    return Object.entries(methodCounts)
      .map(([method, count]) => ({ method, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /**
   * Clear old device metrics (devices not seen in 24 hours)
   */
  cleanupOldMetrics(): void {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    for (const [address, metrics] of this.deviceMetrics) {
      if (metrics.lastConnected < oneDayAgo) {
        this.deviceMetrics.delete(address);
      }
    }
  }

  /**
   * Reset all metrics (for testing)
   */
  reset(): void {
    this.deviceMetrics.clear();
    this.systemStartTime = Date.now();
  }
}
