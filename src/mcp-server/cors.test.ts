import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { applyCors, corsPolicy } from './cors.js';

describe('corsPolicy with OAuth enabled', () => {
  it('allows any origin and exposes the headers browser MCP clients need', () => {
    const d = corsPolicy({ oauthEnabled: true, origin: 'https://app.example', host: 'wa.example.com' });
    expect(d.allowed).toBe(true);
    if (!d.allowed) return;
    expect(d.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(d.headers['Access-Control-Expose-Headers']).toContain('mcp-session-id');
    expect(d.headers['Access-Control-Expose-Headers']).toContain('WWW-Authenticate');
  });
});

describe('corsPolicy in no-auth mode', () => {
  it('lets non-browser clients (no Origin) through without CORS headers', () => {
    const d = corsPolicy({ oauthEnabled: false, host: '127.0.0.1:8080' });
    expect(d).toEqual({ allowed: true, headers: {} });
  });

  it('allows loopback hosts, including IPv6', () => {
    for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080']) {
      expect(corsPolicy({ oauthEnabled: false, host }).allowed).toBe(true);
    }
  });

  it('echoes a loopback origin instead of using a wildcard', () => {
    const d = corsPolicy({ oauthEnabled: false, host: '127.0.0.1:8080', origin: 'http://localhost:6274' });
    expect(d.allowed).toBe(true);
    if (!d.allowed) return;
    expect(d.headers['Access-Control-Allow-Origin']).toBe('http://localhost:6274');
    expect(d.headers.Vary).toBe('Origin');
  });

  it('refuses a web page on another origin', () => {
    expect(corsPolicy({ oauthEnabled: false, host: '127.0.0.1:8080', origin: 'https://evil.example' }).allowed).toBe(false);
    expect(corsPolicy({ oauthEnabled: false, host: '127.0.0.1:8080', origin: 'null' }).allowed).toBe(false);
  });

  it('refuses a non-loopback Host (DNS rebinding)', () => {
    expect(corsPolicy({ oauthEnabled: false, host: 'evil.example:8080' }).allowed).toBe(false);
    expect(corsPolicy({ oauthEnabled: false }).allowed).toBe(false);
  });
});

describe('applyCors on a real response', () => {
  let server: Server;
  let base: string;
  let oauthEnabled = false;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (!applyCors(req, res, oauthEnabled)) return;
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();
      res.writeHead(200).end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());

  it('answers a preflight from a foreign origin with 403 and no CORS headers in no-auth mode', async () => {
    oauthEnabled = false;
    const res = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('still serves plain clients and loopback browser origins in no-auth mode', async () => {
    oauthEnabled = false;
    expect((await fetch(`${base}/mcp`)).status).toBe(200);
    const res = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:6274' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:6274');
  });

  it('keeps the wildcard when OAuth is enabled', async () => {
    oauthEnabled = true;
    const res = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
