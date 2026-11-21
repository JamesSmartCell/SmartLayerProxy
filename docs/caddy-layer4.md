# Caddy layer4 (caddy-l4) for SmartLayerProxy

Topology: Caddy on an AWS host terminates TLS for `scriptproxy2.percolate.one` and reverse-proxies HTTP to an SSH reverse tunnel (`127.0.0.1:9051` → Pi SLP HTTP). Raw TCP for the Web3E TcpBridge is fronted with [caddy-l4](https://github.com/mholt/caddy-l4), which prepends a **PROXY protocol v1** header and forwards through a second tunnel (`127.0.0.1:9052` → Pi SLP TCP).

SLP ports (from `application.properties`):

| Role | Port |
|------|------|
| HTTP API (`server.port`) | **8081** |
| TCP bridge (`tcp.port`) | **8082** |
| UDP (`udp.port`) | **8083** |

Devices connect publicly to AWS **:8083** for TCP (layer4). That is *not* the SLP UDP port — it is the public TCP listener that Caddy forwards to the tunnel → SLP **8082**.

## Cutover order

1. **Deploy this SLP PR first** (PROXY protocol optional; direct connections unchanged).
2. Confirm devices still connect without PROXY (shim / direct).
3. Build Caddy with caddy-l4 and add the `layer4` block **with** `proxy_protocol v1`.
4. Open AWS SG for TCP 8083 (and 443/80 as needed); point devices at the AWS host.
5. Verify telemetry shows real client IPs (not `::1`) on connect / `api_call` / `get_challenge_failed`.

## Build Caddy with xcaddy (Ubuntu)

```bash
# Go (if needed)
sudo apt update
sudo apt install -y golang-go

# xcaddy
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
export PATH="$PATH:$(go env GOPATH)/bin"

# Custom binary with layer4
xcaddy build --with github.com/mholt/caddy-l4
```

### Swap in for the apt package (dpkg-divert)

Official method from [Caddy docs — package support files for custom builds](https://caddyserver.com/docs/build#package-support-files-for-custom-builds-for-debianubunturaspbian):

```bash
# Assume ./caddy is the xcaddy-built binary in the current directory
sudo dpkg-divert --divert /usr/bin/caddy.default --rename /usr/bin/caddy
sudo mv ./caddy /usr/bin/caddy.custom
sudo update-alternatives --install /usr/bin/caddy caddy /usr/bin/caddy.default 10
sudo update-alternatives --install /usr/bin/caddy caddy /usr/bin/caddy.custom 50
sudo systemctl restart caddy
```

Confirm modules:

```bash
caddy list-modules | grep layer4
caddy version
```

## Example Caddyfile

Syntax verified against the current [caddy-l4 IMAPS / PROXY example](https://github.com/mholt/caddy-l4/blob/master/docs/examples/imaps_with_proxy_protocol.md) and [proxy handler docs](https://github.com/mholt/caddy-l4/blob/master/docs/handlers/proxy.md): `proxy_protocol v1` is set **inside** the `proxy` handler to *send* the header upstream.

```caddyfile
{
	# Global layer4 app — do not bind ports the HTTP app already uses
	layer4 {
		# Public TCP for Web3E TcpBridge devices
		:8083 {
			route {
				proxy {
					# Send PROXY protocol v1 to SLP (via SSH tunnel)
					proxy_protocol v1
					upstream 127.0.0.1:9052
				}
			}
		}
	}
}

# HTTPS API — TLS terminated here; X-Forwarded-For set to the real client
scriptproxy2.percolate.one {
	handle /api* {
		reverse_proxy 127.0.0.1:9051 {
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Proto {scheme}
			header_up X-Forwarded-Host {host}
		}
	}

	handle {
		respond 403
	}
}
```

Notes:

- SLP trusts PROXY / XFF only from loopback by default (`PROXY_PROTOCOL_TRUSTED=127.0.0.1,::1`). The SSH tunnel makes the immediate peer loopback on the Pi.
- Deploy SLP **before** enabling `proxy_protocol v1`. If Caddy sends PROXY and SLP is old, the device opcode stream will be corrupted.
- To disable PROXY temporarily, remove the `proxy_protocol v1` line; SLP will treat the first bytes as application data.

## autossh on the Raspberry Pi

Forward AWS localhost ports to SLP on the Pi (adjust user/host):

```bash
# HTTP: AWS :9051 → Pi SLP :8081
# TCP:  AWS :9052 → Pi SLP :8082
autossh -M 0 -N \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -R 9051:127.0.0.1:8081 \
  -R 9052:127.0.0.1:8082 \
  ubuntu@YOUR_AWS_HOST
```

SLP env on the Pi (optional overrides):

```bash
# Default already trusts loopback
PROXY_PROTOCOL_TRUSTED=127.0.0.1,::1
# ignore (default) | reject — untrusted peers sending PROXY
PROXY_PROTOCOL_UNTRUSTED=ignore
```

HTTP XFF is accepted when the immediate peer is in that trusted list (loopback through the tunnel). Legacy `TRUST_PROXY=true` still trusts XFF from any peer.

## AWS security group

| Direction | Port | Source | Purpose |
|-----------|------|--------|---------|
| Inbound | 443 | 0.0.0.0/0 (::/0) | HTTPS for `scriptproxy2.percolate.one` |
| Inbound | 80 | 0.0.0.0/0 | ACME / HTTP→HTTPS (if used) |
| Inbound | 8083 | 0.0.0.0/0 or device nets | Public TCP bridge (caddy-l4) |
| Inbound | 22 | admin IPs only | SSH / autossh from Pi |
| Outbound | * | as needed | Default OK |

Do **not** expose 9051/9052 publicly — they should bind to `127.0.0.1` on the AWS host via `-R`.

## Verify

```bash
# On Pi: after a device connects through Caddy+PROXY
# telemetry connect / api_call rows should show the public client IP, not ::1

npm run telemetry:pull
npm run telemetry:analyse
# Look for eventType get_challenge_failed and real ipAddress values
```

## References

- [caddy-l4 README](https://github.com/mholt/caddy-l4)
- [PROXY protocol spec](https://www.haproxy.org/download/1.8/doc/proxy-protocol.txt)
- [docs/tcp-proxy-ip-address.md](./tcp-proxy-ip-address.md) — SLP-side IP behaviour
