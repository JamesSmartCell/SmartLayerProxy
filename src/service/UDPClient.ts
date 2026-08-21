import * as dgram from 'dgram';
import { UDPClientInstance } from './UDPClientInstance';
import { ASyncService } from './ASyncService';
import { MultiValueMap } from '../types';
import { recoverAddressFromRawMessage } from '../crypto/signature';

const CLIENT_REQUEST_AUTHENTICATION = 0;
const CLIENT_AUTHENTICATION = 1;
const CLIENT_API_CALL_RETURN = 2;
const CLIENT_PING = 3;

const SERVER_CHALLENGE = 0;
const SIGNATURE_VALIDATE = 1;
const API_CALL = 2;
const PONG = 3;

function log(addr: string, msg: string): void {
  const now = new Date().toLocaleTimeString();
  console.log(`${now}:${addr}: ${msg}`);
}

export class UDPClient {
  private socket: dgram.Socket | null = null;
  private receiveData = Buffer.alloc(1024);
  private running = false;
  private port = 0;
  private service: ASyncService;

  constructor(service: ASyncService) {
    this.service = service;
  }

  init(port: number): void {
    this.port = port;
    this.socket = dgram.createSocket('udp4');
    this.socket.bind(port);
  }

  start(): void {
    if (!this.socket) return;
    this.running = true;
    const rcvSessionToken = Buffer.alloc(8);

    this.socket.on('message', (msg, rinfo) => {
      const address = rinfo.address;
      const port = rinfo.port;
      console.log(`New Connection from ${address}:${port}`);

      let offset = 0;
      const type = msg[offset++];
      msg.copy(rcvSessionToken, 0, offset, offset + 8);
      offset += 8;
      const length = msg[offset++] & 0xff;
      const payload = msg.subarray(offset, offset + length);
      offset += length;

      let thisClient = this.service.getClientFromToken(BigInt('0x' + rcvSessionToken.toString('hex')));

      if (thisClient) {
        if (thisClient.getIPAddress() !== address || thisClient.port !== port) {
          console.log('IP wrong');
          return;
        }
        thisClient.setConnectedClient({ sendToClient: (i, m, a) => this.sendApiToClient(i, m, a), reSendToClient: (i, id) => this.reSendToClient(i, id) });
      }

      switch (type) {
        case CLIENT_REQUEST_AUTHENTICATION:
          if (!thisClient) {
            const tokenValue = BigInt('0x' + rcvSessionToken.toString('hex'));
            if (tokenValue === BigInt(0)) {
              thisClient = new UDPClientInstance(address, port, '');
              const newToken = thisClient.generateNewSessionToken();
              log(address, `Client login: 0x${thisClient.getSessionToken().toString('hex')}`);
              this.sendPacketToClient(thisClient, SERVER_CHALLENGE, thisClient.getSessionToken(), rcvSessionToken);
              this.service.updateClientFromToken(newToken, thisClient);
              log(address, `Send Connection Token: 0x${thisClient.getSessionToken().toString('hex')}`);
            } else {
              log(address, `Unknown client: 0x${rcvSessionToken.toString('hex')}`);
            }
          } else {
            log(address, `Re-Send Connection Token: 0x${thisClient.getSessionToken().toString('hex')}`);
            this.sendPacketToClient(thisClient, SERVER_CHALLENGE, thisClient.getSessionToken(), rcvSessionToken);
          }
          break;

        case CLIENT_AUTHENTICATION:
          log(address, `Receive Verification From: 0x${rcvSessionToken.toString('hex')}`);
          if (thisClient && payload.length === 65) {
            const recoveredAddr = recoverAddressFromRawMessage(thisClient.getSessionToken(), new Uint8Array(payload));
            if (recoveredAddr.length === 0) break;
            if (thisClient.getEthAddress().length === 0) {
              log(address, `Validate client: ${recoveredAddr}`);
              thisClient.setEthAddress(recoveredAddr);
            } else if (recoveredAddr.toLowerCase() === thisClient.getEthAddress().toLowerCase()) {
              log(address, 'Renew client.');
            } else {
              log(address, 'Reject.');
              break;
            }
            if (!thisClient.validated) {
              log(address, `Validated: ${recoveredAddr}`);
              thisClient.setValidationTime();
              log(address, `New Session T: ${thisClient.getSessionTokenStr()}`);
              thisClient.unknownCount = 0;
              thisClient.validated = true;
              this.addToAddresses(recoveredAddr.toLowerCase(), thisClient);
              this.service.updateClientFromToken(BigInt('0x' + rcvSessionToken.toString('hex')), thisClient);
            }
            this.sendPacketToClient(thisClient, SIGNATURE_VALIDATE, thisClient.getSessionToken(), Buffer.alloc(0));
          }
          break;

        case CLIENT_API_CALL_RETURN: {
          const methodId = payload[0];
          const payloadString = payload.subarray(1).toString('utf-8');
          log(address, `RCV Message: 0x${rcvSessionToken.toString('hex')}`);
          if (thisClient) {
            log(address, `Receive: MethodId: ${methodId} : ${payloadString} Client #${thisClient.getSessionTokenStr()}`);
            thisClient.setResponse(methodId, payloadString);
          } else {
            log(address, `Inner Receive, client not valid: ${payloadString}`);
          }
          break;
        }

        case CLIENT_PING:
          if (!thisClient) break;
          thisClient.port = port;
          this.sendPacketToClient(thisClient, PONG, thisClient.getSessionToken(), rcvSessionToken);
          log(address, `PING -> PONG (0x${rcvSessionToken.toString('hex')})`);
          break;
      }
    });

    this.socket.on('error', (err) => {
      console.error('UDP error:', err);
      this.running = false;
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  getPort(): number {
    return this.port;
  }

  private addToAddresses(recoveredAddr: string, thisClient: UDPClientInstance): void {
    let addrList = this.service.getClientListFromAddress(recoveredAddr);
    if (!addrList) {
      addrList = this.service.initAddrList(recoveredAddr);
    } else {
      this.service.pruneClientList(recoveredAddr);
    }
    addrList.push(thisClient);
  }

  private sendPacketToClient(instance: UDPClientInstance, type: number, stuffToSend: Buffer, extraToSend: Buffer): void {
    if (!this.socket) return;
    let totalLength = 2 + stuffToSend.length;
    if (extraToSend.length > 0) totalLength += extraToSend.length;
    const buf = Buffer.alloc(totalLength);
    let off = 0;
    buf[off++] = type;
    buf[off++] = totalLength - 2;
    stuffToSend.copy(buf, off);
    off += stuffToSend.length;
    if (extraToSend.length > 0) extraToSend.copy(buf, off);
    this.socket.send(buf, instance.port, instance.getIPAddress());
  }

  reSendToClient(instance: UDPClientInstance, methodId: number): void {
    if (!this.socket || !instance.getQuery(methodId) || instance.hasResponse(methodId)) return;
    const packetBytes = instance.getQuery(methodId)!;
    this.socket.send(packetBytes, instance.port, instance.getIPAddress());
  }

  sendApiToClient(instance: UDPClientInstance, method: string, argMap: MultiValueMap): number {
    if (!this.socket) return -1;
    const chunks: Buffer[] = [];
    const packetId = this.service.getLatestQueryID(instance.getEthAddress());
    log(instance.getIPAddress(), `Create API call: ${method} #${packetId}`);
    chunks.push(Buffer.from([API_CALL, packetId, 0]));
    let payloadSize = 0;
    payloadSize += writeValue(chunks, method);
    for (const key of Object.keys(argMap)) {
      payloadSize += writeValue(chunks, key);
      const param = argMap[key]?.length ? decodeURIComponent(argMap[key][0]) : '';
      payloadSize += writeValue(chunks, param);
    }
    const packetBytes = Buffer.concat(chunks);
    packetBytes[2] = payloadSize & 0xff;
    instance.setQuery(packetId, packetBytes, payloadSize);
    this.socket.send(packetBytes, instance.port, instance.getIPAddress());
    return packetId;
  }
}

function writeValue(chunks: Buffer[], value: string): number {
  const valueBuf = Buffer.from(value, 'utf-8');
  const length = valueBuf.length;
  const header: number[] = [];
  let len = length;
  while (len >= 0) {
    header.push(len < 0xff ? len : 0xff);
    len -= 0xff;
  }
  chunks.push(Buffer.from([...header, length & 0xff]));
  chunks.push(valueBuf);
  return header.length + 1 + valueBuf.length;
}
