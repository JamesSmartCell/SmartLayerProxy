/**
 * Passkey/WebAuthn service for GarageDoorKey wallet
 * Handles registration and authentication challenges
 *
 * Credentials are persisted to disk via passkey-store (survives restarts).
 * Sessions (challenges) remain in-memory with a short TTL.
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { decodeCredentialPublicKey, cose } from '@simplewebauthn/server/helpers';
import { passkeyStore } from './passkey-store';

const RP_ID = process.env.PASSKEY_RP_ID || 'percolate.one';
const RP_NAME = process.env.PASSKEY_RP_NAME || 'GarageDoorKey';
const ORIGIN = process.env.PASSKEY_ORIGIN || 'https://wallet.percolate.one';

// Challenge sessions only — short-lived, OK to keep in memory
const sessionStore = new Map<string, { challenge: string; createdAt: number }>();
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 min

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [k, v] of sessionStore) {
    if (now - v.createdAt > SESSION_TTL_MS) sessionStore.delete(k);
  }
}

/**
 * Extract P256 x||y (64 bytes hex) from COSE public key
 */
function cosePublicKeyToXyHex(publicKey: Uint8Array): string {
  const buf = new Uint8Array(publicKey);
  const decoded = decodeCredentialPublicKey(buf);
  if (!cose.isCOSEPublicKeyEC2(decoded)) {
    throw new Error('Invalid P-256 public key: expected EC2 key, got different key type');
  }
  const x = decoded.get(cose.COSEKEYS.x);
  const y = decoded.get(cose.COSEKEYS.y);
  if (!x || !y || x.length !== 32 || y.length !== 32) {
    throw new Error('Invalid P-256 public key: missing or invalid x/y coordinates');
  }
  return Buffer.from(x).toString('hex') + Buffer.from(y).toString('hex');
}

export async function getRegistrationChallenge(username: string) {
  cleanupExpiredSessions();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: username,
    userDisplayName: username,
    attestationType: 'none',
    authenticatorSelection: {
      // Do NOT force platform-only — allows iCloud Keychain, Google Password
      // Manager, and Microsoft Authenticator (iOS Autofill password provider).
      residentKey: 'preferred',
      requireResidentKey: false,
      userVerification: 'required',
    },
    supportedAlgorithmIDs: [-7], // ES256 P-256 only for Coinbase compatibility
  });

  const sessionId = crypto.randomUUID();
  sessionStore.set(sessionId, { challenge: options.challenge, createdAt: Date.now() });

  return {
    success: true,
    data: {
      sessionId,
      options,
    },
  };
}

export async function verifyRegistration(
  sessionId: string,
  attestationResponse: unknown
): Promise<{ success: boolean; data?: { id: string; publicKey: string; rpId: string }; error?: string }> {
  const session = sessionStore.get(sessionId);
  if (!session) {
    return { success: false, error: 'Invalid or expired session' };
  }
  sessionStore.delete(sessionId);

  try {
    const verification = await verifyRegistrationResponse({
      response: attestationResponse as any,
      expectedChallenge: session.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return { success: false, error: 'Verification failed' };
    }

    const { credential } = verification.registrationInfo;
    const credentialId = credential.id;
    const publicKeyBytes = credential.publicKey;

    passkeyStore.putCredential({
      id: credentialId,
      publicKey: publicKeyBytes,
      counter: 0,
      transports: credential.transports,
    });

    const xyHex = cosePublicKeyToXyHex(publicKeyBytes);
    passkeyStore.upsertRecovery({ credentialId, rpId: RP_ID, xyHex });

    const uncompressed = '04' + xyHex;

    return {
      success: true,
      data: {
        id: credentialId,
        publicKey: '0x' + uncompressed,
        rpId: RP_ID,
      },
    };
  } catch (err) {
    console.error('Registration verify error:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Verification failed',
    };
  }
}

export async function getAuthChallenge(credentialId?: string) {
  cleanupExpiredSessions();

  const allowCredentials = credentialId
    ? [{ id: credentialId, type: 'public-key' as const }]
    : undefined;

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    timeout: 60000,
    userVerification: 'required',
    allowCredentials,
  });

  const sessionId = crypto.randomUUID();
  sessionStore.set(sessionId, { challenge: options.challenge, createdAt: Date.now() });

  return {
    success: true,
    data: {
      sessionId,
      options,
    },
  };
}

export async function verifyAuth(
  sessionId: string,
  assertionResponse: unknown
): Promise<{ success: boolean; data?: { id: string; publicKey: string; rpId: string }; error?: string }> {
  const session = sessionStore.get(sessionId);
  if (!session) {
    return { success: false, error: 'Invalid or expired session' };
  }
  sessionStore.delete(sessionId);

  const resp = assertionResponse as any;
  const credId = resp?.id;
  if (!credId) {
    return { success: false, error: 'Missing credential id' };
  }

  const credential = passkeyStore.resolveCredential(credId);
  if (!credential) {
    return { success: false, error: 'Credential not found' };
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response: assertionResponse as any,
      expectedChallenge: session.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential,
      requireUserVerification: true,
    });

    if (!verification.verified) {
      return { success: false, error: 'Verification failed' };
    }

    const newCounter = verification.authenticationInfo.newCounter;
    passkeyStore.updateCounter(credId, newCounter);

    const recovered = passkeyStore.getRecovery(credId);
    const publicKey = recovered
      ? '0x04' + recovered.xyHex
      : '0x04' + cosePublicKeyToXyHex(new Uint8Array(credential.publicKey));

    return {
      success: true,
      data: {
        id: credId,
        publicKey,
        rpId: RP_ID,
      },
    };
  } catch (err) {
    console.error('Auth verify error:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Verification failed',
    };
  }
}

export function upsertPasskey(credentialId: string, rpId: string, xyHex: string) {
  passkeyStore.upsertRecovery({ credentialId, rpId, xyHex });
}

export function getPasskey(credentialId: string): { credentialId: string; rpId: string; xyHex: string } | null {
  return passkeyStore.getRecovery(credentialId);
}
