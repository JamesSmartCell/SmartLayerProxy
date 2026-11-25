import * as net from 'net';
import { ethers } from 'ethers';
import { normalizeRemoteIp, TCPClient, TCPCallback } from './TCPClient';
import { APIClient } from './APIClient';
import { MultiValueMap } from '../types';
import { loadConfig } from '../config';
import { getEthereumMessageHash, recoverAddressFromSignature } from '../crypto/signature';
import { TelemetryService } from './TelemetryService';
import { FirmwareVersionParser } from './FirmwareVersionParser';
import {
  FirmwareService,
  normalizeDeviceAddress,
} from './FirmwareService';
import { isTrustedProxyPeer } from '../util/ip';
import {
  evaluateSessionIpPin,
  resolvePinOnLogin,
  type IpPinMode,
} from '../util/ipPin';
import {
  resolveProxyProtocol,
  ProxyProtocolError,
} from '../util/proxyProtocol';

// ESP TcpBridge treats 5 minutes without a server packet as a dead session, and
// it checks that *before* reading the inbound 0x06. Send keepalives sooner.
const KEEPALIVE_INTERVAL_MS = 2 * 60 * 1000;
const UNAUTH_GRACE_MS = 30 * 1000;
const MAX_TCP_CLIENTS = 64;
const HEX_RE = /^[0-9a-fA-F]*$/;

const OPCODE_AUTH_LEGACY = 0x07;
const OPCODE_AUTH_WITH_VERSION = 0x09;
const OPCODE_WIFI_DIAGNOSTICS = 0x0A;
const MAX_FIRMWARE_VERSION_LEN = 32;

function decodeEspResetReason(code: number): string {
  const reasons: Record<number, string> = {
    1: 'POWERON',
    2: 'EXT',
    3: 'SW',
    4: 'PANIC',
    5: 'INT_WDT',
    6: 'TASK_WDT',
    7: 'WDT',
    8: 'DEEPSLEEP',
    9: 'BROWNOUT',
    10: 'SDIO',
  };
  return reasons[code] || `UNKNOWN(${code})`;
}

function decodeFailureStage(code: number): string {
  const stages: Record<number, string> = {
    0: 'none',
    1: 'wifi_assoc',
    2: 'wifi_auth',
    3: 'dhcp',
    4: 'dns',
    5: 'tls',
    6: 'proxy_connect',
  };
  return stages[code] || `unknown(${code})`;
}

function decodeWifiDisconnectReason(code: number): string {
  const reasons: Record<number, string> = {
    0: 'none',
    1: 'UNSPECIFIED',
    2: 'AUTH_EXPIRE',
    3: 'AUTH_LEAVE',
    4: 'ASSOC_EXPIRE',
    5: 'ASSOC_TOOMANY',
    6: 'NOT_AUTHED',
    7: 'NOT_ASSOCED',
    8: 'ASSOC_LEAVE',
    9: 'ASSOC_NOT_AUTHED',
    10: 'DISASSOC_PWRCAP_BAD',
    11: 'DISASSOC_SUPCHAN_BAD',
    13: 'IE_INVALID',
    14: 'MIC_FAILURE',
    15: 'FOURWAY_HANDSHAKE_TIMEOUT',
    16: 'GROUP_KEY_UPDATE_TIMEOUT',
    17: 'IE_IN_4WAY_DIFFERS',
    18: 'GROUP_CIPHER_INVALID',
    19: 'PAIRWISE_CIPHER_INVALID',
    20: 'AKMP_INVALID',
    21: 'UNSUPP_RSN_IE_VERSION',
    22: 'INVALID_RSN_IE_CAP',
    23: 'IEEE_802_1X_AUTH_FAILED',
    24: 'CIPHER_SUITE_REJECTED',
    200: 'BEACON_TIMEOUT',
    201: 'NO_AP_FOUND',
    202: 'AUTH_FAIL',
    203: 'ASSOC_FAIL',
    204: 'HANDSHAKE_TIMEOUT',
    205: 'CONNECTION_FAIL',
    206: 'AP_TSF_RESET',
  };
  return reasons[code] || `unknown(${code})`;
}

function createChallenge(): Buffer {
  return Buffer.from(require('crypto').randomBytes(16));
}

function sanitizeFirmwareVersion(version: string): string {
  return version.replace(/[^\x20-\x7E]/g, '?');
}

/** Track firmware update notification attempts per device+version to prevent OTA storms */
interface UpdateNotifyAttempt {
  lastNotifyTime: number;
  attemptCount: number;
}

const MAX_UPDATE_NOTIFY_ATTEMPTS = 3;
const UPDATE_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

export class ASyncTCPService implements TCPCallback {
  private clientMap = new Map<string, number>();
  private clientIndexList = new Map<number, TCPClient>();
  private clientResponse = new Map<string, string[]>();
  private clientIndex = 0;
  private server: net.Server | null = null;

  private clientLogins = new Map<string, APIClient>();
  private addressToClient = new Map<string, APIClient>();
  private tokenToAddress = new Map<string, string>();
  private telemetry = TelemetryService.getInstance();
  private ipPinMode: IpPinMode;

  /** In-memory tracking of update notification attempts (device+version -> attempt info) */
  private updateNotifyAttempts = new Map<string, UpdateNotifyAttempt>();

  constructor() {
    this.ipPinMode = loadConfig().ipPinMode;
    this.startServer();
    setInterval(() => this.sendKeepAlive(), KEEPALIVE_INTERVAL_MS);
  }

  private startServer(): void {
    const config = loadConfig();
    this.server = net.createServer((socket) => {
      socket.on('error', () => undefined);
      if (this.clientIndexList.size >= MAX_TCP_CLIENTS) {
        console.log('Reject connection, at cap', MAX_TCP_CLIENTS);
        socket.destroy();
        return;
      }
      const index = this.clientIndex++;
      const peerIp = normalizeRemoteIp(socket.remoteAddress);
      console.log('New client connected: #' + index, peerIp);
      const client = new TCPClient(socket, this, index);
      this.clientIndexList.set(index, client);
      void this.beginClient(socket, client, index, peerIp);
    });
    this.server.on('error', (err) => {
      console.error('TCP server error:', err instanceof Error ? err.message : err);
    });

    this.server.listen(config.tcpPort, () => {
      console.log('TCP server listening on port', config.tcpPort);
    });
  }

  /**
   * Optionally accept a PROXY protocol header from trusted peers, then start
   * the normal TCPClient data path. Direct connections (no header) are unchanged.
   */
  private async beginClient(
    socket: net.Socket,
    client: TCPClient,
    index: number,
    peerIp: string
  ): Promise<void> {
    const config = loadConfig();
    const trusted = isTrustedProxyPeer(peerIp, config.proxyProtocolTrusted);

    if (!trusted) {
      // Untrusted peer: never rewrite IP from PROXY. Optionally reject if header present.
      if (config.proxyProtocolUntrusted === 'reject') {
        try {
          const result = await resolveProxyProtocol(socket, { timeoutMs: 500 });
          if (result.present) {
            console.log('Reject PROXY header from untrusted peer #' + index, peerIp);
            this.clientIndexList.delete(index);
            socket.destroy();
            return;
          }
          client.start(result.leftover.length ? result.leftover : undefined);
          socket.resume();
          return;
        } catch (err) {
          // Malformed PROXY from untrusted → reject
          console.log(
            'Reject bad PROXY from untrusted peer #' + index,
            peerIp,
            err instanceof Error ? err.message : err
          );
          this.clientIndexList.delete(index);
          socket.destroy();
          return;
        }
      }
      client.start();
      return;
    }

    try {
      const result = await resolveProxyProtocol(socket, { timeoutMs: 500 });
      if (result.present && result.clientIp) {
        client.setRemoteIp(result.clientIp);
        console.log(
          'PROXY protocol #' + index,
          'peer',
          peerIp,
          '-> client',
          result.clientIp,
          result.version ? `v${result.version}` : ''
        );
      } else if (result.present) {
        console.log('PROXY protocol #' + index, 'present but no source IP (UNKNOWN/LOCAL)');
      }
      client.start(result.leftover.length ? result.leftover : undefined);
      socket.resume();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log('PROXY protocol error #' + index, msg);
      this.clientIndexList.delete(index);
      if (err instanceof ProxyProtocolError) {
        socket.destroy();
        return;
      }
      socket.destroy();
    }
  }

  private sendKeepAlive(): void {
    const removalAddrs: string[] = [];

    for (const [index, client] of [...this.clientIndexList]) {
      try {
      if (!client.isAlive() || client.hasTimedOut()) {
        client.terminate();
        continue;
      }
      // Probes never log in — drop them quickly. Do not use empty address as a
      // reason to kill a device that already authenticated.
      if (!client.getAddress()) {
        if (Date.now() - client.getLastConnection() > UNAUTH_GRACE_MS) {
          client.terminate();
        }
        continue;
      }
      client.sendKeepAlive();
      } catch (err) {
        console.error('Keepalive #' + index, err instanceof Error ? err.message : err);
      }
    }

    for (const [address, idx] of this.clientMap) {
      if (!this.clientIndexList.has(idx)) removalAddrs.push(address);
    }
    for (const addr of removalAddrs) {
      console.log('REMOVE orphaned client:', addr);
      this.clientMap.delete(addr);
    }
  }

  private liveIndexForAddress(addrLower: string): number | undefined {
    const idx = this.clientMap.get(addrLower);
    if (idx === undefined) return undefined;
    const existing = this.clientIndexList.get(idx);
    if (!existing?.isAlive() || existing.getAddress().toLowerCase() !== addrLower) return undefined;
    return idx;
  }

  /** Half-open leftover after ESP.restart() — no RX for 20s. */
  private isQuiet(index: number): boolean {
    const existing = this.clientIndexList.get(index);
    if (!existing) return true;
    return Date.now() - existing.getLastConnection() > 20_000;
  }

  /**
   * After signed login (or refresh), pin this TCP session to the resolved IP.
   * Loopback/unknown IPs are not pinned so legacy tunnels keep working.
   * A fresh full login on a new connection always re-pins (no cross-connection lockout).
   */
  private pinSessionIp(client: TCPClient): void {
    const decision = resolvePinOnLogin(client.getRemoteIp());
    if ('skip' in decision) {
      client.setPinnedIp(undefined);
      console.log(
        'Skip IP pin (loopback/unknown)',
        client.formatIpLog(),
        decision.currentIp || '(empty)'
      );
      return;
    }
    client.setPinnedIp(decision.pin);
    console.log('Session IP pinned', client.formatIpLog(), 'pin=' + decision.pin);
  }

  /**
   * Check session IP pin for authenticated traffic / re-auth.
   * Returns false when the message must be dropped (enforce mode violation).
   */
  private checkSessionIpPin(
    client: TCPClient,
    index: number,
    opcodeOrMethod: string
  ): boolean {
    const decision = evaluateSessionIpPin({
      mode: this.ipPinMode,
      pinnedIp: client.getPinnedIp(),
      currentIp: client.getRemoteIp(),
    });

    if (decision.action !== 'violation') {
      return true;
    }

    const addr = client.getAddress()?.toLowerCase() || 'unknown';
    const project = client.getFirmwareProject();
    console.log(
      'IP pin violation',
      client.formatIpLog(),
      'device',
      addr,
      'pinned',
      decision.pinnedIp,
      'offending',
      decision.currentIp,
      opcodeOrMethod,
      'mode=' + decision.mode
    );
    this.telemetry.recordIpPinViolation({
      address: addr,
      project,
      pinnedIp: decision.pinnedIp,
      offendingIp: decision.currentIp,
      opcodeOrMethod,
      connectionId: index,
      mode: decision.mode,
    });

    if (decision.reject) {
      client.terminate();
      return false;
    }
    return true;
  }

  receivedMessage(index: number, bytes: Buffer): void {
    try {
      this.parseClientMessage(index, bytes);
    } catch (err) {
      console.error('Parse error #' + index, err instanceof Error ? err.message : err);
    }
  }

  /** Drop a socket only if it has not completed a signed login. */
  private dropUnauth(client: TCPClient | undefined, index: number, reason: string): void {
    if (!client) return;
    if (client.getAddress()) {
      console.log('Ignore', reason, 'on authenticated #' + index);
      return;
    }
    console.log('Drop #' + index, client.getRemoteIp() || '?', reason);
    
    const disconnectReason = (reason === 'bad signature' || reason === 'recover throw') 
      ? 'signature_failure' 
      : 'auth_failure';
    
    client.terminate();
  }

  private parseClientMessage(index: number, bytes: Buffer): void {
    const client = this.clientIndexList.get(index);
    if (!client || !bytes.length) return;

    const opcode = bytes[0];
    const message = bytes.subarray(1);
    const authed = Boolean(client.getAddress());

    // Authenticated sessions: every inbound opcode must match the pinned IP
    // (re-challenge, refresh auth, responses, keepalive, diagnostics, …).
    if (authed) {
      const label = '0x' + opcode.toString(16).padStart(2, '0');
      if (!this.checkSessionIpPin(client, index, label)) return;
    }

    switch (opcode) {
      case 0x01: {
        if (message.length < 20) {
          this.dropUnauth(client, index, 'short login');
          return;
        }
        const address = '0x' + message.subarray(0, 20).toString('hex');
        const addrLower = address.toLowerCase();
        const ip = client.getRemoteIp();

        // Same socket already signed in: ESP handshake retry. Send 0x02 again
        // so it does not sit in handshake for 60s and then ESP.restart().
        if (authed) {
          console.log('Re-challenge authenticated', client.formatIpLog());
          client.setChallenge(createChallenge());
          client.sendChallenge();
          return;
        }

        const liveIdx = this.liveIndexForAddress(addrLower);
        if (liveIdx !== undefined && liveIdx !== index && !this.isQuiet(liveIdx)) {
          console.log('Reject login #' + index, address, '-- #' + liveIdx, 'still live');
          client.terminate();
          return;
        }
        // Fresh login on a new connection: always allowed; pin is set after signed auth.
        console.log('RCV: Login:', address, 'from', ip, client.formatIpLog());
        client.setChallenge(createChallenge());
        client.sendChallenge();
        return;
      }
      case 0x02:
        return;
      case 0x03:
      case OPCODE_AUTH_LEGACY:
      case OPCODE_AUTH_WITH_VERSION: {
        let firmwareVersion: string | undefined = undefined;
        let preimage: Buffer;
        
        if (opcode === OPCODE_AUTH_WITH_VERSION) {
          if (message.length < 86) {
            this.dropUnauth(client, index, 'short auth with version');
            return;
          }
          const versionLen = message[85];
          if (versionLen > MAX_FIRMWARE_VERSION_LEN) {
            this.dropUnauth(client, index, 'version length exceeds max');
            return;
          }
          if (message.length < 86 + versionLen) {
            this.dropUnauth(client, index, 'truncated version');
            return;
          }
          const versionBytes = message.subarray(86, 86 + versionLen);
          const rawVersion = versionBytes.toString('utf-8');
          firmwareVersion = sanitizeFirmwareVersion(rawVersion);
          
          const challenge = client.getChallenge();
          if (!challenge.length) {
            this.dropUnauth(client, index, 'auth before challenge');
            return;
          }
          
          preimage = Buffer.concat([challenge, Buffer.from([versionLen]), versionBytes]);
        } else {
          if (message.length < 85) {
            this.dropUnauth(client, index, 'short auth');
            return;
          }
          const challenge = client.getChallenge();
          if (!challenge.length) {
            this.dropUnauth(client, index, 'auth before challenge');
            return;
          }
          preimage = challenge;
        }
        
        const addrBytes = message.subarray(0, 20);
        const sig = message.subarray(20, 85);
        
        let recoveredAddr = '';
        try {
          const msgHash = opcode === 0x03 ? getEthereumMessageHash(preimage) : ethers.keccak256(preimage);
          recoveredAddr = recoverAddressFromSignature(msgHash, new Uint8Array(sig));
        } catch (err) {
          console.error('Recover failed #' + index, err instanceof Error ? err.message : err);
          this.dropUnauth(client, index, 'recover throw');
          return;
        }
        const addrHex = '0x' + addrBytes.toString('hex');
        if (recoveredAddr && addrHex.toLowerCase() === recoveredAddr.toLowerCase()) {
          const ip = client.getRemoteIp();
          const addrLower = recoveredAddr.toLowerCase();
          const liveIdx = this.liveIndexForAddress(addrLower);
          if (liveIdx !== undefined && liveIdx !== index && !this.isQuiet(liveIdx)) {
            console.log('Reject signed login #' + index, '-- #' + liveIdx, 'still live');
            client.terminate();
            return;
          }
          if (authed && client.getAddress().toLowerCase() === addrLower) {
            // Refresh / re-auth on an existing session (pin already checked above).
            console.log(
              'Refresh auth',
              client.formatIpLog(),
              addrLower,
              firmwareVersion ? `fw=${firmwareVersion}` : ''
            );
            this.pinSessionIp(client);
            return;
          }
          // Fresh full login (or auth for a different address on this socket): re-pin.
          // Cross-connection ISP changes are allowed — only the live-session check above blocks.
          client.setAddress(recoveredAddr);
          
          if (firmwareVersion) {
            const parsed = FirmwareVersionParser.parse(firmwareVersion);
            if (parsed) {
              client.setFirmwareInfo(firmwareVersion, parsed.project, parsed.semver);
              console.log('Parsed firmware:', parsed.project, parsed.semver, parsed.hash || '(no hash)');
            } else {
              client.setFirmwareInfo(firmwareVersion);
              console.log('Firmware version (legacy format):', firmwareVersion);
            }
          }
          
          this.addToClientMap(recoveredAddr, index);
          this.pinSessionIp(client);
          console.log(
            'Authenticated',
            client.formatIpLog(),
            addrLower,
            firmwareVersion ? `fw=${firmwareVersion}` : '(legacy)'
          );
          this.telemetry.recordDeviceConnection(addrLower, 'TCP', ip, firmwareVersion);
          // Deliver queued revoke notices / detect setup-firmware reappearance after auth.
          // Then check for available firmware updates (after revoke check).
          // Defer so the auth response path is not blocked by the outbound API call.
          setImmediate(() => {
            const revokeHandled = this.handlePostLoginRevoke(addrLower, firmwareVersion);
            // Only check for updates if no revoke was queued/delivered
            if (!revokeHandled) {
              void this.checkAndNotifyFirmwareUpdate(addrLower, firmwareVersion);
            }
          });
          return;
        }
        this.dropUnauth(client, index, 'bad signature');
        return;
      }
      case OPCODE_WIFI_DIAGNOSTICS: {
        if (!authed) {
          console.log('Ignore diagnostics from unauthenticated #' + index);
          return;
        }
        if (message.length < 13) {
          console.log('Short diagnostics packet #' + index, message.length, 'bytes');
          return;
        }
        
        const resetReason = message[0];
        const bootCount = message.readUInt16BE(1);
        const wifiAttempts = message.readUInt16BE(3);
        const connectTimeMs = message.readUInt32BE(5);
        const networkIndex = message[9];
        const lastFailureStage = message[10];
        const lastDisconnectReason = message[11];
        
        const addr = client.getAddress().toLowerCase();
        console.log(
          'WiFi diagnostics #' + index, addr,
          'reset:', decodeEspResetReason(resetReason),
          'boots:', bootCount,
          'wifiAttempts:', wifiAttempts,
          'connectMs:', connectTimeMs,
          'failStage:', decodeFailureStage(lastFailureStage),
          'wifiDisc:', decodeWifiDisconnectReason(lastDisconnectReason)
        );
        
        this.telemetry.recordDeviceDiagnostics(addr, {
          resetReason: decodeEspResetReason(resetReason),
          bootCount,
          wifiAttempts,
          connectTimeMs,
          networkIndex,
          lastFailureStage: decodeFailureStage(lastFailureStage),
          wifiDisconnectReason: decodeWifiDisconnectReason(lastDisconnectReason),
        }, client.getRemoteIp());
        return;
      }
      case 0x04:
        return;
      case 0x05:
      case 0x08: {
        if (!authed) {
          this.dropUnauth(client, index, 'response before login');
          return;
        }
        const addrLower = client.getAddress().toLowerCase();
        const responseText = message.subarray(0, 1024).toString('utf-8');
        let list = this.clientResponse.get(addrLower);
        if (!list) {
          list = [];
          this.clientResponse.set(addrLower, list);
        }
        if (list.length > 8) list.shift();
        list.push(responseText);
        this.maybeAcknowledgeRevoke(addrLower, responseText);
        return;
      }
      case 0x06:
        return;
      default:
        this.dropUnauth(client, index, 'unknown opcode 0x' + opcode.toString(16));
    }
  }

  private addToClientMap(recoveredAddr: string, index: number): void {
    const addrLower = recoveredAddr.toLowerCase();
    const incoming = this.clientIndexList.get(index);
    const incomingIp = incoming?.getRemoteIp() || '';
    for (const [clIndex, client] of this.clientIndexList) {
      if (clIndex === index) continue;
      if (client.getAddress().toLowerCase() !== addrLower) continue;
      if (client.isAlive() && !this.isQuiet(clIndex)) {
        console.log('Keep live #' + clIndex, 'do not replace with #' + index);
        return;
      }
      console.log('Replace quiet/dead #' + clIndex, 'with #' + index, incomingIp);
      client.terminate();
    }
    const newClient = this.clientIndexList.get(index);
    console.log(
      'Link Address:',
      recoveredAddr,
      '->',
      addrLower,
      'Client Index:',
      index,
      'IP:',
      newClient?.getRemoteIp() || '?'
    );
    this.clientMap.set(addrLower, index);
  }

  disconnect(index: number, reason: 'client_close' | 'socket_error' | 'terminated'): void {
    const client = this.clientIndexList.get(index);
    if (client) {
      console.log('Disconnect: #' + index, 'reason:', reason);
      const addr = client.getAddress()?.toLowerCase();
      if (addr) {
        this.telemetry.recordDeviceDisconnect(addr, reason, client.getRemoteIp());
        try {
          FirmwareService.getInstance().markRevokeDisconnectedAfterDelivery(addr);
        } catch {
          // Firmware DB may not be initialized in some test setups
        }
      }
      this.clientIndexList.delete(index);
      if (addr && this.clientMap.get(addr) === index) {
        this.clientMap.delete(addr);
        console.log('Unlink Address:', addr, 'Client Index:', index, '(session IP pin cleared)');
      }
    }
  }

  async getResponse(address: string, method: string, argMap: MultiValueMap, _origin: string): Promise<string> {
    const addrLower = address.toLowerCase();
    if (!this.clientMap.has(addrLower) && !this.addressToClient.has(addrLower)) {
      const knownAddrs = [...this.clientMap.keys()];
      console.log('No device found for', addrLower, '| Known TCP clients:', knownAddrs.length, knownAddrs);
      return 'No device found';
    }

    const idx = this.clientMap.get(addrLower);
    if (idx === undefined) {
      console.log('Address in map but idx undefined (race?) for', addrLower);
      return 'No device found';
    }

    const client = this.clientIndexList.get(idx);
    if (!client) {
      console.log('Client #' + idx + ' not in clientIndexList (disconnected?)');
      return 'No device found';
    }

    const responseList = this.clientResponse.get(addrLower);
    if (responseList) responseList.length = 0;

    console.log('Sending to TCP client #' + idx + ':', method);
    client.sendMessage(method, argMap);

    const timeout = 30000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 100));
      const list = this.clientResponse.get(addrLower);
      if (list?.length) {
        return list[0];
      }
    }
    return 'Timed out';
  }

  async getDeviceAddress(_ipAddress: string): Promise<string> {
    const sb: string[] = ['Devices found on IP address: ', _ipAddress];
    let foundAddr = false;
    for (const address of this.clientMap.keys()) {
      foundAddr = true;
      sb.push('</br>', address);
    }
    if (!foundAddr) sb.push('</br>No devices');
    return sb.join('');
  }

  getConnectedDevices(): Array<{ address: string; project?: string; semver?: string; firmwareVersion?: string }> {
    const devices: Array<{ address: string; project?: string; semver?: string; firmwareVersion?: string }> = [];
    
    for (const [address, index] of this.clientMap) {
      const client = this.clientIndexList.get(index);
      if (!client || !client.isAlive()) continue;
      
      devices.push({
        address,
        project: client.getFirmwareProject(),
        semver: client.getFirmwareSemver(),
        firmwareVersion: client.getFirmwareVersion(),
      });
    }
    
    return devices;
  }

  async sendApiCallToDevice(address: string, method: string, argMap: MultiValueMap): Promise<void> {
    const addrLower = address.toLowerCase();
    const idx = this.clientMap.get(addrLower);
    if (idx === undefined) return;

    const client = this.clientIndexList.get(idx);
    if (!client || !client.isAlive()) return;

    client.sendMessage(method, argMap);
  }

  /**
   * Returns true if the device is currently connected and accepted the write.
   * Unlike sendApiCallToDevice, this reports whether a live client was found.
   */
  trySendApiCallToDevice(address: string, method: string, argMap: MultiValueMap): boolean {
    const addrLower = address.toLowerCase();
    const idx = this.clientMap.get(addrLower);
    if (idx === undefined) return false;

    const client = this.clientIndexList.get(idx);
    if (!client || !client.isAlive()) return false;

    client.sendMessage(method, argMap);
    return true;
  }

  /** Live TCP peer IP for a connected device (after PROXY rewrite when present). */
  getDeviceIp(address: string): string | undefined {
    const idx = this.liveIndexForAddress(address.toLowerCase());
    if (idx === undefined) return undefined;
    const ip = this.clientIndexList.get(idx)?.getRemoteIp();
    return ip || undefined;
  }

  /**
   * Attempt immediate delivery of a pending revoke notice to a connected device.
   * Returns true if the notice was written to the TCP socket.
   */
  deliverPendingRevoke(deviceAddress: string): boolean {
    let firmware: FirmwareService;
    try {
      firmware = FirmwareService.getInstance();
    } catch {
      return false;
    }

    const pending = firmware.getPendingRevoke(deviceAddress);
    if (!pending) return false;

    const args = firmware.buildRevokeNoticeArgs(pending);
    const sent = this.trySendApiCallToDevice(pending.device, 'updateReady', args);
    if (!sent) return false;

    firmware.markRevokeDelivered(pending.id);
    this.telemetry.recordFirmwareRevoke(
      pending.device,
      pending.project,
      'delivered',
      pending.setupVersion,
      undefined,
      this.getDeviceIp(pending.device)
    );
    console.log(
      'Delivered revoke notice to',
      pending.device,
      'project',
      pending.project,
      'setup',
      pending.setupVersion
    );
    return true;
  }

  /**
   * Device API response after updateReady(purpose=revoke). App firmware should
   * reply with "revoking" before setting stay_portal and OTA-installing setup.
   */
  private maybeAcknowledgeRevoke(deviceAddress: string, responseText: string): void {
    const trimmed = responseText.trim().toLowerCase();
    if (!trimmed.startsWith('revoking')) return;

    let firmware: FirmwareService;
    try {
      firmware = FirmwareService.getInstance();
    } catch {
      return;
    }

    const active = firmware.getActiveRevoke(deviceAddress);
    if (!active) return;
    if (active.status !== 'pending' && active.status !== 'delivered') return;

    const updated = firmware.markRevokeAcknowledged(active.id);
    if (!updated || updated.status !== 'acknowledged') return;

    this.telemetry.recordFirmwareRevoke(
      active.device,
      active.project,
      'acknowledged',
      active.setupVersion,
      undefined,
      this.getDeviceIp(active.device)
    );
    console.log('Revoke acknowledged by device', active.device, 'project', active.project);
  }

  /**
   * Check if a newly-connected device has an available firmware update.
   * Only notifies if:
   * - Device is on an older version than current release
   * - Current release has autoNotify enabled
   * - Device hasn't exceeded notification attempt limit
   * - Cooldown period has passed since last attempt
   */
  private async checkAndNotifyFirmwareUpdate(deviceAddress: string, firmwareVersion?: string): Promise<void> {
    if (!firmwareVersion) return;

    let firmware: FirmwareService;
    try {
      firmware = FirmwareService.getInstance();
    } catch {
      return;
    }

    const parsed = FirmwareVersionParser.parse(firmwareVersion);
    if (!parsed) {
      return;
    }

    // Don't notify devices on setup firmware
    if (parsed.project.endsWith('-setup')) {
      return;
    }

    const latest = firmware.getLatestFirmware(parsed.project);
    if (!latest) {
      return;
    }

    // Only notify if the latest release has autoNotify enabled
    if (!latest.autoNotify) {
      return;
    }

    const isOlder = FirmwareVersionParser.isOlder(parsed.semver, latest.version);
    if (isOlder !== true) {
      return;
    }

    // Check notification attempt limits (device + target version)
    const attemptKey = `${deviceAddress.toLowerCase()}:${latest.version}`;
    const now = Date.now();
    const attempt = this.updateNotifyAttempts.get(attemptKey);

    if (attempt) {
      // Check if max attempts reached
      if (attempt.attemptCount >= MAX_UPDATE_NOTIFY_ATTEMPTS) {
        console.log(
          `[Firmware] Update notify limit reached for ${deviceAddress}: ${parsed.semver} -> ${latest.version} (${attempt.attemptCount} attempts)`
        );
        return;
      }

      // Check cooldown period
      const timeSinceLastNotify = now - attempt.lastNotifyTime;
      if (timeSinceLastNotify < UPDATE_NOTIFY_COOLDOWN_MS) {
        const remainingMs = UPDATE_NOTIFY_COOLDOWN_MS - timeSinceLastNotify;
        const remainingMin = Math.ceil(remainingMs / 60000);
        console.log(
          `[Firmware] Update notify cooldown for ${deviceAddress}: ${parsed.semver} -> ${latest.version} (${remainingMin}min remaining)`
        );
        return;
      }
    }

    // Send notification
    try {
      await this.sendApiCallToDevice(deviceAddress, 'updateReady', {});
      
      // Track this attempt
      this.updateNotifyAttempts.set(attemptKey, {
        lastNotifyTime: now,
        attemptCount: (attempt?.attemptCount || 0) + 1,
      });

      this.telemetry.recordFirmwareNotify(deviceAddress, parsed.project, latest.version);
      console.log(
        `[Firmware] Notified ${deviceAddress} on login: ${parsed.semver} -> ${latest.version} (attempt ${(attempt?.attemptCount || 0) + 1}/${MAX_UPDATE_NOTIFY_ATTEMPTS})`
      );
    } catch (err) {
      console.error(`[Firmware] Failed to notify ${deviceAddress} on login:`, err);
    }
  }

  /**
   * Handle post-login revoke check.
   * Returns true if a revoke was queued or delivered (indicating update check should be skipped).
   */
  private handlePostLoginRevoke(deviceAddress: string, firmwareVersion?: string): boolean {
    let firmware: FirmwareService;
    try {
      firmware = FirmwareService.getInstance();
    } catch {
      return false;
    }

    const device = normalizeDeviceAddress(deviceAddress);
    const active = firmware.getActiveRevoke(device);
    if (!active) return false;

    const parsed = firmwareVersion ? FirmwareVersionParser.parse(firmwareVersion) : null;

    // Setup firmware stays in captive portal (NVS stay_portal) and typically does
    // NOT TCP-login. Observable completion is the *app* reappearing after the
    // device disconnected post-delivery/ack (OTA → portal → Done → app OTA).
    const appReappeared =
      !!parsed && parsed.project.toLowerCase() === active.project.toLowerCase();
    const revokeSettled =
      active.status === 'acknowledged' ||
      (active.status === 'delivered' && active.disconnectedAfterDelivery);
    if (appReappeared && revokeSettled) {
      firmware.markRevokeCompleted(active.id);
      this.telemetry.recordFirmwareRevoke(
        device,
        active.project,
        'completed',
        active.setupVersion,
        firmwareVersion,
        this.getDeviceIp(device)
      );
      console.log(
        'Revoke completed — app firmware reappeared for',
        device,
        firmwareVersion || '(no version)'
      );
      return true; // Revoke was completed
    }

    // Still on app firmware with a pending revoke: deliver now.
    if (active.status === 'pending') {
      this.deliverPendingRevoke(device);
      return true; // Revoke was queued/delivered
    }

    // Revoke is active (delivered or acknowledged), don't notify for update
    return true;
  }

  getLoginChallenge(remoteAddr: string): string {
    const challenge = createChallenge();
    const thisClient = new APIClient(challenge, remoteAddr);
    this.clientLogins.set(thisClient.getChallenge(), thisClient);
    return thisClient.getChallenge();
  }

  handleDeviceConnection(prefix: string, method: string, ipAddr: string): string {
    try {
      return this.parseBridgeMessage(prefix, method, ipAddr);
    } catch (err) {
      console.error('Bridge parse', err instanceof Error ? err.message : err);
      return '';
    }
  }

  private parseBridgeMessage(prefix: string, method: string, ipAddr: string): string {
    const hex = (method.startsWith('0x') ? method.slice(2) : method).replace(/[^0-9a-fA-F]/g, '');
    if (!hex || hex.length % 2 !== 0 || !HEX_RE.test(hex)) return '';
    let response: Buffer;
    try {
      response = Buffer.from(hex, 'hex');
    } catch {
      return '';
    }
    if (response.length < 1) return '';
    const opcode = response[0];
    const message = response.subarray(1);

    switch (opcode) {
      case 0x01: {
        const thisClient = new APIClient(createChallenge(), ipAddr);
        this.clientLogins.set(thisClient.getChallenge(), thisClient);
        console.log('RCV: Login:', ipAddr);
        return thisClient.getChallenge();
      }
      case 0x02:
        break;
      case 0x03:
      case 0x07: {
        const thisClient = this.clientLogins.get(prefix);
        if (!thisClient || thisClient.getIpAddress() !== ipAddr) return '';
        if (message.length < 85) return '';

        const challengeBytes = thisClient.challenge;
        const sig = message.subarray(20, 85);
        const msgHash = opcode === 0x03 ? getEthereumMessageHash(challengeBytes) : ethers.keccak256(challengeBytes);
        const recovered = recoverAddressFromSignature(msgHash, new Uint8Array(sig));
        if (!recovered) return '';
        const recoveredAddr = recovered.toLowerCase();

        this.addressToClient.set(recoveredAddr, thisClient);
        this.clientLogins.delete(prefix);
        console.log('ADDR:', recoveredAddr, ':', prefix);

        const sessionToken = '0x' + createChallenge().toString('hex');
        this.tokenToAddress.set(sessionToken, recoveredAddr);
        return sessionToken;
      }
      case 0x04:
        break;
      case 0x08:
      case 0x05: {
        const addr = this.tokenToAddress.get(prefix);
        const thisClient = addr ? this.addressToClient.get(addr) : null;
        if (thisClient) {
          let list = this.clientResponse.get(addr!);
          if (!list) {
            list = [];
            this.clientResponse.set(addr!, list);
          }
          list.push(message.toString('utf-8'));
        }
        break;
      }
      case 0x06:
        break;
    }
    return '';
  }
}
