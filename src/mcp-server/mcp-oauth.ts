/**
 * OAuth 2.1 (Authorization Code + PKCE) for the HTTP transport.
 *
 * Single-user design: one pre-generated client_id/client_secret pair lives in a
 * local credentials file (never in code, never in git). MCP clients discover the
 * endpoints, run the PKCE flow, and send `Authorization: Bearer <token>` on every
 * /mcp request. No Express; plugs into a raw `http.createServer` handler.
 *
 * Endpoints served:
 *   /.well-known/oauth-authorization-server   (RFC 8414 metadata)
 *   /.well-known/oauth-protected-resource     (RFC 9728 metadata)
 *   /authorize   PKCE S256 required; auto-approves (single user)
 *   /token       authorization_code and refresh_token grants (refresh rotates)
 *   /register    returns the pre-configured client_id (never the secret)
 *
 * Security model: the client_id is public. Possession of the client_secret is
 * what gates token issuance, so keep the credentials file at mode 0600.
 *
 * Generate credentials:
 *   node dist/mcp-server/mcp-oauth.js --generate .mcp-credentials.json
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpOAuthConfig {
  /** Path to the credentials JSON ({ client_id, client_secret }). */
  credentialsPath: string;
  /** Public HTTPS origin clients reach the server on, e.g. https://mcp.example.com */
  issuerUrl: string;
  /** Realm / server name used in metadata and WWW-Authenticate. */
  serverName?: string;
  /** Access token lifetime in seconds (default 3600). */
  tokenTtlSeconds?: number;
  /** Refresh token lifetime in seconds (default 86400). Sliding: each refresh issues a new one. */
  refreshTokenTtlSeconds?: number;
  /** Scopes advertised (default ['mcp']). */
  scopesSupported?: string[];
  /** Where issued tokens persist across restarts (default: next to credentials). */
  tokenStorePath?: string;
  /** Logger (default: stderr). Never receives secrets or full tokens. */
  log?: (msg: string) => void;
}

interface Credentials {
  client_id: string;
  client_secret: string;
}

interface AuthorizationCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  /** epoch ms */
  expiresAt: number;
}

interface StoredToken {
  token: string;
  /** For refresh tokens: the access token issued alongside it (revoked on rotation). */
  pairedAccessToken?: string;
  clientId: string;
  scopes: string[];
  createdAt: number;
  /** epoch seconds */
  expiresAt: number;
}

export interface AuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
}

const MAX_BODY_BYTES = 64 * 1024;
const AUTH_CODE_TTL_MS = 60_000;
const MAX_PENDING_CODES = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Constant-time string comparison. */
function safeEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  return safeEqual(computed, codeChallenge);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function parseFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  return Object.fromEntries(new URLSearchParams(await readBody(req)));
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  return body ? JSON.parse(body) : {};
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Short, non-reversible label for logs. */
function tag(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// McpOAuth
// ---------------------------------------------------------------------------

export class McpOAuth {
  private readonly credentials: Credentials;
  private readonly issuer: string;
  private readonly serverName: string;
  private readonly tokenTtl: number;
  private readonly refreshTtl: number;
  private readonly scopesSupported: string[];
  private readonly tokenStorePath: string;
  private readonly log: (msg: string) => void;

  private authCodes = new Map<string, AuthorizationCode>();
  private accessTokens = new Map<string, StoredToken>();
  private refreshTokens = new Map<string, StoredToken>();
  private cleanupTimer: NodeJS.Timeout;

  constructor(config: McpOAuthConfig) {
    this.issuer = config.issuerUrl.replace(/\/+$/, '');
    this.serverName = config.serverName ?? 'mcp-server';
    this.tokenTtl = config.tokenTtlSeconds ?? 3600;
    this.refreshTtl = config.refreshTokenTtlSeconds ?? 86400;
    this.scopesSupported = config.scopesSupported ?? ['mcp'];
    this.log = config.log ?? ((msg) => process.stderr.write(`[mcp-oauth] ${msg}\n`));
    this.tokenStorePath =
      config.tokenStorePath ?? join(dirname(config.credentialsPath), '.mcp-token-store.json');

    if (!/^https?:\/\//.test(this.issuer)) {
      throw new Error(`issuerUrl must be an absolute URL, got "${config.issuerUrl}"`);
    }
    if (!existsSync(config.credentialsPath)) {
      throw new Error(
        `Credentials file not found: ${config.credentialsPath}\n` +
          `Generate one with: node dist/mcp-server/mcp-oauth.js --generate ${config.credentialsPath}`,
      );
    }
    const raw = JSON.parse(readFileSync(config.credentialsPath, 'utf-8'));
    if (typeof raw.client_id !== 'string' || typeof raw.client_secret !== 'string' ||
        !raw.client_id || raw.client_secret.length < 32) {
      throw new Error('Credentials file must contain client_id and a client_secret of at least 32 chars');
    }
    this.credentials = { client_id: raw.client_id, client_secret: raw.client_secret };
    this.log(`OAuth enabled (client ${tag(this.credentials.client_id)})`);

    this.loadTokens();
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Handle /authorize, /token, /register and /.well-known/*. Returns true if handled. */
  async handleAuthRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const isAuthPath =
      path === '/authorize' || path === '/token' || path === '/register' || path.startsWith('/.well-known/');
    if (!isAuthPath) return false;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return true;
    }

    try {
      if (path === '/.well-known/oauth-authorization-server') return this.handleMetadata(res), true;
      if (path.startsWith('/.well-known/oauth-protected-resource')) return this.handleResourceMetadata(res), true;
      if (path === '/authorize') return await this.handleAuthorize(req, res, url), true;
      if (path === '/token') return await this.handleToken(req, res), true;
      if (path === '/register' && req.method === 'POST') return await this.handleRegister(req, res), true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) json(res, 400, { error: 'invalid_request', error_description: msg });
      return true;
    }
    json(res, 404, { error: 'not_found' });
    return true;
  }

  /** Validate `Authorization: Bearer <token>`. Returns null if missing, unknown or expired. */
  validateBearer(req: IncomingMessage): AuthInfo | null {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    const stored = this.accessTokens.get(token);
    if (!stored) return null;
    if (Date.now() > stored.expiresAt * 1000) {
      this.accessTokens.delete(token);
      return null;
    }
    return { token: stored.token, clientId: stored.clientId, scopes: stored.scopes, expiresAt: stored.expiresAt };
  }

  /** 401 with a WWW-Authenticate header that points clients at the resource metadata. */
  sendUnauthorized(res: ServerResponse, error?: string): void {
    const parts = [
      `Bearer realm="${this.serverName}"`,
      `resource_metadata="${this.issuer}/.well-known/oauth-protected-resource"`,
    ];
    if (error) parts.push(`error="${error}"`);
    json(res, 401, { error: 'unauthorized', error_description: error ?? 'Bearer token required' }, {
      'WWW-Authenticate': parts.join(', '),
      'Access-Control-Expose-Headers': 'WWW-Authenticate',
    });
  }

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  private handleMetadata(res: ServerResponse): void {
    json(res, 200, {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: this.scopesSupported,
    }, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' });
  }

  private handleResourceMetadata(res: ServerResponse): void {
    json(res, 200, {
      resource: `${this.issuer}/mcp`,
      authorization_servers: [this.issuer],
      scopes_supported: this.scopesSupported,
      bearer_methods_supported: ['header'],
    }, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' });
  }

  private async handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const params =
      req.method === 'POST' && (req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')
        ? await parseFormBody(req)
        : Object.fromEntries(url.searchParams);

    const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state, scope } = params;

    // Validate redirect_uri before ever redirecting to it.
    let redirect: URL;
    try {
      redirect = new URL(redirect_uri ?? '');
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
      if (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && loopback)) throw new Error();
    } catch {
      json(res, 400, { error: 'invalid_request', error_description: 'redirect_uri must be an https URL (or http on localhost)' });
      return;
    }
    // Unknown client: do not redirect (RFC 6749 §4.1.2.1).
    if (!safeEqual(client_id, this.credentials.client_id)) {
      json(res, 400, { error: 'invalid_client', error_description: 'Unknown client_id' });
      return;
    }
    if (response_type !== 'code') {
      this.redirectError(res, redirect, 'unsupported_response_type', 'Only response_type=code is supported', state);
      return;
    }
    if (!code_challenge || code_challenge_method !== 'S256') {
      this.redirectError(res, redirect, 'invalid_request', 'PKCE with S256 is required', state);
      return;
    }
    const requested = scope ? scope.split(' ').filter(Boolean) : ['mcp'];
    const grantedScopes = requested.filter((s) => this.scopesSupported.includes(s));
    if (grantedScopes.length === 0) {
      this.redirectError(res, redirect, 'invalid_scope', `Supported scopes: ${this.scopesSupported.join(' ')}`, state);
      return;
    }

    // Bound memory: /register hands out the client_id, so anyone can hit this.
    const nowMs = Date.now();
    for (const [c, entry] of this.authCodes) if (nowMs > entry.expiresAt) this.authCodes.delete(c);
    if (this.authCodes.size >= MAX_PENDING_CODES) {
      json(res, 429, { error: 'temporarily_unavailable', error_description: 'Too many pending authorization requests' });
      return;
    }

    // Single user, so no consent screen. The code is useless without the client_secret.
    const code = randomBytes(32).toString('hex');
    this.authCodes.set(code, {
      clientId: client_id,
      codeChallenge: code_challenge,
      redirectUri: redirect.toString(),
      scopes: grantedScopes,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    redirect.searchParams.set('code', code);
    if (state) redirect.searchParams.set('state', state);
    res.writeHead(302, { Location: redirect.toString() });
    res.end();
    this.log('Authorization code issued');
  }

  private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method_not_allowed' });
      return;
    }
    const body = (req.headers['content-type'] ?? '').includes('application/json')
      ? ((await parseJsonBody(req)) as Record<string, string>)
      : await parseFormBody(req);

    if (!this.validateClient(body.client_id, body.client_secret)) {
      this.tokenError(res, 'invalid_client', 'Invalid client credentials');
      return;
    }

    if (body.grant_type === 'authorization_code') {
      const stored = this.authCodes.get(body.code ?? '');
      if (!stored) return this.tokenError(res, 'invalid_grant', 'Authorization code not found or expired');
      this.authCodes.delete(body.code); // single use
      if (Date.now() > stored.expiresAt) return this.tokenError(res, 'invalid_grant', 'Authorization code expired');
      // RFC 6749 §4.1.3: redirect_uri must match when it was sent to /authorize.
      let sent = '';
      try { sent = new URL(body.redirect_uri ?? '').toString(); } catch { /* falls through to mismatch */ }
      if (sent !== stored.redirectUri) return this.tokenError(res, 'invalid_grant', 'redirect_uri mismatch');
      if (!body.code_verifier) return this.tokenError(res, 'invalid_request', 'code_verifier is required');
      if (!verifyPkceS256(body.code_verifier, stored.codeChallenge)) {
        return this.tokenError(res, 'invalid_grant', 'PKCE verification failed');
      }
      this.sendTokens(res, this.issueTokens(stored.clientId, stored.scopes));
      this.log('Access token issued (authorization_code)');
      return;
    }

    if (body.grant_type === 'refresh_token') {
      const stored = this.refreshTokens.get(body.refresh_token ?? '');
      if (!stored) return this.tokenError(res, 'invalid_grant', 'Refresh token not found or expired');
      this.refreshTokens.delete(body.refresh_token); // rotate
      if (stored.pairedAccessToken) this.accessTokens.delete(stored.pairedAccessToken);
      if (Date.now() > stored.expiresAt * 1000) {
        this.saveTokens();
        return this.tokenError(res, 'invalid_grant', 'Refresh token expired');
      }
      this.sendTokens(res, this.issueTokens(stored.clientId, stored.scopes));
      this.log('Access token issued (refresh_token)');
      return;
    }

    json(res, 400, { error: 'unsupported_grant_type', error_description: 'Supported: authorization_code, refresh_token' });
  }

  private async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Dynamic registration returns the single pre-configured client. The secret
    // is never returned; the user pastes it into their MCP client once.
    const body = await parseJsonBody(req);
    json(res, 201, {
      client_id: this.credentials.client_id,
      client_name: typeof body.client_name === 'string' ? body.client_name : this.serverName,
      redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    }, { 'Access-Control-Allow-Origin': '*' });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private validateClient(clientId: string | undefined, clientSecret: string | undefined): boolean {
    // Evaluate both comparisons so timing does not reveal which one failed.
    const idOk = safeEqual(clientId, this.credentials.client_id);
    const secretOk = safeEqual(clientSecret, this.credentials.client_secret);
    return idOk && secretOk;
  }

  private issueTokens(clientId: string, scopes: string[]) {
    const now = Math.floor(Date.now() / 1000);
    const access = randomBytes(32).toString('hex');
    const refresh = randomBytes(32).toString('hex');
    this.accessTokens.set(access, { token: access, clientId, scopes, createdAt: now, expiresAt: now + this.tokenTtl });
    this.refreshTokens.set(refresh, {
      token: refresh, clientId, scopes, createdAt: now, expiresAt: now + this.refreshTtl, pairedAccessToken: access,
    });
    this.saveTokens();
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.tokenTtl,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  private sendTokens(res: ServerResponse, tokens: object): void {
    json(res, 200, tokens, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  }

  private redirectError(res: ServerResponse, redirect: URL, error: string, description: string, state?: string): void {
    redirect.searchParams.set('error', error);
    redirect.searchParams.set('error_description', description);
    if (state) redirect.searchParams.set('state', state);
    res.writeHead(302, { Location: redirect.toString() });
    res.end();
  }

  private tokenError(res: ServerResponse, error: string, description: string): void {
    json(res, error === 'invalid_client' ? 401 : 400, { error, error_description: description });
  }

  private loadTokens(): void {
    try {
      if (!existsSync(this.tokenStorePath)) return;
      const raw = JSON.parse(readFileSync(this.tokenStorePath, 'utf-8'));
      const now = Math.floor(Date.now() / 1000);
      for (const [store, key] of [[this.accessTokens, 'accessTokens'], [this.refreshTokens, 'refreshTokens']] as const) {
        for (const [token, s] of Object.entries((raw[key] ?? {}) as Record<string, StoredToken>)) {
          if (s.expiresAt > now) store.set(token, s);
        }
      }
      this.log(`Rehydrated ${this.accessTokens.size} access / ${this.refreshTokens.size} refresh tokens`);
    } catch (err) {
      this.log(`Token rehydration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private saveTokens(): void {
    try {
      mkdirSync(dirname(this.tokenStorePath), { recursive: true });
      const tmp = `${this.tokenStorePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        savedAt: new Date().toISOString(),
        accessTokens: Object.fromEntries(this.accessTokens),
        refreshTokens: Object.fromEntries(this.refreshTokens),
      }), { encoding: 'utf-8', mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.tokenStorePath); // atomic replace
    } catch (err) {
      this.log(`Token save failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private cleanup(): void {
    const nowMs = Date.now();
    let cleaned = 0;
    for (const [code, c] of this.authCodes) if (nowMs > c.expiresAt) { this.authCodes.delete(code); cleaned++; }
    for (const store of [this.accessTokens, this.refreshTokens]) {
      for (const [t, s] of store) if (nowMs > s.expiresAt * 1000) { store.delete(t); cleaned++; }
    }
    if (cleaned > 0) this.saveTokens();
  }
}

// ---------------------------------------------------------------------------
// CLI: node dist/mcp-server/mcp-oauth.js --generate [path]
// ---------------------------------------------------------------------------

export function generateCredentials(outputPath: string): { client_id: string } {
  if (existsSync(outputPath)) {
    throw new Error(`${outputPath} already exists; delete it first to rotate credentials`);
  }
  const credentials = {
    client_id: `mcp_${randomBytes(16).toString('hex')}`,
    client_secret: randomBytes(32).toString('hex'),
    generated_at: new Date().toISOString(),
  };
  writeFileSync(outputPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  return { client_id: credentials.client_id };
}

const invokedDirectly =
  typeof process !== 'undefined' && process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly && process.argv[2] === '--generate') {
  const outputPath = process.argv[3] ?? '.mcp-credentials.json';
  try {
    const { client_id } = generateCredentials(outputPath);
    console.log(`Credentials written to ${outputPath} (mode 0600)`);
    console.log(`  client_id:     ${client_id}`);
    console.log('  client_secret: stored in the file; paste it into your MCP client once');
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
