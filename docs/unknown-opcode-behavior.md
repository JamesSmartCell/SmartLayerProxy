# Unknown Opcode Handling in ASyncTCPService

## Current Master Behavior (Pre-PR)

The current deployed `master` branch's `ASyncTCPService.parseClientMessage()` uses a `switch` statement **without a default case**:

```typescript
switch (opcode) {
  case 0x01: // login
  case 0x02: // challenge
  case 0x03: // auth with personal sign
  case 0x07: // auth without personal sign
  case 0x04: // return values
  case 0x05: // API response
  case 0x08: // HTTP bridge response
  // ... handlers ...
}
// No default case - falls through silently
```

### Impact on Unknown Opcodes

When master receives an **unknown opcode** (e.g., 0x09 or 0x0A from new firmware):

1. ✅ **Connection stays open** - No termination
2. ✅ **Stream framing intact** - TCP buffer read as single message (see below)
3. ✅ **Silent ignore** - Message logged but not processed
4. ✅ **Device can continue** - Subsequent known opcodes work normally

### TCP Framing Robustness

The `TCPClient` implementation in master is **robust to partial and combined frames**:

```typescript
socket.on('data', (data: Buffer) => {
  buffer = Buffer.concat([buffer, data]);
  // ... length checks ...
  this.serverCallback.receivedMessage(this.clientIndex, buffer);
  buffer = Buffer.alloc(0); // Reset after processing
});
```

**Key characteristics:**
- Each TCP `data` event accumulates into a buffer
- The entire buffer (up to `MAX_TCP_PACKET = 4096` bytes) is passed as one message
- Buffer resets after `receivedMessage()` completes
- **No length-based framing** - each TCP read is one opcode message

### Backward Compatibility Conclusion

✅ **New firmware (0x09, 0x0A) is safe with old master servers:**

- 0x09 auth with version: Ignored, but firmware should fall back to 0x07
- 0x0A diagnostics: Silently ignored, connection remains open

**However:** Since master doesn't implement 0x09, **firmware MUST send 0x07 as fallback** if the server doesn't respond to 0x09, or use 0x07 exclusively until this PR is deployed.

## This PR's Changes

### Opcode 0x09 - Auth with Firmware Version
- **Format:** `[addr20][sig65][versionLen1 (0-32)][ASCII version]`
- **Signature over:** `keccak256(challenge || versionLen || version)`
- **Behavior:** Validates and stores firmware version; falls back gracefully if malformed

### Opcode 0x0A - WiFi Diagnostics
- **Format:** 14 bytes, big-endian:
  - `[0]` = 0x0A
  - `[1]` = resetReason (esp_reset_reason_t)
  - `[2-3]` = bootCount uint16
  - `[4-5]` = wifiAttempts uint16
  - `[6-9]` = connectTimeMs uint32
  - `[10]` = networkIndex
  - `[11]` = lastFailureStage (0-6)
  - `[12]` = lastDisconnectReason (wifi_err_reason_t)
  - `[13]` = reserved
- **Behavior:** 
  - Only accepted from authenticated devices
  - Decodes ESP reset reasons and WiFi error codes to names
  - Stores in `device_diagnostics` table for analysis
  - Silently ignores if unauthenticated or malformed

### Unknown Opcode Handling
- **No default case added** - maintains backward compatibility
- Unknown opcodes still fall through silently
- Future opcodes can be added without breaking old clients

## Deployment Strategy

1. **Deploy this PR first** (proxy supports 0x09, 0x0A)
2. **Then deploy Web3E firmware** (sends 0x09, 0x0A)
3. **Fallback safe:** New firmware + old proxy = firmware uses 0x07, no diagnostics

**Migration window:** Once this PR deploys, new firmware can start sending 0x09/0x0A immediately. Old firmware continues working indefinitely with 0x07.
