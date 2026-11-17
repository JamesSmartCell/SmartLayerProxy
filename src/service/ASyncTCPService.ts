import * as net from 'net';
import { ethers } from 'ethers';
import { CONNECTION_CLEANUP_TIME, normalizeRemoteIp, TCPClient, TCPCallback } from './TCPClient';
import { APIClient } from './APIClient';
import { MultiValueMap } from '../types';
import { loadConfig } from '../config';
import { getEthereumMessageHash, recoverAddressFromSignature } from '../crypto/signature';
import { TelemetryService } from './TelemetryService';

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

export class ASyncTCPService implements TCPCallback {
  private clientMap = new Map<string, number>();
  private clientIndexList = new Map<number, TCPClient>();
  private clientResponse = new Map<string, string[]>();
  private clientIndex = 0;
  private server: net.Server | null = null;

  private clientLogins = new Map<string, APIClient>();
  private addressToClient = new Map<string, APIClient>();
  private tokenToAddress = new Map<string, string>();
  /** Signed-in device → last known socket IP. Survives a drop until inactivity. */
  private devicePins = new Map<string, { ip: string; lastSeen: number }>();
  private telemetry = TelemetryService.getInstance();

  constructor() {
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
      console.log('New client connected: #' + index, normalizeRemoteIp(socket.remoteAddress));
      const client = new TCPClient(socket, this, index);
      this.clientIndexList.set(index, client);
      client.start();
    });
    this.server.on('error', (err) => {
      console.error('TCP server error:', err instanceof Error ? err.message : err);
    });

    this.server.listen(config.tcpPort, () => {
      console.log('TCP server listening on port', config.tcpPort);
    });
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
    this.expirePins();
  }

  private expirePins(): void {
    const now = Date.now();
    for (const [addr, pin] of this.devicePins) {
      if (now - pin.lastSeen <= CONNECTION_CLEANUP_TIME) continue;
      this.devicePins.delete(addr);
      console.log('Expire IP pin:', addr, pin.ip);
    }
  }

  private touchPin(addrLower: string, ip: string): void {
    if (!addrLower || !ip) return;
    this.devicePins.set(addrLower, { ip, lastSeen: Date.now() });
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

  private pinAllowsIp(addrLower: string, ip: string): boolean {
    const pin = this.devicePins.get(addrLower);
    if (!pin) return true;
    if (Date.now() - pin.lastSeen > CONNECTION_CLEANUP_TIME) {
      this.devicePins.delete(addrLower);
      return true;
    }
    return pin.ip === ip;
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
          console.log('Re-challenge authenticated #' + index);
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
        if (!this.pinAllowsIp(addrLower, ip)) {
          const pin = this.devicePins.get(addrLower);
          console.log('Reject login #' + index, address, 'from', ip, '(pinned to', pin?.ip + ')');
          client.terminate();
          return;
        }
        console.log('RCV: Login:', address, 'from', ip);
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
          if (!this.pinAllowsIp(addrLower, ip)) {
            const pin = this.devicePins.get(addrLower);
            console.log('Reject signed login #' + index, recoveredAddr, 'from', ip, '(pinned to', pin?.ip + ')');
            client.terminate();
            return;
          }
          if (authed && client.getAddress().toLowerCase() === addrLower) {
            console.log('Refresh auth #' + index, addrLower, firmwareVersion ? `fw=${firmwareVersion}` : '');
            this.touchPin(addrLower, ip);
            return;
          }
          client.setAddress(recoveredAddr);
          this.addToClientMap(recoveredAddr, index);
          this.touchPin(addrLower, ip);
          console.log('Authenticated #' + index, addrLower, firmwareVersion ? `fw=${firmwareVersion}` : '(legacy)');
          this.telemetry.recordDeviceConnection(addrLower, 'TCP', ip, firmwareVersion);
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
        });
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
        this.touchPin(addrLower, client.getRemoteIp());
        let list = this.clientResponse.get(addrLower);
        if (!list) {
          list = [];
          this.clientResponse.set(addrLower, list);
        }
        if (list.length > 8) list.shift();
        list.push(message.subarray(0, 1024).toString('utf-8'));
        return;
      }
      case 0x06:
        if (authed) this.touchPin(client.getAddress().toLowerCase(), client.getRemoteIp());
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
        this.telemetry.recordDeviceDisconnect(addr, reason);
      }
      this.clientIndexList.delete(index);
      if (addr && this.clientMap.get(addr) === index) {
        this.clientMap.delete(addr);
        console.log('Unlink Address:', addr, 'Client Index:', index, '(IP pin kept until inactivity)');
      }
    }
  }

  async getResponse(address: string, method: string, argMap: MultiValueMap, _origin: string): Promise<string> {
    const startTime = Date.now();
    const addrLower = address.toLowerCase();
    if (!this.clientMap.has(addrLower) && !this.addressToClient.has(addrLower)) {
      const knownAddrs = [...this.clientMap.keys()];
      console.log('No device found for', addrLower, '| Known TCP clients:', knownAddrs.length, knownAddrs);
      this.telemetry.recordApiCall(address, method, false, Date.now() - startTime);
      return 'No device found';
    }

    const idx = this.clientMap.get(addrLower);
    if (idx === undefined) {
      console.log('Address in map but idx undefined (race?) for', addrLower);
      this.telemetry.recordApiCall(address, method, false, Date.now() - startTime);
      return 'No device found';
    }

    const client = this.clientIndexList.get(idx);
    if (!client) {
      console.log('Client #' + idx + ' not in clientIndexList (disconnected?)');
      this.telemetry.recordApiCall(address, method, false, Date.now() - startTime);
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
        this.telemetry.recordApiCall(address, method, true, Date.now() - startTime);
        return list[0];
      }
    }
    this.telemetry.recordApiCall(address, method, false, Date.now() - startTime);
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
