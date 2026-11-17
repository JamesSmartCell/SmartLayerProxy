# Firmware Over-The-Air (OTA) Updates

SmartLayerProxy provides a complete firmware OTA update system for IoT devices. This document describes the end-to-end flow, API endpoints, and release procedures.

## Overview

The OTA update flow consists of three main steps:

1. **Upload**: Upload a new firmware binary to Cloudflare R2
2. **Notify**: Notify devices that an update is available
3. **Download**: Devices download and flash the firmware

## Firmware Version Format

New-style firmware must report its version in the TCP login (opcode 0x09) using this format:

```
<project>@<semver>+<hash>
```

**Examples:**
- `garagedoor@1.2.0+ab12cd3`
- `remotecamera@0.5.1+def4567`

**Components:**
- `project`: Lowercase project identifier (alphanumeric, hyphens, underscores)
- `semver`: Semantic version (MAJOR.MINOR.PATCH)
- `hash`: Optional git short hash or build identifier

**Legacy firmware** (using opcode 0x07 or other version strings) is not notified and continues to work unchanged.

## API Endpoints

### GET /api/firmware/:project/latest

Get the latest firmware metadata for a project.

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

### POST /api/firmware/:project

Upload a new firmware binary (admin authentication required).

**Query Parameters:**
- `version` (required): Semantic version string (e.g., `1.2.3`)
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

Build your firmware binary and ensure it reports the correct version string in the TCP login:

```cpp
String version = "garagedoor@1.2.0+ab12cd3";
```

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

## Security

- All upload and notify operations require admin authentication (Ethereum signature)
- Firmware binaries are uploaded to Cloudflare R2 with unique keys
- Devices verify SHA256 checksums before flashing
- Legacy firmware is never automatically notified (prevents breaking old devices)

## Troubleshooting

### Device Not Notified

Check:
1. Device is using new version format (`project@semver+hash`)
2. Device project matches the uploaded firmware project
3. Device version is older than the latest (unless using `force: true`)
4. Device is connected to the TCP proxy (check telemetry)

### Update Failed

Check:
1. Device can reach the firmware download URL
2. SHA256 hash matches after download
3. Device has enough free space for OTA
4. Device OTA partition is valid

### Version Parsing Failed

Check:
1. Version string format is exactly `<project>@<semver>+<hash>`
2. Semver uses three numbers (e.g., `1.2.3`, not `1.2`)
3. Project name is alphanumeric with hyphens/underscores only
