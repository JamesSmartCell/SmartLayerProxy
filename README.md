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

Uses `application.properties` in the typescript directory, or falls back to the Java project's config. Same format as Java:

- `server.port` - HTTP API port (default: 8081)
- `udp.port` - UDP listener port (default: 8083)
- `tcp.port` - TCP listener port (default: 8082)

### Passkey (GarageDoorKey)
Environment variables (or in application.properties):

- `PASSKEY_RP_ID` - Relying party ID (default: percolate.one)
- `PASSKEY_RP_NAME` - Display name (default: GarageDoorKey)
- `PASSKEY_ORIGIN` - Expected origin for verification (default: https://wallet.percolate.one)

## API Endpoints

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

## Resource Usage

The TypeScript server typically uses ~50-80MB RAM vs 200-400MB+ for the Java/Spring Boot version.
