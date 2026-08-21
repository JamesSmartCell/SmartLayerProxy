import * as net from 'net';
import { ethers } from 'ethers';
import { TCPClient, TCPCallback } from './TCPClient';
import { APIClient } from './APIClient';
import { MultiValueMap } from '../types';
import { loadConfig } from '../config';
import { getEthereumMessageHash, recoverAddressFromSignature } from '../crypto/signature';

const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

function createChallenge(): Buffer {
  return Buffer.from(require('crypto').randomBytes(16));
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

  constructor() {
    this.startServer();
    setInterval(() => this.sendKeepAlive(), KEEPALIVE_INTERVAL_MS);
  }

  private startServer(): void {
    const config = loadConfig();
    this.server = net.createServer((socket) => {
      const index = this.clientIndex++;
      console.log('New client connected: #' + index);
      const client = new TCPClient(socket, this, index);
      this.clientIndexList.set(index, client);
      client.start();
    });

    this.server.listen(config.tcpPort, () => {
      console.log('TCP server listening on port', config.tcpPort);
    });
  }

  private sendKeepAlive(): void {
    const removalAddrs: string[] = [];

    for (const [index, client] of [...this.clientIndexList]) {
      if (!client.isAlive() || !client.getAddress() || client.hasTimedOut()) {
        client.terminate();
      } else {
        client.sendKeepAlive();
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

  receivedMessage(index: number, bytes: Buffer): void {
    const client = this.clientIndexList.get(index);
    const opcode = bytes[0];
    const message = bytes.subarray(1);

    switch (opcode) {
      case 0x01: {
        const address = '0x' + message.toString('hex');
        console.log('RCV: Login:', address);
        if (client) {
          client.setChallenge(createChallenge());
          client.sendChallenge();
        }
        break;
      }
      case 0x02:
        break;
      case 0x03:
      case 0x07: {
        if (!client || message.length < 85) break;
        const addrBytes = message.subarray(0, 20);
        const sig = message.subarray(20, 85);
        const challenge = client.getChallenge();
        const msgHash = opcode === 0x03 ? getEthereumMessageHash(challenge) : ethers.keccak256(challenge);
        const recoveredAddr = recoverAddressFromSignature(msgHash, new Uint8Array(sig));
        const addrHex = '0x' + addrBytes.toString('hex');
        if (addrHex.toLowerCase() === recoveredAddr.toLowerCase()) {
          client.setAddress(recoveredAddr);
          this.addToClientMap(recoveredAddr, index);
        } else {
          client.terminate();
        }
        break;
      }
      case 0x04:
        break;
      case 0x08:
      case 0x05: {
        if (client) {
          const addr = client.getAddress();
          if (addr) {
            const addrLower = addr.toLowerCase();
            let list = this.clientResponse.get(addrLower);
            if (!list) {
              list = [];
              this.clientResponse.set(addrLower, list);
            }
            list.push(message.toString('utf-8'));
          }
        }
        break;
      }
      case 0x06:
        break;
    }
  }

  private addToClientMap(recoveredAddr: string, index: number): void {
    const addrLower = recoveredAddr.toLowerCase();
    for (const [clIndex, client] of this.clientIndexList) {
      if (clIndex === index) continue;
      if (client.getAddress().toLowerCase() === addrLower) {
        console.log('Terminating Index:', clIndex, '(', recoveredAddr, ')');
        client.terminate();
      }
    }
    console.log('Link Address:', recoveredAddr, '->', addrLower, 'Client Index:', index);
    this.clientMap.set(addrLower, index);
  }

  disconnect(index: number): void {
    const client = this.clientIndexList.get(index);
    if (client) {
      console.log('Disconnect: #' + index);
      this.clientIndexList.delete(index);
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

  getLoginChallenge(remoteAddr: string): string {
    const challenge = createChallenge();
    const thisClient = new APIClient(challenge, remoteAddr);
    this.clientLogins.set(thisClient.getChallenge(), thisClient);
    return thisClient.getChallenge();
  }

  handleDeviceConnection(prefix: string, method: string, ipAddr: string): string {
    const response = Buffer.from(method.startsWith('0x') ? method.slice(2) : method, 'hex');
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

        const challengeBytes = thisClient.challenge;
        const sig = message.subarray(20, 85);
        const msgHash = opcode === 0x03 ? getEthereumMessageHash(challengeBytes) : ethers.keccak256(challengeBytes);
        const recoveredAddr = '0x' + recoverAddressFromSignature(msgHash, new Uint8Array(sig)).toLowerCase();

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
