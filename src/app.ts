// Optional .env loading; safe if dotenv isn’t installed yet
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
} catch (e: any) {
  if (e?.code !== 'MODULE_NOT_FOUND') throw e;
}

import http from 'http';
import net from 'net';
import { AddressInfo } from 'net';
import https from 'https';
import fs from 'fs';

const TLS_KEY = process.env.PROXY_TLS_KEY;
const TLS_CERT = process.env.PROXY_TLS_CERT;
const USE_TLS = !!(TLS_KEY && TLS_CERT);

// Add: Basic auth configuration
const AUTH_USER = process.env.PROXY_USER;
const AUTH_PASS = process.env.PROXY_PASS;
const AUTH_REQUIRED = !!(AUTH_USER && AUTH_PASS);

// Replace previous PORT and HOST with:
const PORT = Number(process.env.PORT || (USE_TLS ? 8443 : 8080));
const HOST = process.env.HOST || '127.0.0.1'; // local-only by default

// DoH + blocking + rate-limit configuration
const DOH_URL = process.env.DOH_URL || 'https://cloudflare-dns.com/dns-query';
const DOH_ENABLED = process.env.DOH_ENABLED !== '0';
const DOH_TIMEOUT_MS = Number(process.env.DOH_TIMEOUT_MS || 3000);
const DNS_CACHE_TTL_MS = Number(process.env.DNS_CACHE_TTL_MS || 60_000);
const BLOCK_PRIVATE = process.env.BLOCK_PRIVATE !== '0';
const MAX_CONNS_PER_IP = Number(process.env.MAX_CONNS_PER_IP || 50);

// Optional override of timeouts
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 10_000);
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 120_000);

// In-memory state
const dnsCache = new Map<string, { ips: string[]; expires: number }>();
const ipConnCount = new Map<string, number>();

// Helper: IPv4 checks
function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 0) return true; // 0.0.0.0/8
  if (a >= 224 && a <= 239) return true; // multicast
  if (a >= 240) return true; // reserved
  return false;
}

// Helper: IPv6 checks (prefix-based)
function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true; // unspecified/loopback
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // fc00::/7 ULA
  if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // fe80::/10 link-local
  if (v.startsWith('ff')) return true; // ff00::/8 multicast
  return false;
}

function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (!kind) return true; // invalid -> block
  if (!BLOCK_PRIVATE) return false;
  return kind === 4 ? isPrivateIPv4(ip) : isPrivateIPv6(ip);
}

// DoH query (Cloudflare JSON API compatible)
function dohQuery(name: string, type: 'A' | 'AAAA'): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const u = new URL(DOH_URL);
    u.searchParams.set('name', name);
    u.searchParams.set('type', type);
    const req = https.get(
      u,
      { headers: { accept: 'application/dns-json' } },
      (resp) => {
        let buf = '';
        resp.setEncoding('utf8');
        resp.on('data', (d) => (buf += d));
        resp.on('end', () => {
          try {
            const json = JSON.parse(buf);
            const answers = Array.isArray(json.Answer) ? json.Answer : [];
            const ips = answers
              .map((a: any) => a && a.data)
              .filter((d: any) => typeof d === 'string' && net.isIP(d) !== 0);
            resolve(ips);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.setTimeout(DOH_TIMEOUT_MS, () => req.destroy(new Error('doh_timeout')));
    req.on('error', reject);
  });
}

async function resolveHost(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host];
  const now = Date.now();
  const cached = dnsCache.get(host);
  if (cached && cached.expires > now && cached.ips.length) return cached.ips;

  if (!DOH_ENABLED) return []; // let system DNS happen via net.connect(host)

  const a = await dohQuery(host, 'A').catch(() => []);
  const aaaa = await dohQuery(host, 'AAAA').catch(() => []);
  const ips = [...a, ...aaaa];
  dnsCache.set(host, { ips, expires: now + DNS_CACHE_TTL_MS });
  return ips;
}

function pickIp(ips: string[]): string | null {
  if (!ips.length) return null;
  const v4 = ips.find((i) => net.isIP(i) === 4);
  return v4 || ips[0];
}

// Replace the existing server initialization with a conditional HTTPS/HTTP server:
const server: http.Server | https.Server = USE_TLS
  ? https.createServer(
      { key: fs.readFileSync(TLS_KEY!), cert: fs.readFileSync(TLS_CERT!) },
      (req, res) => {
        // Health check
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('ok');
          return;
        }
        // Only /health is allowed in Step 2. All other HTTP methods -> 405.
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('Method Not Allowed');
      }
    )
  : http.createServer((req, res) => {
      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      // Only /health is allowed in Step 1. All other HTTP methods -> 405.
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('Method Not Allowed');
    });

function parseHostPort(authority: string): { host: string; port: number } | null {
  // Accepts "host:port" or "[ipv6]:port" or "host" (defaults to 443)
  if (!authority) return null;
  let host = authority;
  let port = 443;
  const ipv6Match = authority.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6Match) {
    host = ipv6Match[1];
    port = Number(ipv6Match[2]);
  } else {
    const parts = authority.split(':');
    if (parts.length === 2) {
      host = parts[0];
      const p = Number(parts[1]);
      if (!Number.isFinite(p) || p <= 0 || p > 65535) return null;
      port = p;
    } else {
      host = authority;
      port = 443;
    }
  }
  if (!host) return null;
  return { host, port };
}

// Add: helper to check Basic auth on CONNECT
function isAuthorized(req: http.IncomingMessage): boolean {
  if (!AUTH_REQUIRED) return true;
  const hdr = req.headers['proxy-authorization'];
  if (!hdr || Array.isArray(hdr)) return false;
  const v = hdr.trim();
  if (!v.toLowerCase().startsWith('basic ')) return false;
  const raw = Buffer.from(v.slice(6).trim(), 'base64').toString('utf8');
  const i = raw.indexOf(':');
  if (i < 0) return false;
  const u = raw.slice(0, i);
  const p = raw.slice(i + 1);
  return u === AUTH_USER && p === AUTH_PASS;
}

// HTTPS tunneling via CONNECT (unchanged behavior, just agent name)
server.on('connect', async (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
  // Enforce Basic auth if configured
  if (!isAuthorized(req)) {
    try {
      clientSocket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\n' +
        'Proxy-Authenticate: Basic realm="Secure Web Proxy"\r\n' +
        'Content-Length: 0\r\n' +
        '\r\n'
      );
    } catch {}
    clientSocket.destroy();
    return;
  }

  const authority = req.url || '';
  const parsed = parseHostPort(authority);
  if (!parsed) {
    clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    clientSocket.destroy();
    return;
  }
  const { host, port } = parsed;

  // Resolve target via DoH (if enabled) and enforce private IP blocking
  let targetIp: string | null = null;
  const ips = await resolveHost(host).catch(() => []);
  if (ips.length) targetIp = pickIp(ips);

  // If host is a literal IP, validate directly
  if (!targetIp && net.isIP(host)) targetIp = host;

  // If still no IP and DoH is disabled, allow system DNS (but we can't pre-block)
  const willUseSystemDns = !targetIp && !DOH_ENABLED;

  if (targetIp && isBlockedIp(targetIp)) {
    try {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    } catch {}
    clientSocket.destroy();
    return;
  }

  // Per-IP connection rate-limit
  const keyIp = targetIp || host; // count by IP when known, else by hostname
  const current = (ipConnCount.get(keyIp) || 0) + 1;
  if (current > MAX_CONNS_PER_IP) {
    try {
      clientSocket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    } catch {}
    clientSocket.destroy();
    return;
  }
  ipConnCount.set(keyIp, current);

  const release = () => {
    const c = ipConnCount.get(keyIp) || 0;
    if (c <= 1) ipConnCount.delete(keyIp);
    else ipConnCount.set(keyIp, c - 1);
  };

  // Establish upstream TCP
  const upstream = willUseSystemDns
    ? net.connect({ host, port })
    : net.connect({ host: targetIp!, port });

  const connectTimer = setTimeout(() => {
    upstream.destroy(new Error('connect_timeout'));
  }, CONNECT_TIMEOUT_MS);

  upstream.setNoDelay(true);

  upstream.once('connect', () => {
    clearTimeout(connectTimer);

    clientSocket.write(
      'HTTP/1.1 200 Connection Established\r\n' +
      'Proxy-Agent: swp-step4\r\n' +
      '\r\n'
    );

    // Forward any buffered data
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);

    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy(new Error('upstream_idle_timeout')));
    clientSocket.setTimeout(IDLE_TIMEOUT_MS, () => clientSocket.destroy(new Error('client_idle_timeout')));
  });

  function fail(status: number, message: string) {
    if (!clientSocket.destroyed) {
      try {
        clientSocket.write(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
      } catch {}
      clientSocket.destroy();
    }
  }

  upstream.on('error', () => fail(502, 'Bad Gateway'));
  clientSocket.on('error', () => upstream.destroy());

  upstream.on('close', () => {
    release();
    if (!clientSocket.destroyed) clientSocket.end();
  });
  clientSocket.on('close', () => {
    release();
    if (!upstream.destroyed) upstream.end();
  });
});

// Startup (log features)
server.listen(PORT, HOST, () => {
  const addr = server.address() as AddressInfo;
  const scheme = USE_TLS ? 'https' : 'http';
  const features: string[] = [];
  if (USE_TLS) features.push('TLS');
  if (AUTH_REQUIRED) features.push('Basic auth');
  if (DOH_ENABLED) features.push('DoH');
  if (BLOCK_PRIVATE) features.push('private-ip-block');
  if (MAX_CONNS_PER_IP > 0) features.push(`rate-limit:${MAX_CONNS_PER_IP}/ip`);
  const featuresText = features.length ? ` [${features.join(' + ')}]` : '';
  console.log(`Proxy listening on ${scheme}://${addr.address}:${addr.port}${featuresText} (CONNECT + /health). Local-only.`);
});