# Secure Web Proxy

A learning project that builds an HTTPS forward proxy from scratch in TypeScript. Shows how proxies work under the hood: CONNECT tunneling, TLS termination, Basic auth, DNS-over-HTTPS, IP blocking, and rate limiting.

## Why This Matters

- **Privacy**: routes traffic through an encrypted proxy (TLS client-to-proxy + TLS proxy-to-destination)
- **Security**: blocks private IPs (SSRF prevention), uses DoH (DNS privacy), enforces auth
- **Learning**: hands-on implementation of HTTP CONNECT, TLS, DoH RFC 8484, rate-limiting

## Features (Steps 1-5)

- ✅ HTTP CONNECT tunneling (RFC 7231)
- ✅ Optional TLS (client-to-proxy encryption)
- ✅ Basic authentication (RFC 7617)
- ✅ DNS-over-HTTPS with caching (Cloudflare JSON API)
- ✅ Private IP blocking (RFC 1918, loopback, link-local, multicast)
- ✅ Per-IP connection rate-limiting
- ✅ Configurable timeouts (connect, idle)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Generate local TLS cert (optional, for HTTPS proxy mode)
mkcert -install && mkcert 127.0.0.1
# or: openssl req -x509 -newkey rsa:2048 -nodes -keyout 127.0.0.1-key.pem -out 127.0.0.1.pem -days 365 -subj "/CN=127.0.0.1"

# 3. Create .env (or use the included one)
cp .env.example .env  # if you have .env.example, otherwise create .env

# 4. Run the proxy
npm run dev

# 5. Test health endpoint
curl -v https://127.0.0.1:8443/health --insecure

# 6. Test proxy (with auth)
curl -v --proxy https://127.0.0.1:8443 --proxy-user myuser:mypassword --proxy-insecure https://example.com
```

## Configuration (.env)

All settings are optional with sane defaults:

```bash
# Network
HOST=127.0.0.1           # bind address (local-only by default)
PORT=8443                # listen port (8080 for HTTP, 8443 for HTTPS)

# TLS (enables HTTPS proxy mode when both are set)
PROXY_TLS_CERT=./127.0.0.1.pem
PROXY_TLS_KEY=./127.0.0.1-key.pem

# Auth (enables Basic auth when both are set)
PROXY_USER=myuser
PROXY_PASS=mypassword

# DNS-over-HTTPS
DOH_ENABLED=1            # 1=on, 0=use system DNS
DOH_URL=https://cloudflare-dns.com/dns-query
DOH_TIMEOUT_MS=3000
DNS_CACHE_TTL_MS=60000

# Security
BLOCK_PRIVATE=1          # 1=block RFC1918/loopback/etc, 0=allow all

# Limits
CONNECT_TIMEOUT_MS=10000      # max time to establish upstream connection
IDLE_TIMEOUT_MS=120000        # max idle time before closing tunnel
MAX_CONNS_PER_IP=50           # per-destination IP connection cap
```

## Testing

```bash
# Health check (no auth required)
curl -v https://127.0.0.1:8443/health --insecure

# Proxy with auth (HTTPS mode)
curl -v --proxy https://127.0.0.1:8443 \
  --proxy-user myuser:mypassword \
  --proxy-insecure \
  https://example.com

# HTTP proxy mode (no TLS to proxy, but still tunnels HTTPS sites)
# In .env: comment out PROXY_TLS_CERT/KEY, set PORT=8080
curl -v -x http://127.0.0.1:8080 --proxy-user myuser:mypassword https://example.com

# Test private IP blocking (should get 403)
curl -v --proxy https://127.0.0.1:8443 \
  --proxy-user myuser:mypassword \
  --proxy-insecure \
  https://127.0.0.1/

# Test rate-limit (fires 60 parallel requests, some should 429)
for i in {1..60}; do
  curl -s --proxy https://127.0.0.1:8443 \
    --proxy-user myuser:mypassword \
    --proxy-insecure \
    https://example.com &
done
wait
```

## Browser Setup

1. **Firefox**: Settings → Network → Connection Settings → Manual proxy
   - HTTPS Proxy: `127.0.0.1` Port: `8443`
   - Check "Use this proxy for all protocols"
   - You'll be prompted for proxy credentials on first request

2. **Chrome/Edge**: System proxy or `--proxy-server=https://127.0.0.1:8443`

3. **macOS/Linux system-wide**:
   ```bash
   # Set
   export https_proxy=https://myuser:mypassword@127.0.0.1:8443
   # Unset
   unset https_proxy
   ```

## How It Works

1. **CONNECT tunnel**: Client sends `CONNECT example.com:443`, proxy establishes TCP to destination, replies `200 Connection Established`, then blindly pipes bytes (end-to-end TLS remains intact).

2. **DoH**: Proxy resolves hostnames via HTTPS to Cloudflare's JSON API (RFC 8484 wire format not used, JSON is simpler). Caches results for 60s.

3. **Private IP block**: After DoH resolution, checks if IP is in RFC 1918, loopback, link-local, multicast, or reserved ranges. Returns 403 if blocked.

4. **Rate-limit**: Counts active connections per destination IP. Returns 429 if limit exceeded.

5. **Timeouts**: 10s to establish upstream connection, 120s idle (no traffic) before closing tunnel.

## Limitations (Educational Project)

- ❌ No HTTP proxy support (only CONNECT for HTTPS tunneling)
- ❌ No SNI inspection/filtering
- ❌ No logging/metrics (add your own)
- ❌ Single-process (no clustering)
- ❌ In-memory state (DNS cache, connection counts lost on restart)
- ❌ Not production-ready (no monitoring, graceful shutdown, error recovery)

## Security Warnings

- **Local-only by default** (HOST=127.0.0.1). Do NOT expose to internet without additional hardening.
- **Self-signed certs** are for local dev only. Use Let's Encrypt (Step 6, not implemented) for production.
- **Basic auth** sends credentials in Base64 (not encrypted). Only use over TLS.
- **No request logging** = no audit trail. Add logging for production use.


## License

MIT - see LICENSE file

## Credits

Built for learning. Uses Node.js built-ins (http, https, net), dotenv for config, TypeScript for type safety.