import express, { Router, Request, Response } from 'express';
import { ASyncService } from '../service/ASyncService';
import { ASyncTCPService } from '../service/ASyncTCPService';
import * as passkey from './passkey';
import { uploadToR2, isR2Configured } from '../service/CloudflareR2';
import { randomUUID } from 'crypto';

const CHECK_CONNECTION_INTERVAL_MS = 5 * 60 * 1000;

/** Base URL for camera upload (e.g. https://proxy.percolate.one) */
function getProxyBaseUrl(req: Request): string {
  const env = process.env.PROXY_PUBLIC_URL;
  if (env) return env.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host') || 'localhost:8081';
  return `${proto}://${host}`;
}

function normalizeAddress(addr: string): string {
  return '0x' + addr.replace(/^0x/i, '').toLowerCase();
}

function parseQueryParams(req: Request): Record<string, string[]> {
  const params: Record<string, string[]> = {};
  for (const [key, val] of Object.entries(req.query)) {
    if (typeof val === 'string') params[key] = [val];
    else if (Array.isArray(val)) params[key] = val as string[];
    else params[key] = [];
  }
  // Merge POST body (for checkGarageSigP256 - avoids long URLs on mobile)
  if (req.body && typeof req.body === 'object') {
    for (const [key, val] of Object.entries(req.body)) {
      if (val !== undefined && val !== null) {
        params[key] = [String(val)];
      }
    }
  }
  return params;
}

export function createRouter(service: ASyncService, tcpService: ASyncTCPService): Router {
  const router = Router();

  setInterval(() => service.checkServices(), CHECK_CONNECTION_INTERVAL_MS);

  router.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Max-Age', '10000');
    res.set('Access-Control-Allow-Credentials', 'false');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // ========== Passkey / WebAuthn routes (GarageDoorKey wallet) ==========
  router.get('/passkey/registration-challenge', async (req, res) => {
    try {
      const username = (req.query.username as string) || 'garage-user';
      const result = await passkey.getRegistrationChallenge(username);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  router.post('/passkey/verify-registration-challenge', async (req, res) => {
    try {
      const { sessionId, attestationResponse } = req.body || {};
      if (!sessionId || !attestationResponse) {
        res.status(400).json({ success: false, error: 'Missing sessionId or attestationResponse' });
        return;
      }
      const result = await passkey.verifyRegistration(sessionId, attestationResponse);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  router.get('/passkey/build-auth-challenge', async (req, res) => {
    try {
      const result = await passkey.getAuthChallenge();
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  router.get('/passkey/build-auth-challenge/:credentialId', async (req, res) => {
    try {
      const credentialId = req.params.credentialId;
      const result = await passkey.getAuthChallenge(credentialId);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  router.post('/passkey/verify-auth-challenge', async (req, res) => {
    try {
      const { sessionId, assertionResponse } = req.body || {};
      if (!sessionId || !assertionResponse) {
        res.status(400).json({ success: false, error: 'Missing sessionId or assertionResponse' });
        return;
      }
      const result = await passkey.verifyAuth(sessionId, assertionResponse);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  // Recovery API: passkey storage for cross-device sync
  router.put('/v1/passkeys', async (req, res) => {
    try {
      const { credentialId, rpId, xyHex } = req.body || {};
      if (!credentialId || !rpId || !xyHex) {
        res.status(400).json({ error: 'Missing credentialId, rpId, or xyHex' });
        return;
      }
      passkey.upsertPasskey(credentialId, rpId, xyHex);
      res.status(200).send();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/v1/passkeys/:credentialId', async (req, res) => {
    try {
      const credentialId = req.params.credentialId;
      const record = passkey.getPasskey(credentialId);
      if (!record) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json(record);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ========== Camera upload (called by Remote Camera device) ==========
  router.post('/camera/upload', express.raw({ type: 'image/jpeg', limit: '3mb' }), async (req, res) => {
    try {
      const requestId = (req.query.requestId as string) || '';
      if (!requestId) {
        res.status(400).send('Missing requestId');
        return;
      }
      if (!isR2Configured()) {
        res.status(503).send('R2 not configured');
        return;
      }
      const body = req.body as Buffer | undefined;
      if (!body || body.length === 0) {
        res.status(400).send('No image data');
        return;
      }
      const key = `camera/${requestId}.jpg`;
      const url = await uploadToR2(key, body);
      if (!url) {
        res.status(500).send('Upload failed');
        return;
      }
      res.status(200).send(url);
    } catch (err) {
      console.error('[Camera upload]', err);
      res.status(500).send('Internal error');
    }
  });

  // ========== IoT device routes ==========
  async function handleApiCall(req: Request, res: Response, asyncPath: boolean): Promise<void> {
    const address = normalizeAddress(req.params.Address);
    const method = req.params.method;
    const clientDesignator = req.socket.remoteAddress + '-' + address + method;
    console.log('[TS-Proxy] ADDRESS:', address, 'METHOD:', method);
    const argMap = parseQueryParams(req);

    // takePicture: inject requestId and uploadUrl for the camera
    if (method === 'takePicture') {
      const requestId = randomUUID();
      const base = getProxyBaseUrl(req);
      const uploadUrl = `${base}/api/camera/upload?requestId=${requestId}`;
      argMap['requestId'] = [requestId];
      argMap['uploadUrl'] = [uploadUrl];
    }

    const [responseUDP, responseTCP] = await Promise.all([
      service.getResponse(address, method, argMap, clientDesignator),
      tcpService.getResponse(address, method, argMap, clientDesignator),
    ]);

    const response = responseTCP ?? responseUDP;
    res.status(201).send(response);
  }

  router.all('/:Address/:method', async (req, res) => {
    try {
      await handleApiCall(req, res, false);
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal error');
    }
  });

  router.all('/async/:Address/:method', async (req, res) => {
    try {
      await handleApiCall(req, res, true);
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal error');
    }
  });

  router.all('/getEthAddress', async (req, res) => {
    try {
      const ipAddress = req.socket.remoteAddress ?? '';
      const [udpAddrs, tcpAddrs] = await Promise.all([
        service.getDeviceAddress(ipAddress),
        tcpService.getDeviceAddress(ipAddress),
      ]);
      const returnAddrs = 'UDP: ' + udpAddrs + '\n' + 'TCP: ' + tcpAddrs;
      res.status(201).send(returnAddrs);
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal error');
    }
  });

  router.all('/bridge/:Address/:data', async (req, res) => {
    try {
      const address = normalizeAddress(req.params.Address);
      const method = req.params.data;
      const clientDesignator = req.socket.remoteAddress + '-' + address + method;
      console.log('ADDRESS:', address);
      console.log('METHOD:', method);
      console.log('Designator:', clientDesignator);

      const response = tcpService.handleDeviceConnection(address, method, req.socket.remoteAddress ?? '');
      res.status(201).send(response);
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal error');
    }
  });

  router.all('/bridge/login', async (req, res) => {
    try {
      console.log('Login:', req.socket.remoteAddress);
      const response = tcpService.getLoginChallenge(req.socket.remoteAddress ?? '');
      res.status(201).send(response);
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal error');
    }
  });

  router.all('/smartpass/:attestation', (_req, res) => {
    const response = '{"quests": 4, "points": 450, "level": 1 }';
    res.status(201).send(response);
  });

  // Unrecognised /api/* paths: immediately reset connection
  router.use((req, _res) => {
    if (req.socket?.writable) {
      req.socket.destroy();
    }
  });

  return router;
}
