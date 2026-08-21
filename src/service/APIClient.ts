export class APIClient {
  challenge: Buffer;
  ipAddr: string;

  constructor(challenge: Buffer, ipAddr: string) {
    this.challenge = challenge;
    this.ipAddr = ipAddr;
  }

  getChallenge(): string {
    return '0x' + this.challenge.toString('hex');
  }

  getIpAddress(): string {
    return this.ipAddr;
  }
}
