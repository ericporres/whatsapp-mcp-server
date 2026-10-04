import type { IncomingMessage, ServerResponse } from 'node:http';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const ALLOW_METHODS = 'GET, POST, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version';
const EXPOSE_HEADERS = 'mcp-session-id, WWW-Authenticate';

export type CorsDecision =
  | { allowed: true; headers: Record<string, string> }
  | { allowed: false; reason: string };

function hostnameOf(urlLike: string | undefined, prefix: string): string | null {
  if (!urlLike) return null;
  try {
    return new URL(`${prefix}${urlLike}`).hostname;
  } catch {
    return null;
  }
}

const isLoopbackHost = (host?: string) => LOOPBACK_HOSTNAMES.has(hostnameOf(host, 'http://') ?? '');
const isLoopbackOrigin = (origin: string) => LOOPBACK_HOSTNAMES.has(hostnameOf(origin, '') ?? '');

/**
 * Cross-origin policy for the HTTP transport.
 *
 * With OAuth enabled every /mcp request needs a Bearer token (never a cookie),
 * so a page in someone's browser has no ambient credential to abuse and a
 * wildcard origin is safe and lets browser-based MCP clients connect.
 *
 * Without OAuth (MCP_ALLOW_NO_AUTH=1) the server is open to anything that can
 * reach it, and its tools can send messages. A wildcard there would let any web
 * page drive it. So only loopback origins get CORS headers, and requests whose
 * Host or Origin is not loopback are refused (this also blocks DNS rebinding).
 * Non-browser clients send no Origin and are unaffected.
 */
export function corsPolicy(opts: { oauthEnabled: boolean; origin?: string; host?: string }): CorsDecision {
  const common = {
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Expose-Headers': EXPOSE_HEADERS,
  };
  if (opts.oauthEnabled) {
    return { allowed: true, headers: { 'Access-Control-Allow-Origin': '*', ...common } };
  }
  if (!isLoopbackHost(opts.host)) {
    return { allowed: false, reason: 'Host is not a loopback address (no-auth mode is local only)' };
  }
  if (opts.origin === undefined) return { allowed: true, headers: {} };
  if (!isLoopbackOrigin(opts.origin)) {
    return { allowed: false, reason: 'Cross-origin requests are refused in no-auth mode' };
  }
  return { allowed: true, headers: { 'Access-Control-Allow-Origin': opts.origin, Vary: 'Origin', ...common } };
}

/** Apply the policy to a response. Returns false if the request was refused and the response ended. */
export function applyCors(req: IncomingMessage, res: ServerResponse, oauthEnabled: boolean): boolean {
  const decision = corsPolicy({ oauthEnabled, origin: req.headers.origin, host: req.headers.host });
  if (!decision.allowed) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden', error_description: decision.reason }));
    return false;
  }
  for (const [name, value] of Object.entries(decision.headers)) res.setHeader(name, value);
  return true;
}
