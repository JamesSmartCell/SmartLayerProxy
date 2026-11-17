# TCP Connection IP Address Handling

## Current State

Device IP addresses shown in telemetry often display as `::1` (localhost IPv6) because traffic arrives via a local reverse proxy or tunnel before reaching SmartLayerProxy.

## HTTP API Routes: X-Forwarded-For Support

For HTTP routes, the proxy can now honor standard forwarding headers when configured:

- Set environment variable `TRUST_PROXY=true` (or `trust.proxy=true` in application.properties)
- SmartLayerProxy will extract the real client IP from:
  - `X-Forwarded-For` header (takes first IP from comma-separated list)
  - `CF-Connecting-IP` header (Cloudflare)

**Example:**
```bash
export TRUST_PROXY=true
```

This applies to all HTTP-based device API routes:
- `GET /api/getEthAddress`
- `GET /api/:Address/:method`
- `GET /api/async/:Address/:method`
- `GET /api/bridge/:Address/:data`
- `GET /api/bridge/login`

## TCP Socket Connections: PROXY Protocol

For raw TCP connections (port 8082), the current implementation cannot read IP forwarding information because:

1. TCP sockets don't have HTTP headers
2. The socket's `remoteAddress` reflects the immediate peer (the reverse proxy/tunnel)

### Potential Solution: PROXY Protocol

The **PROXY protocol** (v1 or v2) prepends connection metadata (real client IP, port) to the TCP stream before application data. This is supported by:

- HAProxy
- nginx (with `proxy_protocol` directive)
- AWS ELB/NLB
- Cloudflare Spectrum

**Implementation would require:**

1. Detecting and parsing PROXY protocol header on new TCP connections
2. Extracting the real client IP before processing authentication opcodes
3. Stripping the PROXY header from the data stream

**Example PROXY v1 header:**
```
PROXY TCP4 192.168.1.100 10.0.0.1 50123 8082\r\n
```

This feature is **not implemented** in the current release. TCP connections will continue to show the tunnel/proxy IP address until PROXY protocol support is added.

### Workarounds

- For development/testing: disable the tunnel and connect directly
- For production: accept that TCP telemetry shows proxy IPs, or implement PROXY protocol support

## References

- [PROXY protocol specification](https://www.haproxy.org/download/1.8/doc/proxy-protocol.txt)
- [nginx proxy_protocol](https://docs.nginx.com/nginx/admin-guide/load-balancer/using-proxy-protocol/)
