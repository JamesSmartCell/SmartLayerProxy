import { ethers } from 'ethers';

const MESSAGE_PREFIX = '\x19Ethereum Signed Message:\n';

export function getEthereumMessageHash(message: Uint8Array): string {
  const prefix = MESSAGE_PREFIX + message.length;
  const prefixed = Buffer.concat([Buffer.from(prefix, 'utf-8'), Buffer.from(message)]);
  return ethers.keccak256(prefixed);
}

export function recoverAddressFromSignature(signedMessageHash: string, signatureBytes: Uint8Array): string {
  if (signatureBytes.length < 65) return '';
  try {
    const r = '0x' + Buffer.from(signatureBytes.slice(0, 32)).toString('hex');
    const s = '0x' + Buffer.from(signatureBytes.slice(32, 64)).toString('hex');
    let v = signatureBytes[64];
    if (v < 27) v += 27;
    const sig = ethers.Signature.from({ r, s, v });
    return ethers.recoverAddress(signedMessageHash, sig);
  } catch {
    return '';
  }
}

export function recoverAddressFromRawMessage(sessionToken: Uint8Array, signatureBytes: Uint8Array): string {
  if (signatureBytes.length < 65) return '';
  try {
    const digest = ethers.keccak256(sessionToken);
    return recoverAddressFromSignature(digest, signatureBytes);
  } catch {
    return '';
  }
}

function sigFromByteArray(sig: Uint8Array): { r: string; s: string; v: number } | null {
  if (sig.length < 64 || sig.length > 65) return null;
  const v = sig[64] < 27 ? sig[64] + 27 : sig[64];
  const r = '0x' + Buffer.from(sig.slice(0, 32)).toString('hex');
  const s = '0x' + Buffer.from(sig.slice(32, 64)).toString('hex');
  return { r, s, v };
}
