import 'dotenv/config';
import express from 'express';
import { createRouter } from './api/routes';
import { ASyncService } from './service/ASyncService';
import { ASyncTCPService } from './service/ASyncTCPService';
import { loadConfig } from './config';

const config = loadConfig();

const app = express();
const service = new ASyncService();
const tcpService = new ASyncTCPService();

app.use(express.json({ limit: '1mb' }));

// Reject non-API paths first: immediately reset connection (ECONNRESET)
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) {
    if (req.socket?.writable) req.socket.destroy();
    return;
  }
  next();
});

app.use('/api', createRouter(service, tcpService));

app.listen(config.serverPort, () => {
  console.log(`SmartLayerProxy listening on port ${config.serverPort}`);
  console.log(`UDP: ${config.udpPort}, TCP: ${config.tcpPort}`);
});
