# SmartLayerProxy (TypeScript)

Lightweight TypeScript port of the Java SmartLayerProxy. Uses significantly fewer resources than the Spring Boot version.

## Features

- **UDP & TCP** device connections with Ethereum address authentication
- **REST API** compatible with the Java version
- **Express** HTTP server (no Spring Boot overhead)
- **ethers.js** for signature verification

## Quick Start

```bash
cd typescript
npm install
npm run build
npm start
```

For development with auto-reload:

```bash
npm run dev
```


## Configuration

Environment variables (or `application.properties` file):

- **Server Ports:**
  - `server.port` / `SERVER_PORT` - HTTP API port (default: 8081)
  - `udp.port` / `UDP_PORT` - UDP listener port (default: 8083)
  - `tcp.port` / `TCP_PORT` - TCP listener port (default: 8082)

- **Telemetry:**
  - `TELEMETRY_DB_PATH` - SQLite database path (default: `./data/telemetry.db`)
  - `TELEMETRY_RETENTION_DAYS` - Event retention period (default: 30)
  - `TELEMETRY_API_KEY` - API key for telemetry endpoints (REQUIRED for telemetry)
  - `TELEMETRY_FEED_MAX_LIMIT` - Maximum feed limit (default: 5000)
  - `TELEMETRY_ACK_ENABLED` - Enable actual deletion via ack (default: false; when false, ack is forced dry-run)

- **Admin Authentication:**
  - `ADMIN_ADDRESSES` - Comma-separated Ethereum addresses authorized for admin operations
  - `TELEMETRY_ADMIN_ADDRESSES` - Additional addresses authorized for telemetry ack

- **Firmware:**
  - `FIRMWARE_UPLOAD_MAX_SIZE_MB` - Max firmware binary size (default: 10)

- **Cloudflare R2 (camera uploads & firmware storage):**
  - `R2_ACCOUNT_ID` - R2 account ID (REQUIRED for R2)
  - `R2_ACCESS_KEY_ID` - R2 access key (REQUIRED for R2)
  - `R2_SECRET_ACCESS_KEY` - R2 secret key (REQUIRED for R2)
  - `R2_BUCKET_NAME` - R2 bucket name (default: `garage-camera`)
  - `R2_PUBLIC_URL` - Public URL for R2 bucket (e.g., `https://pub-xxx.r2.dev`)
  - `R2_FIRMWARE_BUCKET_NAME` - Optional separate bucket for firmware (defaults to `R2_BUCKET_NAME`)

- **Passkey (GarageDoorKey):**
  - `PASSKEY_RP_ID` - Relying party ID (default: percolate.one)
  - `PASSKEY_RP_NAME` - Display name (default: GarageDoorKey)
  - `PASSKEY_ORIGIN` - Expected origin (default: https://wallet.percolate.one)

- **Proxy Public URL:**
  - `PROXY_PUBLIC_URL` - Public base URL for camera upload callbacks (e.g., `https://proxy.percolate.one`)

See `.env.example` for all available configuration options.

## API Endpoints

### Admin Authentication

Admin-protected operations require a signed challenge. The flow:

1. **GET /api/admin/challenge** - Returns `{nonce, expiresAt}` (nonce valid 60s)
2. Client signs EIP-191 personal_sign message: `<action>:<params>:<nonce>`
   - For ack: `ack:<upToId>:<nonce>`
   - For firmware upload: `firmware:<project>:<version>:<sha256>:<nonce>`
   - For firmware rollback: `current:<project>:<version>:<nonce>`
3. Submit signature with request (nonce is single-use and burned after verification)

### Telemetry Feed & Acknowledgement

**GET /api/telemetry/feed?afterId=<id>&limit=<n>**

Paginated event feed for external processing. Requires Bearer token (`TELEMETRY_API_KEY`).

- `afterId` - Return events with ID > afterId (default: 0)
- `limit` - Max events to return (default: 1000, max: `TELEMETRY_FEED_MAX_LIMIT`)

Response:
```json
{
  "rows": [
    {
      "id": 123,
      "timestamp": 1700000000000,
      "device": "0xabc...",
      "eventType": "connect|disconnect|api_call",
      "protocol": "UDP|TCP",
      "disconnectReason": "timeout|auth_failure|...",
      "apiMethod": "getValue",
      "apiSuccess": true,
      "apiResponseTime": 50,
      "ipAddress": "192.168.1.1",
      "firmwareVersion": "v1.2.3"
    }
  ],
  "maxId": 456,
  "hasMore": true,
  "serverTime": 1700000000000
}
```

**POST /api/telemetry/ack**

Delete acknowledged events (requires Bearer token + admin signature).

Request body:
```json
{
  "upToId": 123,
  "signature": "0x...",
  "message": "ack:123:<nonce>",
  "dryRun": false
}
```

Response (success):
```json
{
  "deleted": 123,
  "remaining": 456,
  "deletedBy": "0xabc..."
}
```

Response (dry-run):
```json
{
  "wouldDelete": 123,
  "dryRun": true,
  "reason": "TELEMETRY_ACK_ENABLED=false"
}
```

When `TELEMETRY_ACK_ENABLED=false`, all ack requests are forced into dry-run mode. After successful deletion, incremental vacuum runs if >1000 rows deleted.

### Firmware Coordinator

Firmware binaries stored in Cloudflare R2 under `firmware/<project>/<version>/firmware.bin`. Metadata tracked in SQLite.

**GET /api/firmware/:project/latest** (public)

Get current firmware version for project.

Response:
```json
{
  "project": "GarageDoor",
  "version": "1.2.3",
  "url": "https://pub-xxx.r2.dev/firmware/GarageDoor/1.2.3/firmware.bin",
  "sha256": "abc123...",
  "size": 1048576
}
```

**GET /api/firmware/:project** (public)

List all firmware versions for project (newest first).

Response:
```json
{
  "project": "GarageDoor",
  "versions": [
    {
      "project": "GarageDoor",
      "version": "1.2.3",
      "url": "...",
      "sha256": "...",
      "size": 1048576,
      "isCurrent": true
    }
  ]
}
```

**POST /api/firmware/:project?version=<v>&signature=<sig>&message=<msg>** (admin)

Upload firmware binary (multipart or raw `.bin` body). Computes SHA256, uploads to R2, records metadata, marks as current.

- Query params: `version`, `signature`, `message` (where `message = firmware:<project>:<version>:<sha256>:<nonce>`)
- Body: Raw binary (application/octet-stream)
- Size limit: `FIRMWARE_UPLOAD_MAX_SIZE_MB`

Response:
```json
{
  "success": true,
  "project": "GarageDoor",
  "version": "1.2.3",
  "sha256": "abc123...",
  "size": 1048576,
  "url": "https://...",
  "uploadedBy": "0xabc..."
}
```

**POST /api/firmware/:project/current** (admin)

Roll back to a previous version (sets `is_current` flag).

Request body:
```json
{
  "version": "1.2.2",
  "signature": "0x...",
  "message": "current:<project>:<version>:<nonce>"
}
```

Response:
```json
{
  "success": true,
  "project": "GarageDoor",
  "version": "1.2.2",
  "setBy": "0xabc..."
}
```

If R2 not configured, firmware endpoints return 503.

### IoT Device Routes
| Endpoint | Description |
|----------|-------------|
| `GET/POST /api/{Address}/{method}` | Forward API call to device |
| `GET/POST /api/async/{Address}/{method}` | Same, async variant |
| `GET/POST /api/getEthAddress` | List devices for client IP |
| `GET/POST /api/bridge/{Address}/{data}` | Device connection (login/session) |
| `GET/POST /api/bridge/login` | Get login challenge |
| `GET/POST /api/smartpass/{attestation}` | Mock attestation response |

### Passkey / WebAuthn (GarageDoorKey wallet)
| Endpoint | Description |
|----------|-------------|
| `GET /api/passkey/registration-challenge` | Get WebAuthn registration options |
| `POST /api/passkey/verify-registration-challenge` | Verify attestation |
| `GET /api/passkey/build-auth-challenge` | Get auth options (discoverable) |
| `GET /api/passkey/build-auth-challenge/:credentialId` | Get auth options for credential |
| `POST /api/passkey/verify-auth-challenge` | Verify assertion |
| `PUT /api/v1/passkeys` | Upsert passkey (recovery sync) |
| `GET /api/v1/passkeys/:credentialId` | Get passkey by id (recovery) |

### Telemetry / Device Metrics

**All telemetry endpoints require Bearer token authentication via `Authorization: Bearer <TELEMETRY_API_KEY>` header.**

| Endpoint | Description |
|----------|-------------|
| `GET /api/telemetry/system?since=<ISO-time>` | System-wide metrics (uptime, total devices, API calls, active devices) |
| `GET /api/telemetry/devices?since=<ISO-time>` | Metrics for all devices |
| `GET /api/telemetry/devices/:address?since=<ISO-time>` | Metrics for a specific device by Ethereum address |
| `GET /api/telemetry/methods?limit=10&since=<ISO-time>` | Top API methods by usage count |
| `GET /api/telemetry/events?since=<ISO-time>&device=<addr>&limit=100&offset=0` | Paginated raw event log (connect/disconnect/API calls) |

**Telemetry Features:**
- **Persistence**: Events stored in SQLite, configurable retention (default 30 days)
- **Connection tracking**: Records device connections with protocol (UDP/TCP/BOTH) and IP address
- **Disconnect tracking**: Tracks disconnect events with reason (timeout, socket_error, auth_failure, signature_failure, client_close, terminated)
- **Session metrics**: Calculates session durations, uptime percentage, reconnect intervals (median & p95)
- **API metrics**: Success/failure rates, response times, method usage statistics
- **Time-windowed queries**: All summary endpoints support `?since=` parameter for time-based filtering
- **Event log**: Paginated raw event access with device filtering
- **Security**: Device addresses and IPs protected by API key authentication

**Event Schema:**
```typescript
{
  id: number;
  timestamp: number;              // Unix timestamp (ms)
  device: string;                 // Ethereum address (lowercase)
  eventType: 'connect' | 'disconnect' | 'api_call';
  protocol?: 'UDP' | 'TCP';
  disconnectReason?: 'timeout' | 'socket_error' | 'auth_failure' | 
                     'signature_failure' | 'client_close' | 'terminated';
  apiMethod?: string;
  apiSuccess?: boolean;
  apiResponseTime?: number;       // milliseconds
  ipAddress?: string;
}
```

**Configuration:**
```bash
# Required: API key for telemetry endpoints (if unset, endpoints return 503)
TELEMETRY_API_KEY=your-secret-key

# Optional: Database location (default: ./data/telemetry.db)
TELEMETRY_DB_PATH=./data/telemetry.db

# Optional: Retention period in days (default: 30)
TELEMETRY_RETENTION_DAYS=30
```

## CLI Tools

### Telemetry Pull & Analyze

**tools/telemetry/pull.ts** - Pages through `/api/telemetry/feed`, writes `data/telemetry-YYYYMMDD.jsonl`, optionally signs and sends ack.

```bash
# Requires .env with PROXY_BASE_URL, TELEMETRY_API_KEY, TELEMETRY_ADMIN_KEY (for --ack)
ts-node tools/telemetry/pull.ts [--ack] [--dry-run]
```

**tools/telemetry/analyse.ts** - Analyzes pulled data for reconnect storms, auth/signature failures, timeouts, slow/failing API methods. Attributes likely cause to proxy vs Web3E bridge vs device firmware. Outputs markdown report.

```bash
ts-node tools/telemetry/analyse.ts [data/telemetry-YYYYMMDD.jsonl]
```

### Firmware Upload

**tools/firmware/upload.ts** - Signs and uploads firmware binary with admin authentication.

```bash
# Requires .env with PROXY_BASE_URL, FIRMWARE_ADMIN_KEY
ts-node tools/firmware/upload.ts <project> <version> <firmware.bin>

# Example
ts-node tools/firmware/upload.ts GarageDoor 1.2.3 firmware.bin
```

Computes SHA256, gets challenge nonce, signs `firmware:<project>:<version>:<sha256>:<nonce>`, uploads to proxy.

## Resource Usage

The TypeScript server typically uses ~50-80MB RAM vs 200-400MB+ for the Java/Spring Boot version.
