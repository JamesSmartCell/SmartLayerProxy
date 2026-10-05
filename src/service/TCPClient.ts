import * as net from 'net';
import { MultiValueMap } from '../types';

export const CONNECTION_CLEANUP_TIME = 8 * 60 * 1000;

export function normalizeRemoteIp(ip: string | undefined | null): string {
  if (!ip) return '';
  return ip.replace(/^::ffff:/i, '').toLowerCase();
}

export interface TCPCallback {
  receivedMessage(index: number, data: Buffer): void;
  disconnect(index: number): void;
}

export class TCPClient {
  private socket: net.Socket;
  private lastConnection: number;
  private running = false;
  private serverCallback: TCPCallback;
  private address = '';
  private remoteIp: string;
  private clientIndex: number;
  private challenge: Buffer = Buffer.alloc(0);
  private isWaitingForResponse = false;

  constructor(socket: net.Socket, callback: TCPCallback, index: number) {
    this.socket = socket;
    this.lastConnection = Date.now();
    this.serverCallback = callback;
    this.clientIndex = index;
    this.remoteIp = normalizeRemoteIp(socket.remoteAddress);
  }

  start(): void {
    this.running = true;
    let buffer = Buffer.alloc(0);

    this.socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 0) {
        const preview = buffer.subarray(0, 4).toString('hex');
        console.log('Receive Command:', preview);
        // Full hex of TLS/HTTP probes fills journald and vacuums older boots
        const dump = buffer.length <= 96 ? buffer.toString('hex') : buffer.subarray(0, 96).toString('hex') + `…(+${buffer.length - 96}b)`;
        console.log('  -->', dump);
        this.isWaitingForResponse = false;
        this.lastConnection = Date.now();
        this.serverCallback.receivedMessage(this.clientIndex, buffer);
        buffer = Buffer.alloc(0);
      }
    });

    this.socket.on('close', () => {
      this.running = false;
      this.serverCallback.disconnect(this.clientIndex);
    });

    this.socket.on('error', () => {
      this.running = false;
      this.serverCallback.disconnect(this.clientIndex);
    });
  }

  getLastConnection(): number {
    return this.lastConnection;
  }

  hasTimedOut(): boolean {
    return Date.now() - this.lastConnection > CONNECTION_CLEANUP_TIME;
  }

  isAlive(): boolean {
    return this.running;
  }

  setChallenge(challenge: Buffer): void {
    this.challenge = challenge;
  }

  setAddress(addr: string): void {
    this.address = addr;
  }

  getAddress(): string {
    return this.address;
  }

  getRemoteIp(): string {
    return this.remoteIp || normalizeRemoteIp(this.socket.remoteAddress);
  }

  getChallenge(): Buffer {
    return this.challenge;
  }

  sendKeepAlive(): void {
    try {
      this.socket.setNoDelay(true);
      const msg = Buffer.alloc(this.challenge.length + 1);
      msg[0] = 0x06;
      this.challenge.copy(msg, 1);
      this.socket.write(msg);
    } catch {
      // ignore
    }
  }

  sendChallenge(): void {
    try {
      this.socket.setNoDelay(true);
      const msg = Buffer.alloc(this.challenge.length + 1);
      msg[0] = 0x02;
      this.challenge.copy(msg, 1);
      this.socket.write(msg);
    } catch {
      // ignore
    }
  }

  terminate(): void {
    try {
      this.socket.end();
    } catch {
      // ignore
    }
    this.running = false;
  }

  sendMessage(method: string, argMap: MultiValueMap): void {
    try {
      if (this.isWaitingForResponse) return;
      this.isWaitingForResponse = true;

      const chunks: Buffer[] = [];
      chunks.push(Buffer.from([0x04]));
      writeValue(chunks, method);
      for (const key of Object.keys(argMap)) {
        writeValue(chunks, key);
        const param = argMap[key]?.length ? decodeURIComponent(argMap[key][0]) : '';
        writeValue(chunks, param);
      }
      const msg = Buffer.concat(chunks);
      this.socket.setNoDelay(true);

      // Use cork/uncork so the entire message goes as one TCP segment - some IoT
      // devices (e.g. ESP32 WiFiClient) can miss fragmented packets
      this.socket.cork();
      const flushed = this.socket.write(msg, (err) => {
        if (err) console.error('TCP write error:', err);
      });
      process.nextTick(() => this.socket.uncork());

      if (!flushed) {
        console.warn('TCP write buffered (backpressure) - device may be slow to receive');
      }
      console.log('Create API call:', method, '| TCP TX', msg.length, 'bytes:', msg.toString('hex'));
    } catch (err) {
      console.error('TCP sendMessage error:', err);
    }
  }
}

/**
 * Writes a length-prefixed string matching C++ getArg format:
 * [1 byte length] + [N bytes data]. Device reads: argLen = packet[index++] & 0xFF, then argLen bytes.
 * For "getChallenge" (11 bytes): 0b 67 65 74 43 68 61 6c 6c 65 6e 67 65
 */
function writeValue(chunks: Buffer[], value: string): void {
  const valueBuf = Buffer.from(value, 'utf-8');
  const length = Math.min(valueBuf.length, 255);
  chunks.push(Buffer.from([length]));
  chunks.push(valueBuf.subarray(0, length));
}
