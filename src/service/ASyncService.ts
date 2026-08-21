import { UDPClient } from './UDPClient';
import { UDPClientInstance } from './UDPClientInstance';
import { MultiValueMap } from '../types';
import { loadConfig } from '../config';

const CONNECTION_CLEANUP_TIME = 5 * 60 * 1000;

export class ASyncService {
  private udpClients: UDPClient[] = [];
  private tokenToClient = new Map<bigint, UDPClientInstance>();
  private addressToClient = new Map<string, UDPClientInstance[]>();
  private IoTAddrToQueryID = new Map<string, number>();

  constructor() {
    const config = loadConfig();
    const udpClient = new UDPClient(this);
    udpClient.init(config.udpPort);
    udpClient.start();
    this.udpClients.push(udpClient);
    console.log('UDP server started:', config.udpPort);
  }

  private getLatestClient(ethAddress: string): UDPClientInstance | null {
    const clients = this.addressToClient.get(ethAddress);
    if (clients?.length) return clients[clients.length - 1];
    return null;
  }

  async getResponse(address: string, method: string, argMap: MultiValueMap, origin: string): Promise<string> {
    let instance = this.getLatestClient(address.toLowerCase());
    if (!instance) return 'No device found';

    let methodId: number;
    const checkId = instance.getMatchingQuery(origin, method);
    if (checkId !== -1) {
      methodId = checkId;
      console.log('Duplicate MethodID:', checkId);
    } else {
      methodId = instance.sendToClient(origin, method, argMap);
    }

    if (methodId === -1) return 'API send error';

    let resendIntervalCounter = 0;
    let resendCount = 30;
    let responseReceived = false;

    while (!responseReceived && resendCount > 0) {
      await new Promise((r) => setTimeout(r, 10));
      instance = this.getLatestClient(address.toLowerCase());
      if (instance) {
        if (++resendIntervalCounter > 50) {
          resendIntervalCounter = 0;
          if (checkId === -1) instance.reSendToClient(methodId);
          resendCount--;
        }
        if (instance.hasResponse(methodId)) responseReceived = true;
      }
    }

    const response = instance?.getResponse(methodId) ?? (resendCount === 0 ? 'Timed out' : '');

    if (resendCount === 0) {
      console.log('Timed out');
    } else {
      console.log('Received:', methodId, response, checkId > -1 ? '(*)' : '');
    }

    return response || 'Timed out';
  }

  async getDeviceAddress(ipAddress: string): Promise<string> {
    const useFilter = this.isLocal(ipAddress);
    const parts = ipAddress.split('.');
    const sb: string[] = ['Devices found on IP address: ', ipAddress];
    let foundAddr = false;

    for (const instances of this.addressToClient.values()) {
      const instance = instances[instances.length - 1];
      const instanceParts = instance.getIPAddress().split('.');
      if (useFilter) instanceParts[3] = '0';
      if (useFilter) parts[3] = '0';
      const instanceAddr = instanceParts.join('.');
      const filterAddr = parts.join('.');
      if (instanceAddr === filterAddr || !useFilter) {
        foundAddr = true;
        sb.push('</br>', instance.getEthAddress());
      }
    }

    if (!foundAddr) sb.push('</br>No devices');
    return sb.join('');
  }

  private isLocal(ipAddress: string): boolean {
    const parts = ipAddress.split('.');
    return parts[0] === '192' && parts[1] === '168';
  }

  checkServices(): void {
    for (const client of this.udpClients) {
      if (!client.isRunning()) {
        console.log('Warning: restarting listener:', client.getPort());
        const config = loadConfig();
        const newClient = new UDPClient(this);
        newClient.init(config.udpPort);
        newClient.start();
        this.udpClients[this.udpClients.indexOf(client)] = newClient;
      }
    }

    const now = Date.now();
    for (const [addr, instances] of this.addressToClient) {
      if (instances?.length) {
        const instance = instances[instances.length - 1];
        if (now > instance.getValidationTime() + CONNECTION_CLEANUP_TIME) {
          console.log('Removing old client:', instance.getEthAddress());
          this.IoTAddrToQueryID.delete(addr);
          this.addressToClient.delete(addr);
          break;
        }
      }
    }

    for (const [sessionToken, instance] of this.tokenToClient) {
      if (now > instance.getValidationTime() + CONNECTION_CLEANUP_TIME) {
        console.log('Removing old token:', sessionToken.toString(16), instance.getEthAddress());
        this.tokenToClient.delete(sessionToken);
        break;
      }
    }
  }

  getClientFromToken(tokenValue: bigint): UDPClientInstance | undefined {
    return this.tokenToClient.get(tokenValue);
  }

  updateClientFromToken(tokenValue: bigint, client: UDPClientInstance): void {
    this.tokenToClient.set(tokenValue, client);
  }

  getClientListFromAddress(recoveredAddr: string): UDPClientInstance[] | undefined {
    return this.addressToClient.get(recoveredAddr);
  }

  initAddrList(recoveredAddr: string): UDPClientInstance[] {
    const addrList: UDPClientInstance[] = [];
    this.addressToClient.set(recoveredAddr, addrList);
    return addrList;
  }

  pruneClientList(recoveredAddr: string): void {
    const addrList = this.getClientListFromAddress(recoveredAddr);
    if (addrList && addrList.length >= 3) {
      const oldClient = addrList[0];
      console.log('Removing client from addr map #' + oldClient.getSessionTokenStr());
      addrList.shift();
      const token = BigInt('0x' + oldClient.getSessionToken().toString('hex'));
      if (this.tokenToClient.has(token)) {
        this.tokenToClient.delete(token);
        console.log('Removing client from token map #' + oldClient.getSessionTokenStr());
      }
    }
  }

  getLatestQueryID(ethAddress: string): number {
    let val = this.IoTAddrToQueryID.get(ethAddress) ?? 0;
    if (++val > 256) val = 0;
    this.IoTAddrToQueryID.set(ethAddress, val);
    return val;
  }
}
