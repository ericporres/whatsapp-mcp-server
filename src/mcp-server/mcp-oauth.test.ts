import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpOAuth, generateCredentials } from './mcp-oauth.js';

const REDIRECT = 'https://client.example/callback';

let dir: string;
let server: Server;
let base: string;
let creds: { client_id: string; client_secret: string };
let oauth: McpOAuth;
const logs: string[] = [];

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function authorize(challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: creds.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...extra,
  });
  return fetch(`${base}/authorize?${q}`, { redirect: 'manual' });
}

async function token(body: Record<string, string>) {
  return fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

async function fullFlow() {
  const { verifier, challenge } = pkce();
  const loc = new URL((await authorize(challenge)).headers.get('location')!);
  const res = await token({
    grant_type: 'authorization_code',
    code: loc.searchParams.get('code')!,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: creds.client_id,
    client_secret: creds.client_secret,
  });
  return res.json() as Promise<{ access_token: string; refresh_token: string }>;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-oauth-'));
  const credPath = join(dir, '.mcp-credentials.json');
  generateCredentials(credPath);
  creds = JSON.parse(readFileSync(credPath, 'utf-8'));

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (await oauth.handleAuthRoute(req, res, url)) return;
    if (url.pathname === '/mcp') {
      if (!oauth.validateBearer(req)) return oauth.sendUnauthorized(res);
      res.writeHead(200).end('ok');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  oauth = new McpOAuth({ credentialsPath: credPath, issuerUrl: base, log: (m) => logs.push(m) });
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('credentials', () => {
  it('writes the credentials file with mode 0600', () => {
    expect(statSync(join(dir, '.mcp-credentials.json')).mode & 0o777).toBe(0o600);
  });
  it('refuses to overwrite existing credentials', () => {
    expect(() => generateCredentials(join(dir, '.mcp-credentials.json'))).toThrow(/already exists/);
  });
});

describe('metadata', () => {
  it('serves authorization server and protected resource metadata', async () => {
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as.token_endpoint).toBe(`${base}/token`);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(pr.resource).toBe(`${base}/mcp`);
  });
  it('/register returns the client_id but never the secret', async () => {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'test', redirect_uris: [REDIRECT] }),
    });
    const text = await res.text();
    expect(res.status).toBe(201);
    expect(JSON.parse(text).client_id).toBe(creds.client_id);
    expect(text).not.toContain(creds.client_secret);
  });
});

describe('/mcp protection', () => {
  it('rejects requests without a token, with resource metadata in WWW-Authenticate', async () => {
    const res = await fetch(`${base}/mcp`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });
  it('rejects an unknown token', async () => {
    const res = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${'0'.repeat(64)}` } });
    expect(res.status).toBe(401);
  });
  it('accepts a token from the full PKCE flow', async () => {
    const { access_token } = await fullFlow();
    const res = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${access_token}` } });
    expect(res.status).toBe(200);
  });
});

describe('authorization code grant', () => {
  it('rejects an unknown client_id without redirecting', async () => {
    const res = await authorize(pkce().challenge, { client_id: 'mcp_attacker' });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });
  it('requires PKCE S256', async () => {
    const res = await authorize('x', { code_challenge_method: 'plain' });
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });
  it('rejects a wrong client_secret', async () => {
    const { verifier, challenge } = pkce();
    const code = new URL((await authorize(challenge)).headers.get('location')!).searchParams.get('code')!;
    const res = await token({
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT,
      client_id: creds.client_id, client_secret: 'f'.repeat(64),
    });
    expect(res.status).toBe(401);
  });
  it('rejects a wrong code_verifier and burns the code', async () => {
    const { verifier, challenge } = pkce();
    const code = new URL((await authorize(challenge)).headers.get('location')!).searchParams.get('code')!;
    const base = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: creds.client_id, client_secret: creds.client_secret };
    expect((await token({ ...base, code_verifier: pkce().verifier })).status).toBe(400);
    expect((await token({ ...base, code_verifier: verifier })).status).toBe(400); // single use
  });
  it('rejects a redirect_uri mismatch', async () => {
    const { verifier, challenge } = pkce();
    const code = new URL((await authorize(challenge)).headers.get('location')!).searchParams.get('code')!;
    const res = await token({
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'https://evil.example/cb',
      client_id: creds.client_id, client_secret: creds.client_secret,
    });
    expect(res.status).toBe(400);
  });
  it('rejects oversized bodies', async () => {
    const res = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a='.padEnd(100_000, 'x'),
    }).catch(() => null);
    expect(res === null || res.status >= 400).toBe(true);
  });
});

describe('hardening', () => {
  it('rejects non-https redirect URIs other than localhost', async () => {
    for (const uri of ['javascript:alert(1)', 'http://evil.example/cb', 'myapp://cb']) {
      const res = await authorize(pkce().challenge, { redirect_uri: uri });
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    }
    const ok = await authorize(pkce().challenge, { redirect_uri: 'http://localhost:9999/cb' });
    expect(ok.status).toBe(302);
  });
  it('rejects unsupported scopes', async () => {
    const res = await authorize(pkce().challenge, { scope: 'admin' });
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope');
  });
  it('requires redirect_uri at the token endpoint', async () => {
    const { verifier, challenge } = pkce();
    const code = new URL((await authorize(challenge)).headers.get('location')!).searchParams.get('code')!;
    const res = await token({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      client_id: creds.client_id, client_secret: creds.client_secret,
    });
    expect(res.status).toBe(400);
  });
  it('caps pending authorization codes', async () => {
    // Sequential: 150 parallel connections trip macOS socket limits (fetch failed).
    const statuses: number[] = [];
    for (let i = 0; i < 150; i++) statuses.push((await authorize(pkce().challenge)).status);
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 302).length).toBeLessThanOrEqual(100);
  });
});

describe('diagnostics', () => {
  it('logs why a token request was rejected when no secret was sent', async () => {
    logs.length = 0;
    const res = await token({
      grant_type: 'authorization_code', code: 'x', code_verifier: 'y', redirect_uri: REDIRECT,
      client_id: creds.client_id,
    });
    expect(res.status).toBe(401);
    const out = logs.join('\n');
    expect(out).toContain('secret_in_body=false');
    expect(out).toContain('basic_auth_header=false');
    expect(out).toContain('invalid_client');
  });

  it('notes that a secret arrived but never logs its value or the client_id', async () => {
    logs.length = 0;
    const wrong = 'f'.repeat(64);
    await token({
      grant_type: 'authorization_code', code: 'x', code_verifier: 'y', redirect_uri: REDIRECT,
      client_id: creds.client_id, client_secret: wrong,
    });
    const out = logs.join('\n');
    expect(out).toContain('secret_in_body=true');
    expect(out).not.toContain(wrong);
    expect(out).not.toContain(creds.client_secret);
    expect(out).not.toContain(creds.client_id);
  });
});

describe('log safety', () => {
  it('does not let grant_type inject log lines', async () => {
    logs.length = 0;
    await token({ grant_type: 'authorization_code\nToken request rejected: forged', client_id: creds.client_id });
    const line = logs.find((l) => l.startsWith('Token request: '))!;
    expect(line).not.toContain('\n');
    expect(logs.filter((l) => l.includes('forged') && l.startsWith('Token request rejected'))).toHaveLength(0);
  });
});

describe('refresh token grant', () => {
  it('revokes the paired access token on refresh', async () => {
    // Pending-code cap from the previous test: let those codes expire from the map.
    (oauth as unknown as { authCodes: Map<string, unknown> }).authCodes.clear();
    const { access_token, refresh_token } = await fullFlow();
    const res = await token({ grant_type: 'refresh_token', refresh_token, client_id: creds.client_id, client_secret: creds.client_secret });
    expect(res.status).toBe(200);
    const old = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${access_token}` } });
    expect(old.status).toBe(401);
  });
  it('rotates refresh tokens (old one stops working)', async () => {
    const { refresh_token } = await fullFlow();
    const body = { grant_type: 'refresh_token', refresh_token, client_id: creds.client_id, client_secret: creds.client_secret };
    const first = await token(body);
    expect(first.status).toBe(200);
    expect((await first.json()).access_token).toMatch(/^[0-9a-f]{64}$/);
    expect((await token(body)).status).toBe(400);
  });
});

describe('token store', () => {
  it('persists with mode 0600 and survives a restart', async () => {
    const { access_token } = await fullFlow();
    const store = join(dir, '.mcp-token-store.json');
    expect(statSync(store).mode & 0o777).toBe(0o600);
    const restarted = new McpOAuth({ credentialsPath: join(dir, '.mcp-credentials.json'), issuerUrl: base, log: () => {} });
    const fakeReq = { headers: { authorization: `Bearer ${access_token}` } } as never;
    expect(restarted.validateBearer(fakeReq)).not.toBeNull();
  });
});
