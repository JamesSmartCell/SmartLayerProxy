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

## Resource Usage

The TypeScript server typically uses ~50-80MB RAM vs 200-400MB+ for the Java/Spring Boot version.
