# Signed RPC Proxy

ESP32 devices (Web3E) must not trust public JSON-RPC endpoints without TLS certificate validation. Instead, authenticated devices ask SmartLayerProxy to perform **read-only** chain calls via [`@smarttokenlabs/waterfall-rpc`](https://www.npmjs.com/package/@smarttokenlabs/waterfall-rpc). The proxy signs the result with a dedicated key so firmware can verify authenticity with a compiled-in public address.

Web3E device-side verification is a later PR; this document is the **byte-exact wire contract**.

## Why EIP-191 (personal_sign)?

EIP-191 matches the existing device login path (opcode `0x03`) and is cheap to verify on ESP32. EIP-712 would add typed-data hashing complexity without a clear gain for a single fixed message layout. The signed payload is a deterministic UTF-8 string (below); firmware reconstructs it and verifies with the proxy signer address from `GET /api/rpc/signer`.

## Environment

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `RPC_SIGNER_PRIVATE_KEY` | **Yes** for signed RPC | — | Hex private key (`0x` + 64 hex). **Gitignored `.env` only. Never logged.** Missing/invalid → fail-closed. |
| `RPC_RATE_LIMIT_DEVICE_PER_MIN` | No | `30` | Per-device requests / rolling 60s |
| `RPC_RATE_LIMIT_IP_PER_MIN` | No | `60` | Per-IP requests / rolling 60s |
| `RPC_CATALOG_REFRESH_MS` | No | `86400000` (24h) | Forces `WaterfallRpc.resetProviders(24h)` |

### Waterfall RPC catalog refresh

`@smarttokenlabs/waterfall-rpc` **does** auto-refresh: on use it calls `scheduleCatalogRefreshIfStale()` when the on-disk catalog is older than **7 days**, downloading Chainlist / ranking feeds in the background.

This proxy **additionally** runs a **24h** timer that calls `WaterfallRpc.resetProviders(24 * 60 * 60 * 1000)` and logs `[SignedRpc] Waterfall RPC catalog refresh completed` (or a failure message). Cache lives under `.rpcdata/` (gitignored).

## HTTP API

### `GET /api/rpc/signer`

Public. Returns the signer address firmware should embed:

```json
{
  "address": "0x…",
  "allowedMethods": ["eth_call", "eth_getBalance", "eth_blockNumber", "eth_chainId", "eth_getCode", "eth_getTransactionReceipt"],
  "messageVersion": "SmartLayerProxy-RPC-v1"
}
```

`503` if the signer key is not configured.

### `POST /api/rpc/:chainId`

Gated: `Authorization: Bearer <TELEMETRY_API_KEY>` **or** admin EIP-191 message `rpc:<chainId>:<64-hex-nonce>` (same admin challenge flow as firmware tools).

Body:

```json
{
  "method": "eth_call",
  "params": [{ "to": "0x…", "data": "0x…" }, "latest"],
  "device": "0xDeviceAddress…",
  "nonce": "0xdeadbeef…"
}
```

Success includes `message`, `signature`, `result`, `blockNumber`, `timestamp`, `paramsHash`, `signer`.

Not an open public relay — unauthenticated callers get `401` / `503`.

## Allowlist (read-only)

`eth_call`, `eth_getBalance`, `eth_blockNumber`, `eth_chainId`, `eth_getCode`, `eth_getTransactionReceipt`.

No `eth_sendTransaction` / `eth_sendRawTransaction` / wallet methods.

Calls that take a block tag are pinned to a concrete block: the proxy fetches `eth_blockNumber` first, substitutes that quantity for `latest`/`pending`/omitted tags, and includes that block in the signed message.

## TCP wire format (device ↔ proxy)

### Opcode `0x0B` — `rpcCall` (device → proxy)

Authenticated sessions only (after `0x03` / `0x07` / `0x09`). Unauthenticated packets are ignored.

```
[0]              opcode = 0x0B
[1..2]           requestId   uint16 BE  (echoed in response)
[3..6]           chainId     uint32 BE
[7]              flags       bit0 = 1 if custom nonce follows
[8]              methodLen   uint8 (≤255)
[9 ..]           method      UTF-8 (e.g. "eth_call")
[…]              paramsLen   uint16 BE (≤1024)
[…]              params      UTF-8 JSON array
if flags&1:
  […]            nonceLen    uint8 (≤255)
  […]            nonce       raw bytes (hashed into EIP-191 as 0x-hex)
```

If `flags&1` is clear, the proxy binds the signature to the device’s **current TCP challenge** (16 bytes from opcode `0x02`), hex-encoded as `nonce`.

**255-byte field note:** method and custom nonce use a `uint8` length (same convention as opcode `0x04` `writeValue`). Params use `uint16` (max 1024) because ABI calldata for `eth_call` often exceeds 255 bytes.

### Opcode `0x0C` — signed result (proxy → device)

May be **chunked** when the logical payload exceeds 1200 bytes:

```
[0]              opcode = 0x0C
[1..2]           requestId   uint16 BE
[3]              status      see status codes below
[4]              chunkIndex  uint8 (0-based)
[5]              chunkCount  uint8 (≥1)
[6..7]           payloadLen  uint16 BE
[8 ..]           payload     chunk bytes
```

#### Status codes

| Code | Name | Meaning |
|------|------|---------|
| 0 | OK | Success; payload is the logical success blob (possibly chunked) |
| 1 | BAD_REQUEST | Malformed request |
| 2 | METHOD_NOT_ALLOWED | Method not in allowlist |
| 3 | UNSUPPORTED_CHAIN | chainId not available via waterfall |
| 4 | RATE_LIMITED | Per-device or per-IP limit |
| 5 | RPC_FAILED | Upstream / waterfall error |
| 6 | SIGNER_UNAVAILABLE | Missing/invalid `RPC_SIGNER_PRIVATE_KEY` |
| 7 | RESULT_TOO_LARGE | Result > 512 UTF-8 bytes on TCP — use HTTP |
| 8 | UNAUTHENTICATED | (reserved) |

#### Error payload (`status ≠ 0`, single chunk)

```
[0]              status (same as header status)
[1..2]           errLen  uint16 BE
[3 ..]           error   UTF-8 (≤200 bytes)
```

#### Success logical payload (reassemble chunks `0 .. chunkCount-1` in order)

```
[0..7]           blockNumber   uint64 BE
[8..11]          timestamp     uint32 BE  (unix seconds)
[12..43]         paramsHash    32 bytes   (keccak256 of canonical params JSON)
[44..45]         resultLen     uint16 BE
[46 ..]          result        UTF-8 (hex quantity / hex data / canonical JSON)
[+0 .. +64]      signature     65 bytes (r\|\|s\|\|v) EIP-191 personal_sign
[+0..+1]         messageLen    uint16 BE
[+2 ..]          message       UTF-8 exact EIP-191 message body (also reconstructible)
```

### Large results

- **TCP:** results larger than **512** UTF-8 bytes return `RESULT_TOO_LARGE` (status 7). Use HTTP `POST /api/rpc/:chainId` for large `eth_getCode` / receipts.
- **Chunking:** success payloads may span multiple `0x0C` packets (`chunkCount > 1`). Each packet stays under `MAX_TCP_PACKET` (4096). Firmware concatenates payload slices in `chunkIndex` order.
- Opcode `0x04`’s 255-byte-per-field limit does **not** apply to `0x0B`/`0x0C` (dedicated framing).

## EIP-191 message layout (byte-exact)

UTF-8, LF (`\n`) separators, **no trailing newline**:

```
SmartLayerProxy-RPC-v1
device:0x<40 lowercase hex>
nonce:0x<lowercase hex>
chainId:<decimal>
method:<exact method string>
paramsHash:0x<64 lowercase hex>
block:<decimal block number>
timestamp:<unix seconds decimal>
result:<lowercase 0x-hex or canonical JSON>
```

- `device` / `nonce` / `paramsHash` / hex `result` values are lowercase `0x…`.
- `paramsHash = keccak256(utf8(canonicalJson(params)))` where `canonicalJson` is `JSON.stringify` with **sorted object keys** and no insignificant whitespace.
- `result` for hex quantities/data is lowercase `0x…`; for receipt objects it is canonical JSON.

The Ethereum signed digest is the standard personal_sign prefaced hash:

`keccak256("\x19Ethereum Signed Message:\n" + len(message) + message)`.

## Verification example (viem / ethers)

```ts
import { verifyMessage } from 'viem';
// or: import { ethers } from 'ethers';

const message = [
  'SmartLayerProxy-RPC-v1',
  'device:0xabc…',
  'nonce:0x…',
  'chainId:1',
  'method:eth_call',
  'paramsHash:0x…',
  'block:18500000',
  'timestamp:1730000000',
  'result:0x0000…0001',
].join('\n');

const ok = await verifyMessage({
  address: '0xProxySigner…', // from GET /api/rpc/signer
  message,
  signature: '0x…',           // 65-byte sig as hex
});
// ethers: ethers.verifyMessage(message, signature) === signerAddress
```

Firmware ports the same string build + `ecrecover` on the personal_sign digest, comparing to the compiled-in signer address.

## Replay binding

The signed message includes:

1. **device** address (session identity)
2. **nonce** — TCP session challenge or request-supplied nonce
3. **chainId**, **method**, **paramsHash**
4. **result**, **block**, **timestamp**

An attacker replaying an old `balance=1` fails because the device’s current challenge/nonce (or a fresh request nonce) will not match. Firmware should reject timestamps too far from local clock and optionally require `block` freshness.

## Telemetry

Event type `rpc_call` in `device_events`:

| Column | Content |
|--------|---------|
| `device` | Device address |
| `api_method` | eth_* method |
| `api_success` | 1/0 |
| `api_response_time` | Duration ms |
| `ip_address` | Client IP |
| `firmware_project` | chainId (decimal string) |
| `failure_reason` | Error text, or `fallbacks=N` when exposed |
| `requests_60s` | Provider fallbacks when > 0 |

`telemetry:pull` / `telemetry:analyse` include these events; analyse reports an **Signed RPC** section (failures by method/chain/IP).

## Security

- Private key only via gitignored `.env`; never committed or logged.
- Fail-closed when key missing.
- Read-only allowlist + rate limits + authenticated TCP / gated HTTP.
- No open public JSON-RPC relay.
