# Secure Web Proxy

This project teaches how to build a secure HTTPS forward proxy step-by-step.

Milestones:
- Step 1: local HTTP CONNECT proxy (no TLS/auth)
- Step 2: add TLS
- Step 3: add auth (Basic)
- Step 4: DoH + private IP blocking
- Step 5: timeouts, rate-limits, tests
- Step 6: public deployment (domain + Let's Encrypt) + firewall

Step 1 (local):
1) npm install
2) npm run dev
3) Set system/browser proxy to 127.0.0.1:8080 (HTTP proxy)
4) Visit https://example.com

Endpoints:
- GET http://127.0.0.1:8080/health -> 200 OK

Security note:
- Step 1 binds to 127.0.0.1 only. Do NOT expose to the internet.