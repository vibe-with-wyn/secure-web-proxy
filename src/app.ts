import http from 'http';
import net from 'net';
import { AddressInfo } from 'net';

const PORT = Number(process.env.PORT || 8080);
const HOST = '127.0.0.1'; // local-only for Step 1

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

const server = http.createServer((req, res) => {
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

// HTTPS tunneling via CONNECT
server.on('connect', (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
  const authority = req.url || '';
  const parsed = parseHostPort(authority);
  if (!parsed) {
    clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    clientSocket.destroy();
    return;
  }
  const { host, port } = parsed;

  const CONNECT_TIMEOUT_MS = 10_000;
  const IDLE_TIMEOUT_MS = 120_000;

  const upstream = net.connect({ host, port });
  const connectTimer = setTimeout(() => {
    upstream.destroy(new Error('connect_timeout'));
  }, CONNECT_TIMEOUT_MS);

  upstream.setNoDelay(true);

  upstream.once('connect', () => {
    clearTimeout(connectTimer);

    // Acknowledge tunnel to client
    clientSocket.write(
      'HTTP/1.1 200 Connection Established\r\n' +
      'Proxy-Agent: swp-step1\r\n' +
      '\r\n'
    );

    // Forward any buffered data
    if (head && head.length > 0) {
      upstream.write(head);
    }

    // Bidirectional piping
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);

    // Idle timeouts
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
    if (!clientSocket.destroyed) clientSocket.end();
  });
  clientSocket.on('close', () => {
    if (!upstream.destroyed) upstream.end();
  });
});

// Startup
server.listen(PORT, HOST, () => {
  const addr = server.address() as AddressInfo;
  console.log(`Step 1 proxy listening on http://${addr.address}:${addr.port} (CONNECT + /health). Local-only.`);
});