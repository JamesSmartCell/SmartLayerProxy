import { MultiValueMap } from '../types';

interface Query {
  query: string;
  origin: string;
}

export class UDPClientInstance {
  ethAddress = '';
  IPAddress: string;
  port: number;
  validationTime: number;
  sessionToken: Buffer;
  unknownCount = 0;
  validated = false;

  private connectedClient: { sendToClient: (inst: UDPClientInstance, method: string, argMap: MultiValueMap) => number; reSendToClient: (inst: UDPClientInstance, methodId: number) => void } | null = null;
  private responses = new Map<number, string>();
  private currentQueries = new Map<number, Buffer>();
  private currentClientQueries = new Map<number, Query>();

  constructor(ipAddress: string, port: number, _eAddress: string) {
    this.IPAddress = ipAddress;
    this.port = port;
    this.validationTime = Date.now();
    this.sessionToken = Buffer.alloc(0);
  }

  generateNewSessionToken(): bigint {
    const tokenBytes = Buffer.alloc(8);
    require('crypto').randomFillSync(tokenBytes);
    const tokenValue = tokenBytes.readBigUInt64BE(0);
    this.sessionToken = tokenBytes;
    this.validated = false;
    return tokenValue;
  }

  hasResponse(methodId: number): boolean {
    return this.responses.has(methodId);
  }

  getResponse(methodId: number): string | undefined {
    const resp = this.responses.get(methodId);
    this.currentQueries.delete(methodId);
    this.currentClientQueries.delete(methodId);
    return resp;
  }

  setResponse(methodId: number, r: string): void {
    this.responses.set(methodId, r);
    this.currentQueries.delete(methodId);
  }

  setQuery(packetId: number, packet: Buffer, payloadSize: number): void {
    packet[2] = payloadSize & 0xff;
    this.currentQueries.set(packetId, packet);
  }

  getQuery(methodId: number): Buffer | undefined {
    return this.currentQueries.get(methodId);
  }

  getIPAddress(): string {
    return this.IPAddress;
  }

  getEthAddress(): string {
    return this.ethAddress;
  }

  getSessionToken(): Buffer {
    return this.sessionToken;
  }

  setEthAddress(recoveredAddr: string): void {
    this.ethAddress = recoveredAddr;
  }

  getSessionTokenStr(): string {
    return '0x' + this.sessionToken.toString('hex');
  }

  getValidationTime(): number {
    return this.validationTime;
  }

  setValidationTime(): void {
    this.validationTime = Date.now();
  }

  sendToClient(origin: string, method: string, argMap: MultiValueMap): number {
    if (!this.connectedClient) return -1;
    const packetId = this.connectedClient.sendToClient(this, method, argMap);
    if (packetId > -1) {
      this.currentClientQueries.set(packetId, { origin, query: method });
    }
    return packetId;
  }

  setConnectedClient(udpClient: { sendToClient: (inst: UDPClientInstance, method: string, argMap: MultiValueMap) => number; reSendToClient: (inst: UDPClientInstance, methodId: number) => void }): void {
    this.connectedClient = udpClient;
  }

  reSendToClient(methodId: number): void {
    this.connectedClient?.reSendToClient(this, methodId);
  }

  getMatchingQuery(origin: string, query: string): number {
    for (const [methodId, q] of this.currentClientQueries) {
      if (q.origin === origin && q.query === query) return methodId;
    }
    return -1;
  }
}
