# Technical Documentation

## Architecture

```
[Client] --TLS--> [Proxy:8443] --DoH--> [Cloudflare DNS]
                      |
                      +--TCP--> [example.com:443]
                               (TLS client↔destination, proxy doesn't see plaintext)
```

## HTTP CONNECT Method

RFC 7231 defines CONNECT for tunneling. Client sends:

```http
CONNECT example.com:443 HTTP/1.1
Host: example.com:443
Proxy-Authorization: Basic bXl1c2VyOm15cGFzc3dvcmQ=
```

Proxy validates auth, resolves IP via DoH, checks blocklist, replies:

```http
HTTP/1.1 200 Connection Established
Proxy-Agent: swp-step4
```

From this point, proxy pipes bytes bidirectionally (client ↔ destination). The client then starts TLS handshake with destination *through* the tunnel.

## DNS-over-HTTPS (DoH)

Uses Cloudflare's JSON API (simpler than RFC 8484 wire format):

```http
GET /dns-query?name=example.com&type=A HTTP/1.1
Host: cloudflare-dns.com
Accept: application/dns-json
```

Response:
```json
{
  "Status": 0,
  "Answer": [
    {"name": "example.com", "type": 1, "data": "93.184.216.34"}
  ]
}
```

We query both A (IPv4) and AAAA (IPv6), prefer IPv4, cache results for 60s.

## Private IP Detection

Blocks:
- **10.0.0.0/8** (RFC 1918)
- **172.16.0.0/12** (RFC 1918)
- **192.168.0.0/16** (RFC 1918)
- **127.0.0.0/8** (loopback)
- **169.254.0.0/16** (link-local)
- **100.64.0.0/10** (CGNAT, RFC 6598)
- **224.0.0.0/4** (multicast)
- **240.0.0.0/4** (reserved)
- **fc00::/7** (IPv6 ULA)
- **fe80::/10** (IPv6 link-local)
- **ff00::/8** (IPv6 multicast)
- **::1**, **::** (loopback/unspecified)

Prevents SSRF attacks (e.g., `CONNECT 169.254.169.254:80` to access cloud metadata APIs).

## Rate Limiting

Tracks active connections per destination IP. Example:

- Client A → example.com (93.184.216.34): count = 1
- Client B → example.com: count = 2
- ...50th connection to 93.184.216.34: allowed
- 51st connection: → 429 Too Many Requests

Released when upstream/client socket closes.

## Timeouts

1. **CONNECT_TIMEOUT_MS (10s)**: max time for `net.connect()` to succeed. Prevents hanging on unreachable hosts.

2. **IDLE_TIMEOUT_MS (120s)**: if no data flows in either direction for 120s, destroy both sockets. Prevents zombie connections.

## Basic Authentication

RFC 7617. Client sends `Proxy-Authorization: Basic <base64(user:pass)>`. Proxy decodes, compares with `PROXY_USER`/`PROXY_PASS`. Returns 407 if missing/wrong:

```http
HTTP/1.1 407 Proxy Authentication Required
Proxy-Authenticate: Basic realm="Secure Web Proxy"
```

**Security note**: Basic auth is cleartext (Base64 ≠ encryption). Always use over TLS (HTTPS proxy mode).

## Error Codes

- **400 Bad Request**: malformed CONNECT authority (e.g., `CONNECT :80`)
- **403 Forbidden**: destination IP is private/blocked
- **407 Proxy Authentication Required**: missing/invalid `Proxy-Authorization`
- **429 Too Many Requests**: rate-limit exceeded for destination IP
- **502 Bad Gateway**: upstream connection failed (timeout, refused, etc.)

## Code Structure

```
src/app.ts
├── Config loading (dotenv)
├── Helper functions
│   ├── parseHostPort() - parses "host:port" from CONNECT
│   ├── isPrivateIPv4/6() - RFC checks
│   ├── dohQuery() - HTTPS to Cloudflare DNS
│   ├── resolveHost() - DoH + caching
│   └── isAuthorized() - Basic auth validation
├── HTTP/HTTPS server
│   └── /health endpoint
└── CONNECT handler
    ├── Auth check → 407
    ├── Parse authority → 400
    ├── DoH resolve → cache
    ├── Private IP check → 403
    ├── Rate-limit check → 429
    ├── Establish upstream TCP
    ├── Reply 200 Connection Established
    └── Bidirectional pipe (client ↔ upstream)
```

## Environment Variables

| Var | Default | Description |
|-----|---------|-------------|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8080` or `8443` | Listen port (8443 if TLS enabled) |
| `PROXY_TLS_CERT` | - | Path to PEM cert (enables TLS) |
| `PROXY_TLS_KEY` | - | Path to PEM key (enables TLS) |
| `PROXY_USER` | - | Basic auth username (enables auth) |
| `PROXY_PASS` | - | Basic auth password (enables auth) |
| `DOH_ENABLED` | `1` | Enable DoH (0=system DNS) |
| `DOH_URL` | `https://cloudflare-dns.com/dns-query` | DoH endpoint |
| `DOH_TIMEOUT_MS` | `3000` | DoH request timeout |
| `DNS_CACHE_TTL_MS` | `60000` | Cache TTL |
| `BLOCK_PRIVATE` | `1` | Block private IPs (0=allow) |
| `CONNECT_TIMEOUT_MS` | `10000` | Upstream connect timeout |
| `IDLE_TIMEOUT_MS` | `120000` | Idle timeout |
| `MAX_CONNS_PER_IP` | `50` | Per-IP connection cap |

## Testing Checklist

- [ ] Health endpoint returns 200
- [ ] CONNECT without auth → 407
- [ ] CONNECT with wrong auth → 407
- [ ] CONNECT with valid auth to example.com → 200 + tunnel works
- [ ] CONNECT to 127.0.0.1 → 403 (private IP blocked)
- [ ] CONNECT to 10.0.0.1 → 403
- [ ] CONNECT to 192.168.1.1 → 403
- [ ] 60 parallel connections to same IP → some get 429
- [ ] Idle tunnel for 120s → auto-closed
- [ ] DoH cache hit (2nd request to same domain is instant)

## Performance Notes

- Single-threaded (Node.js event loop)
- In-memory DNS cache (lost on restart)
- In-memory connection counts (lost on restart)
- No connection pooling (each CONNECT = new TCP socket)
- Typical throughput: ~1000 req/s on modern hardware (limited by DoH latency on cache miss)

## Production Hardening (Not Implemented)

- Persistent cache (Redis)
- Structured logging (JSON, correlationId per request)
- Metrics (Prometheus: active_connections, request_rate, error_rate, doh_latency)
- Graceful shutdown (drain connections before exit)
- Health checks (liveness, readiness)
- Let's Encrypt automation (certbot or ACME client)
- Firewall rules (iptables/nftables to restrict access)
- DoS protection (global rate-limit, connection limits)
- Multi-process (cluster mode or PM2)
