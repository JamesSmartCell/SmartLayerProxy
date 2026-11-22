# TCP / HTTP client IP address handling

## HTTP API: X-Forwarded-For

SmartLayerProxy derives the real client IP for HTTP telemetry as follows:

1. If the **immediate peer** (`req.socket.remoteAddress`) is in the trusted proxy list (default `127.0.0.1`, `::1`), use the **leftmost** `X-Forwarded-For` entry (or `CF-Connecting-IP`).
2. Else if legacy `TRUST_PROXY=true`, trust XFF from any peer.
3. Otherwise use the socket peer address.

```bash
# Trusted peers for XFF + PROXY protocol (default loopback)
PROXY_PROTOCOL_TRUSTED=127.0.0.1,::1
# Alias:
# TRUSTED_PROXIES=127.0.0.1,::1

# Legacy: trust XFF from any peer
# TRUST_PROXY=true
```

This matches Caddy → SSH reverse tunnel → SLP, where the peer is loopback and Caddy sets `X-Forwarded-For` to the browser/device IP.

Applies to device API routes, bridge login, zigbee diagnostics, and all telemetry writers that store `ip`.

## TCP bridge: PROXY protocol

Raw TCP (port **8082**) optionally accepts a PROXY protocol header as the first bytes of each connection:

- **v1** text (`PROXY TCP4 …\r\n`) and **v2** binary
- Header may arrive split across chunks; max length capped; **500ms** read timeout
- If present and peer is trusted → parse source IP/port, strip header, use as client IP
- If absent → behaviour unchanged (direct device connections keep working)
- Untrusted peers: `PROXY_PROTOCOL_UNTRUSTED=ignore` (default, treat as app data) or `reject`

See [caddy-layer4.md](./caddy-layer4.md) for building Caddy with caddy-l4 and enabling `proxy_protocol v1` on the public TCP listener.

## Session IP pinning

After an ESP device completes the signed login handshake (including refresh auth), the TCP session records the **resolved** client IP as its pin.

- Later commands / responses / re-challenge / refresh auth on **that session** must come from the same resolved IP.
- A **fresh full login on a new connection** always re-pins (ISP / CGNAT changes do not permanently lock a device out).
- Loopback or empty IPs (legacy tunnel path without a PROXY header) are **not** pinned or enforced; a skip is logged.

```bash
# off | log (default) | enforce
IP_PIN_MODE=log
```

| Mode | Behaviour |
|------|-----------|
| `off` | Disabled |
| `log` (default) | Mismatch → journal + `ip_pin_violation` telemetry; traffic still allowed |
| `enforce` | Mismatch → journal + telemetry; drop and terminate the session |

Default is **`log`**: PROXY rollout may still have mixed legacy peers, so enforce is safer after you confirm real IPs in journals/telemetry.

Handshake / command journal lines include the resolved IP, e.g. `Receive Command: 01b1a692 #0 ip=144.6.2.81`.

## Telemetry IP population

| Event | IP source |
|-------|-----------|
| `connect` | TCP PROXY / socket, or UDP peer |
| `disconnect` | Session IP / socket |
| `api_call` | HTTP derived client IP (XFF when trusted) |
| `firmware_notify` | Session IP when available |
| `firmware_revoke_*` | Admin HTTP client IP (requested/cancelled) or device TCP IP (delivered/acknowledged/completed) |
| `device_diagnostics` | TCP client IP / session |
| `get_challenge_failed` | HTTP derived client IP + rolling per-IP counts |
| `ip_pin_violation` | Offending IP in `ip`; pinned IP + connection id + mode in `failureReason`; opcode in `apiMethod` |

## getChallenge failures

Every unsuccessful `getChallenge` emits `get_challenge_failed` with reason (`device_offline`, `timeout`, `empty_response`, `bad_response`, `exception`, …), duration ms, target device, optional firmware project, and in-memory request counts for that IP over the last 60s / 10 minutes. Successful getChallenge still uses the existing `api_call` row; the same counter logs a warning on high rate (≥30 / 60s).

`npm run telemetry:pull` / `telemetry:analyse` include `get_challenge_failed` and `ip_pin_violation`.

## References

- [PROXY protocol specification](https://www.haproxy.org/download/1.8/doc/proxy-protocol.txt)
- [caddy-l4 proxy_protocol](https://github.com/mholt/caddy-l4/blob/master/docs/handlers/proxy.md)
