/**
 * HTTP entrypoint for WhatsApp MCP server.
 * Use this for Cowork (Claude Desktop) via a cloudflared tunnel.
 *
 * Supports multiple concurrent MCP sessions — each `initialize` handshake
 * creates a fresh Server + Transport pair. All sessions share a single
 * WhatsApp client (which is already serialized via AsyncMutex).
 *
 * Claude Code uses index.ts (stdio transport).
 * Cowork uses this file (StreamableHTTP transport) + cloudflared tunnel for HTTPS.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getWhatsAppClient } from './whatsapp.js';
import { registerTools } from './tools.js';
import { McpOAuth } from './mcp-oauth.js';
import { applyCors } from './cors.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Require an explicit port. Pick any free high port on your machine — the
// server binds to 127.0.0.1 only; a tunnel or reverse proxy handles exposure.
const rawPort = process.env.MCP_HTTP_PORT;
if (!rawPort) {
  process.stderr.write(
    '[whatsapp-mcp-http] ERROR: MCP_HTTP_PORT is required. Set it to any free high port.\n',
  );
  process.exit(1);
}
const PORT = parseInt(rawPort, 10);
if (!Number.isFinite(PORT) || PORT <= 0 || PORT > 65535) {
  process.stderr.write(
    `[whatsapp-mcp-http] ERROR: MCP_HTTP_PORT="${rawPort}" is not a valid port.\n`,
  );
  process.exit(1);
}
const SESSION_NAME = process.env.WHATSAPP_SESSION_NAME ?? 'default';

// OAuth: enabled whenever a credentials file exists. MCP_PUBLIC_URL is the
// HTTPS origin your tunnel serves (issuer for OAuth metadata). MCP_TUNNEL_URL
// is accepted as an alias. Neither value belongs in source control.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREDENTIALS_PATH = resolve(
  process.env.MCP_OAUTH_CREDENTIALS ?? join(PACKAGE_ROOT, '.mcp-credentials.json'),
);
const PUBLIC_URL = process.env.MCP_PUBLIC_URL || process.env.MCP_TUNNEL_URL || undefined;
// Running without auth must be an explicit choice: the server can't tell whether a tunnel is in front of it.
const ALLOW_NO_AUTH = process.env.MCP_ALLOW_NO_AUTH === '1';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] [whatsapp-mcp-http] ${message}\n`);
}

function logError(message: string, error?: unknown): void {
  const detail = error instanceof Error ? error.message : String(error ?? '');
  const ts = new Date().toISOString();
  process.stderr.write(
    `[${ts}] [whatsapp-mcp-http] ERROR: ${message}${detail ? ` -- ${detail}` : ''}\n`,
  );
}

// ---------------------------------------------------------------------------
// Session management — one MCP Server + Transport per client session
// ---------------------------------------------------------------------------

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  createdAt: number;
}

const sessions = new Map<string, McpSession>();

// Clean up stale sessions every 10 minutes (sessions older than 30 minutes)
const SESSION_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      log(`Cleaning up stale session ${id}`);
      session.transport.close?.();
      session.server.close?.();
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`Starting WhatsApp MCP HTTP server (session: ${SESSION_NAME})`);

  // --- Auth (fail fast, before pairing WhatsApp) ---
  let oauth: McpOAuth | null = null;
  if (existsSync(CREDENTIALS_PATH)) {
    if (!PUBLIC_URL) {
      logError('OAuth credentials found but MCP_PUBLIC_URL is not set. Set it to your tunnel\'s https:// origin.');
      process.exit(1);
    }
    try {
      oauth = new McpOAuth({
        credentialsPath: CREDENTIALS_PATH,
        issuerUrl: PUBLIC_URL,
        serverName: 'whatsapp-mcp',
        log: (msg) => log(`[oauth] ${msg}`),
      });
    } catch (error) {
      logError('Failed to initialize OAuth', error);
      process.exit(1);
    }
  } else if (PUBLIC_URL) {
    // A public URL with no credentials means the tunnel would be wide open. Refuse.
    logError(
      `MCP_PUBLIC_URL is set but no OAuth credentials exist at ${CREDENTIALS_PATH}. ` +
        'Run: node dist/mcp-server/mcp-oauth.js --generate .mcp-credentials.json',
    );
    process.exit(1);
  } else if (ALLOW_NO_AUTH) {
    log('WARNING: OAuth disabled (MCP_ALLOW_NO_AUTH=1). /mcp is unauthenticated — never point a tunnel at this port.');
  } else {
    logError(
      `No OAuth credentials at ${CREDENTIALS_PATH}. Either generate them ` +
        '(node dist/mcp-server/mcp-oauth.js --generate .mcp-credentials.json) and set MCP_PUBLIC_URL, ' +
        'or set MCP_ALLOW_NO_AUTH=1 to run unauthenticated for local testing.',
    );
    process.exit(1);
  }

  // --- WhatsApp client (shared across all MCP sessions) ---
  const waClient = getWhatsAppClient(SESSION_NAME);
  log('Initializing WhatsApp client...');
  try {
    await waClient.initialize();
    log('WhatsApp client authenticated and ready');
  } catch (error) {
    logError('Failed to initialize WhatsApp client', error);
    process.exit(1);
  }

  /**
   * Create a new MCP server + transport pair for a session.
   * All sessions share the same WhatsApp client.
   */
  function createMcpSession(): McpSession {
    const server = new Server(
      { name: 'whatsapp-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    registerTools(server, waClient);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    return { transport, server, createdAt: Date.now() };
  }

  // --- HTTP server ---
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error) => {
      logError(`${req.method} ${req.url} unhandled`, error);
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Wildcard CORS only when OAuth protects /mcp; loopback-only without auth.
    if (!applyCors(req, res, Boolean(oauth))) return;

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    // OAuth endpoints (/.well-known/*, /authorize, /token, /register)
    if (oauth && (await oauth.handleAuthRoute(req, res, url))) return;

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        whatsapp: waClient.isReady() ? 'connected' : 'disconnected',
        activeSessions: sessions.size,
        oauth: oauth ? 'enabled' : 'disabled',
      }));
      return;
    }

    // MCP endpoint — Bearer token required when OAuth is enabled
    if (url.pathname === '/mcp') {
      if (oauth) {
        const authInfo = oauth.validateBearer(req);
        if (!authInfo) {
          oauth.sendUnauthorized(res, req.headers['authorization'] ? 'invalid_token' : undefined);
          return;
        }
        (req as IncomingMessage & { auth?: unknown }).auth = authInfo;
      }
      const existingSessionId = req.headers['mcp-session-id'] as string | undefined;

      // Route to existing session
      if (existingSessionId && sessions.has(existingSessionId)) {
        const session = sessions.get(existingSessionId)!;
        log(`${req.method} /mcp [session=${existingSessionId}]`);
        try {
          await session.transport.handleRequest(req, res);
        } catch (error) {
          logError(`${req.method} /mcp [session=${existingSessionId}] FAILED`, error);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        }
        return;
      }

      // New session (no session ID, or unknown session ID)
      if (!existingSessionId) {
        log(`${req.method} /mcp [new session]`);
        const session = createMcpSession();

        // Connect server to transport — must happen before handleRequest
        await session.server.connect(session.transport);

        // The transport will generate a session ID and set it in the response header.
        // We need to capture it after handleRequest.
        try {
          await session.transport.handleRequest(req, res);

          // Extract the session ID from the response headers
          const newSessionId = res.getHeader('mcp-session-id') as string | undefined;
          if (newSessionId) {
            sessions.set(newSessionId, session);
            log(`New session created: ${newSessionId} (total: ${sessions.size})`);
          }
        } catch (error) {
          logError(`${req.method} /mcp [new session] FAILED`, error);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        }
        return;
      }

      // Session ID provided but not found (stale/expired)
      log(`${req.method} /mcp [session=${existingSessionId}] NOT FOUND — client should re-initialize`);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Session not found. Send a new initialize request without a session ID.' },
        id: null,
      }));
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Use /mcp or /health' }));
  }

  httpServer.listen(PORT, '127.0.0.1', () => {
    log(`HTTP server listening on http://localhost:${PORT}/mcp`);
    log(oauth
      ? `OAuth issuer: ${PUBLIC_URL}`
      : 'Localhost only. Generate OAuth credentials before exposing this through a tunnel.');
  });

  // --- Graceful shutdown ---
  const shutdown = async (signal: string): Promise<void> => {
    log(`Received ${signal}, shutting down...`);
    httpServer.close();
    for (const [id, session] of sessions) {
      try { await session.server.close(); } catch { /* ignore */ }
    }
    sessions.clear();
    try { await waClient.destroy(); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  logError('Fatal error in main', error);
  process.exit(1);
});
