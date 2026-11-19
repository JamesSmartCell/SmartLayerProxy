# Firmware Over-The-Air (OTA) Updates

SmartLayerProxy provides a complete firmware OTA update system for IoT devices. This document describes the end-to-end flow, API endpoints, and release procedures.

## Overview

The OTA update flow consists of three main steps:

1. **Upload**: Upload a new firmware binary to Cloudflare R2
2. **Notify**: Notify devices that an update is available
3. **Download**: Devices download and flash the firmware

## Configuration

Firmware OTA requires the following environment variables:

- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: Cloudflare R2 credentials
- `R2_FIRMWARE_BUCKET_NAME`: **Global** firmware bucket default (optional, defaults to `R2_BUCKET_NAME`)
- `R2_FIRMWARE_PUBLIC_URL`: **Global** firmware public URL (optional)
  - If not set, falls back to `R2_PUBLIC_URL`
  - If neither is set, uses the private `r2.cloudflarestorage.com` endpoint (devices won't be able to download)

### Per-project firmware buckets

Projects can override the global firmware bucket/URL (and optionally credentials) without changing
GarageDoor/Web3E defaults. Project name `zigbee-gateway` maps to env suffix `ZIGBEE_GATEWAY`
(uppercase; non-alphanumeric → `_`):

```bash
R2_FIRMWARE_BUCKET_NAME__ZIGBEE_GATEWAY=esp-firmware
R2_FIRMWARE_PUBLIC_URL__ZIGBEE_GATEWAY=https://pub-862b54f8a0134f8d8276f74732be8015.r2.dev
# Optional if the R2 API token is bucket-scoped:
# R2_ACCESS_KEY_ID__ZIGBEE_GATEWAY=...
# R2_SECRET_ACCESS_KEY__ZIGBEE_GATEWAY=...
# R2_ACCOUNT_ID__ZIGBEE_GATEWAY=...
```

Resolution order for each project: per-project override → global `R2_FIRMWARE_*` → `R2_BUCKET_NAME` / `R2_PUBLIC_URL`.
Do not repurpose the global `R2_FIRMWARE_BUCKET_NAME` / `R2_FIRMWARE_PUBLIC_URL` for a single project.

When a dedicated firmware bucket is used without a public URL, the proxy logs a warning at upload time.

## Firmware Version Format

### Device Firmware Version String

New-style firmware must report its version in the TCP login (opcode 0x09) using this format:

```
<project>@<semver>+<hash>
```

**Examples:**
- `garagedoor@1.2.0+ab12cd3`
- `remotecamera@0.5.1+def4567`

**Components:**
- `project`: Lowercase project identifier (alphanumeric, hyphens, underscores)
- `semver`: Semantic version (MAJOR.MINOR.PATCH) - **must match uploaded version exactly**
- `hash`: Optional git short hash or build identifier

**Legacy firmware** (using opcode 0x07 or other version strings) is not notified and continues to work unchanged.

### Upload Version Format

When uploading firmware via the API or CLI tool, the version parameter must be **plain semver only**:

**✅ Correct:**
- `1.2.3`
- `0.5.1`
- `10.20.30`

**❌ Incorrect:**
- `v1.2.3` (no v prefix)
- `1.2.3+abc123` (no build suffix)
- `garagedoor@1.2.3` (no project prefix)

The uploaded version is stored in the database and compared with device semver during notifications. The comparison logic extracts MAJOR.MINOR.PATCH from any format, but uploads must use plain semver to ensure consistent storage.

## API Endpoints

### GET /api/firmware/:project/latest

Get the latest **app** firmware metadata for a project.

**Response:**
```json
{
  "project": "garagedoor",
  "version": "1.2.0",
  "url": "https://r2.example.com/firmware/garagedoor/1.2.0/firmware.bin",
  "sha256": "abc123...",
  "size": 524288
}
```

This endpoint is called by devices to check for updates and download the firmware.

### GET /api/firmware/:project/setup

Get the current **setup** (provisioning portal) firmware metadata for a project. Same JSON shape as `/latest`, plus `"channel": "setup"`. Distinct from app latest — used after a revoke notice.

### POST /api/firmware/:project

Upload a new firmware binary (admin authentication required).

**Query Parameters:**
- `version` (required): **Plain semver MAJOR.MINOR.PATCH only** (e.g., `1.2.3`). Must NOT include:
  - Project name prefix (not `garagedoor@1.2.3`)
  - `v` prefix (not `v1.2.3`)
  - Build suffix (not `1.2.3+abc123`)
  
  **Important:** This version must match the `FIRMWARE_SEMVER` constant in your device firmware exactly.
- `signature` (required): Admin signature
- `message` (required): Signed message in format `firmware:<project>:<version>:<sha256>:<nonce>`
- `notify` (optional): If `true`, automatically notify connected devices after upload

**Request Body:** Raw firmware binary (Content-Type: `application/octet-stream`)

**Response:**
```json
{
  "success": true,
  "project": "garagedoor",
  "version": "1.2.0",
  "sha256": "abc123...",
  "size": 524288,
  "url": "https://r2.example.com/firmware/garagedoor/1.2.0/firmware.bin",
  "uploadedBy": "0x1234...",
  "notified": 3
}
```

The `notified` field appears only if `?notify=true` was used.

### POST /api/firmware/:project/current

Set a specific version as current (admin authentication required).

**Request Body:**
```json
{
  "version": "1.1.0",
  "signature": "0xabc...",
  "message": "current:<project>:<version>:<nonce>"
}
```

**Query Parameters:**
- `notify` (optional): If `true`, automatically notify connected devices after setting current version

**Response:**
```json
{
  "success": true,
  "project": "garagedoor",
  "version": "1.1.0",
  "setBy": "0x1234...",
  "notified": 2
}
```

### POST /api/firmware/:project/notify

Notify connected devices about available firmware updates (admin authentication required).

**Request Body:**
```json
{
  "message": "notify:<project>:<nonce>",
  "signature": "0xabc...",
  "devices": ["0xaaa...", "0xbbb..."],
  "force": false
}
```

**Parameters:**
- `message` (required): Signed message `notify:<project>:<nonce>`
- `signature` (required): Admin signature
- `devices` (optional): Array of device addresses to notify. If omitted, notifies all eligible devices.
- `force` (optional): If `true`, notifies all devices even if they're already on the latest version

**Response:**
```json
{
  "success": true,
  "project": "garagedoor",
  "latest": "1.2.0",
  "notified": [
    { "address": "0xaaa...", "version": "1.0.0" },
    { "address": "0xbbb...", "version": "1.1.0" }
  ],
  "skipped": [
    { "address": "0xccc...", "reason": "already up to date" },
    { "address": "0xddd...", "reason": "different project or legacy format" }
  ],
  "notifiedBy": "0x1234..."
}
```

**Selection Logic:**
1. Only devices with matching `project` are selected
2. Only devices using the new version format (`project@semver+hash`) are selected
3. By default, only devices with `semver` older than the latest version are notified
4. With `force: true`, all devices are notified regardless of version
5. Legacy firmware (opcode 0x07, non-standard version strings) is never notified

**Notification Method:**
The proxy sends an API call to the device using opcode 0x04 with method `updateReady` and no parameters. Devices should respond by:
1. Calling `GET /api/firmware/:project/latest` to get the update metadata
2. Downloading the binary from the `url` in the response
3. Verifying the SHA256 checksum
4. Flashing the firmware (OTA)
5. Rebooting

### GET /api/telemetry/devices

Get metrics for all connected devices (telemetry authentication required).

**Response:** Array of device metrics with firmware information:
```json
[
  {
    "address": "0xaaa...",
    "firmwareVersion": "garagedoor@1.0.0+abc123",
    "project": "garagedoor",
    "version": "1.0.0",
    "updateAvailable": true,
    ...
  }
]
```

**Added Fields:**
- `project`: Parsed project name (if using new format)
- `version`: Parsed semver (if using new format)
- `updateAvailable`: Boolean indicating if a newer version exists

## CLI Tool

The `tools/firmware/upload.ts` script uploads firmware with admin authentication.

### Usage

```bash
npm run firmware:upload <project> <version> <firmware.bin> [--notify]
```

or

```bash
ts-node tools/firmware/upload.ts <project> <version> <firmware.bin> [--notify]
```

**Examples:**
```bash
# Upload only
npm run firmware:upload garagedoor 1.2.0 firmware.bin

# Upload and notify
npm run firmware:upload garagedoor 1.2.0 firmware.bin --notify
```

**Configuration:**
The tool requires a `.env` file (in `tools/firmware/.env` or repo root) with:
```
PROXY_BASE_URL=https://your-proxy.com
FIRMWARE_ADMIN_KEY=0x...
```

The `FIRMWARE_ADMIN_KEY` is an Ethereum private key that must be in the configured admin address list.

## End-to-End Release Steps

### 1. Build and Test Firmware

Build your firmware binary and ensure it reports the correct version string in the TCP login.

**Define version constants in your firmware:**

```cpp
#define FIRMWARE_PROJECT "garagedoor"
#define FIRMWARE_SEMVER "1.2.0"
#define FIRMWARE_HASH "ab12cd3"

// Construct full version string for login
String firmwareVersion = String(FIRMWARE_PROJECT) + "@" + 
                        String(FIRMWARE_SEMVER) + "+" + 
                        String(FIRMWARE_HASH);
// Result: "garagedoor@1.2.0+ab12cd3"
```

**Important:** The `FIRMWARE_SEMVER` value (e.g., `"1.2.0"`) must match the version you pass to the upload tool exactly.

### 2. Upload Firmware

Upload the binary to the proxy:

```bash
npm run firmware:upload garagedoor 1.2.0 firmware.bin
```

This will:
- Compute the SHA256 hash
- Sign the upload request with your admin key
- Upload the binary to Cloudflare R2
- Set it as the current version for the project

### 3. Notify Devices

**Option A: Manual Notification**

Use the notify endpoint to control exactly when devices are notified:

```bash
curl -X POST https://proxy.example.com/api/firmware/garagedoor/notify \
  -H "Content-Type: application/json" \
  -d '{
    "message": "notify:garagedoor:<nonce>",
    "signature": "0x...",
    "force": false
  }'
```

**Option B: Automatic Notification**

Use the `--notify` flag during upload:

```bash
npm run firmware:upload garagedoor 1.2.0 firmware.bin --notify
```

This automatically notifies all connected devices with older versions immediately after upload.

### 4. Monitor Updates

Check telemetry to see which devices have updated:

```bash
curl -H "Authorization: Bearer <telemetry-api-key>" \
  https://proxy.example.com/api/telemetry/devices
```

Look for:
- `firmwareVersion` field showing the current version
- `updateAvailable` field showing if an update is pending
- Firmware notify events in the telemetry feed

## Device Implementation

Devices must implement the following to support OTA:

### 1. Report Version in Login (Opcode 0x09)

When authenticating with the proxy, send opcode 0x09 with the version string:

```cpp
// Format: [challenge(16)] + [version_length(1)] + [version_string(N)]
String version = "garagedoor@1.2.0+ab12cd3";
uint8_t versionLen = version.length();
// Build packet: challenge + [versionLen] + version bytes
```

### 2. Handle updateReady API Call

When the proxy sends an `updateReady` call (opcode 0x04), the device should:

1. Acknowledge the message (respond with opcode 0x05 or 0x08)
2. Call `GET /api/firmware/:project/latest` to get update metadata
3. Download the firmware from the `url` field
4. Verify the SHA256 hash matches the `sha256` field
5. Flash the firmware using OTA
6. Reboot

**Example (ESP32/Arduino):**

```cpp
void handleApiCall(String method, Map<String, String> args) {
  if (method == "updateReady") {
    Serial.println("Firmware update available!");
    downloadAndFlashUpdate();
  }
}

void downloadAndFlashUpdate() {
  // Get latest metadata
  String url = "https://proxy.example.com/api/firmware/" + PROJECT + "/latest";
  HTTPClient http;
  http.begin(url);
  int httpCode = http.GET();
  
  if (httpCode == 200) {
    DynamicJsonDocument doc(1024);
    deserializeJson(doc, http.getString());
    
    String firmwareUrl = doc["url"];
    String expectedSha256 = doc["sha256"];
    int size = doc["size"];
    
    // Download and flash
    Update.begin(size);
    // ... download from firmwareUrl, verify hash, flash
    ESP.restart();
  }
}
```

## Telemetry Events

All firmware notifications are recorded as telemetry events with type `firmware_notify`:

```json
{
  "id": 12345,
  "timestamp": 1234567890,
  "device": "0xaaa...",
  "eventType": "firmware_notify",
  "firmwareProject": "garagedoor",
  "firmwareNotifyVersion": "1.2.0"
}
```

These events can be queried through the telemetry API for monitoring and analysis.

## Device Revocation (REVOCATION)

An admin can revoke a specific device by address. The proxy sends an **admin-signed revoke notice** over the existing OTA notify channel (TCP opcode `0x04` / `updateReady`). The device must OTA-install that project's **setup firmware** and reboot into the provisioning portal.

### Setup firmware (distinct from app `latest`)

Setup (provisioning portal) firmware is stored per project alongside app firmware in R2, but **never** becomes `/api/firmware/:project/latest`.

| | App firmware | Setup firmware |
|---|---|---|
| GET metadata | `/api/firmware/:project/latest` | `/api/firmware/:project/setup` |
| Upload | `POST /api/firmware/:project` | `POST /api/firmware/:project/setup` |
| Signed message | `firmware:<project>:<version>:<sha256>:<nonce>` | `setup-firmware:<project>:<version>:<sha256>:<nonce>` |
| R2 key | `firmware/<project>/<version>/firmware.bin` | `firmware/<project>/setup/<version>/firmware.bin` |
| CLI | `npm run firmware:upload ...` | `npm run firmware:upload-setup ...` |

**Post-revoke boot (setup firmware contract):** app sets NVS `web3e_boot` / `stay_portal=1` before OTA to setup. Setup stays in the captive portal until the user taps **Done**, then clears the flag and re-pulls app firmware. Setup typically does **not** TCP-login to the proxy while in the portal — do not rely on a setup-firmware login for telemetry.

### Exact revoke notice format (for firmware agents)

Transport is the **same** as OTA notify: TCP opcode `0x04`, method name `updateReady`, length-prefixed key/value args (Web3E `APIReturn` params).

**Normal OTA notify (unchanged):**

| Field | Value |
|---|---|
| method | `updateReady` |
| args | _(none)_ |
| device response | `checking` or `rate_limited` |

**Revoke notice (extension):**

| Field | Value |
|---|---|
| method | `updateReady` |
| `purpose` | `revoke` |
| `version` | setup firmware plain semver (e.g. `1.0.0`) |
| `sha256` | setup firmware SHA-256 hex (lowercase, 64 chars) |
| `size` | setup firmware size in bytes (decimal string) |
| `message` | `revoke:<project>:<device>:<sha256>:<nonce>` |
| `signature` | EIP-191 `personal_sign` of `message` by an `ADMIN_ADDRESSES` key |
| device response | `revoking` (required ack before OTA) |

Notes:

- `<device>` is the lowercase `0x`-prefixed device address (the device's KeyID address).
- `<sha256>` in `message` is the **setup** firmware hash (binds the notice to a specific binary).
- `<nonce>` is a 64-char hex challenge from `GET /api/admin/challenge` (same admin auth flow as upload/notify).
- URL is **not** sent on the wire (255-byte arg limit). After verifying the signature, the device MUST `GET /api/firmware/<project>/setup`, confirm `sha256`/`size`/`version` match the notice, then download `url`, verify SHA-256, flash, and reboot.
- Devices MUST treat `purpose=revoke` as an instruction to install setup firmware **even if** that means replacing newer app firmware (revoke is not a semver upgrade).
- Devices SHOULD verify `signature` recovers an address in their local admin list before flashing.
- **App firmware sequence:** respond `revoking` → set NVS `web3e_boot`/`stay_portal=1` → OTA setup → reboot. (Aligned with [Web3E-Setup-Firmware#3](https://github.com/JamesSmartCell/Web3E-Setup-Firmware/pull/3).)

### Admin HTTP API

**POST `/api/firmware/:project/revoke`**

```json
{
  "device": "0xaaa...",
  "message": "revoke:<project>:<device>:<setupSha256>:<nonce>",
  "signature": "0x..."
}
```

Response:

```json
{
  "success": true,
  "project": "garagedoor",
  "device": "0xaaa...",
  "status": "delivered",
  "queued": false,
  "setup": { "version": "1.0.0", "sha256": "...", "size": 12345, "url": "https://..." },
  "revokeId": 1,
  "revokedBy": "0xadmin..."
}
```

- If the device is **online**, the notice is sent immediately (`status: delivered`).
- If the device is **offline**, the signed notice is queued (`status: pending`, `queued: true`) and delivered automatically on the device's next TCP login.
- A new revoke for the same device cancels any previous pending/delivered revoke.

**POST `/api/firmware/:project/revoke/cancel`**

```json
{
  "device": "0xaaa...",
  "message": "revoke-cancel:<project>:<device>:<nonce>",
  "signature": "0x..."
}
```

Cancels a pending or delivered-but-not-completed revoke so it will not be (re)delivered.

**GET `/api/firmware/:project/revokes`** — list revoke records (`?device=`, `?status=`).

### CLI

```bash
# Upload setup firmware (does not change app latest)
npm run firmware:upload-setup garagedoor 1.0.0 setup-firmware.bin

# Revoke a device (queues if offline)
npm run firmware:revoke garagedoor 0xaaa...

# Cancel a pending revoke
npm run firmware:revoke:cancel garagedoor 0xaaa...
```

Requires the same `.env` as upload: `PROXY_BASE_URL`, `FIRMWARE_ADMIN_KEY`.

### Queueing behaviour

1. Admin calls revoke → proxy verifies signature, records `firmware_revoke_requested`, stores notice.
2. If connected → send `updateReady` args, mark `delivered`, record `firmware_revoke_delivered`.
3. If offline → leave `pending`; on next TCP auth (opcode `0x09`/`0x07`), deliver and mark `delivered`.
4. When the device responds to the API call with a body starting with `revoking`, mark `acknowledged` and record `firmware_revoke_acknowledged` (observable outcome **before** OTA).
5. Disconnect after delivery/ack is noted (expected when the device reboots into setup/portal).
6. When the **app** firmware later TCP-logs in again for the same project (after ack, or after a post-delivery disconnect), mark `completed` and record `firmware_revoke_completed`. Setup firmware usually does **not** appear on the TCP channel while `stay_portal=1`.
7. Cancel moves active revokes to `cancelled` (`firmware_revoke_cancelled`) and stops delivery.

### Revoke telemetry events

| `eventType` | When |
|---|---|
| `firmware_revoke_requested` | Admin revoke accepted |
| `firmware_revoke_delivered` | Notice written to device TCP channel |
| `firmware_revoke_acknowledged` | Device replied `revoking` (pre-OTA ack) |
| `firmware_revoke_completed` | App firmware re-appeared after revoke (post-portal re-provision) |
| `firmware_revoke_cancelled` | Admin cancelled pending/delivered/acknowledged revoke |

`firmware_project` = app project; `firmware_notify_version` = setup version; `firmware_version` on completed = reported app login string.

## Security

- All upload, notify, setup-upload, and revoke operations require admin authentication (Ethereum signature)
- Firmware binaries are uploaded to Cloudflare R2 with unique keys
- Devices verify SHA256 checksums before flashing
- Revoke notices are admin-signed and bound to a specific setup SHA-256
- Legacy firmware is never automatically notified (prevents breaking old devices)

## Troubleshooting

### Device Not Notified

Check:
1. Device is using new version format (`project@semver+hash`)
2. Device project matches the uploaded firmware project
3. Device version is older than the latest (unless using `force: true`)
4. Device is connected to the TCP proxy (check telemetry)
5. Uploaded version is plain semver (not `v1.2.3` or `1.2.3+hash`)

### Update Failed

Check:
1. Device can reach the firmware download URL
2. SHA256 hash matches after download
3. Device has enough free space for OTA
4. Device OTA partition is valid

### Version Parsing Failed

Check:
1. Device version string format is exactly `<project>@<semver>+<hash>`
2. Semver uses three numbers (e.g., `1.2.3`, not `1.2`)
3. Project name is alphanumeric with hyphens/underscores only
4. Upload version is plain semver MAJOR.MINOR.PATCH (reject at upload if invalid)

### Upload Rejected: Invalid Version

If upload fails with "Version must be plain semver MAJOR.MINOR.PATCH":

**Fix your upload command:**
```bash
# ❌ Wrong
npm run firmware:upload garagedoor v1.2.0 firmware.bin
npm run firmware:upload garagedoor 1.2.0+abc firmware.bin
npm run firmware:upload garagedoor garagedoor@1.2.0 firmware.bin

# ✅ Correct
npm run firmware:upload garagedoor 1.2.0 firmware.bin
```

**Ensure device firmware matches:**
```cpp
// In your device code, FIRMWARE_SEMVER must match upload version
#define FIRMWARE_SEMVER "1.2.0"  // Must match: 1.2.0
```
