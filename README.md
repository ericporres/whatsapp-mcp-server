# WhatsApp MCP Server

**Your WhatsApp groups are a live intelligence network. This server lets Claude read them.**

An open-source [MCP](https://modelcontextprotocol.io) server that connects WhatsApp group chats to Claude (and any MCP-compatible AI client). It exposes seven tools for reading, searching, exporting, and replying to group conversations — plus a chat intelligence processor that extracts themes, opportunities, and actionable briefings from hundreds of messages.

I built this because I'm in a dozen professional WhatsApp groups — practitioners, investors, founders — where the information density is remarkable and the retrieval rate is abysmal. WhatsApp is optimized for *conversation*, not *comprehension*. This server fixes that.

---

## What It Does

**Seven MCP tools** give Claude (or any MCP client) structured access to your WhatsApp groups:

| Tool | What It Does |
|------|-------------|
| `whatsapp_list_groups` | Every group you belong to, sorted by recent activity |
| `whatsapp_get_messages` | Pull messages from any group with date range filtering |
| `whatsapp_group_info` | Metadata, participants, descriptions |
| `whatsapp_search_messages` | Keyword search across all groups or scoped to one |
| `whatsapp_export_chat` | Full export in WhatsApp's native `.txt` format |
| `whatsapp_send_message` | Send a message to any group (fuzzy name matching) |
| `whatsapp_reply_to_message` | Reply to a specific message as a quoted reply |

All tools support **fuzzy group name matching** — say "Book Club" and it finds "Book Club — Monthly Reads" using Levenshtein distance + substring matching. Nobody remembers exact group names. The system shouldn't require you to.

**A chat intelligence processor** turns raw messages into structured briefings:

- **Themes** — recurring topics tagged as hot, important, or emerging
- **Big ideas** — intellectually interesting or actionable, flagged by relevance to your work
- **Opportunities** — collaboration, speaking, partnerships, content ideas, business leads
- **Participation analysis** — what you engage with vs. skip, where you're visible vs. silent
- **Live threads** — active conversations worth jumping into, with suggested messages
- **Notable quotes** — standout lines worth saving or citing
- **Cross-group synthesis** — amplified signals, network nodes, compounding opportunities that only appear when you look across groups

The intelligence processor was inspired by [Scott Walker](https://github.com/Scottywalks22) (Founder & CEO, [UpShift Collective](https://www.upshiftcollective.com/)), who built the [Junto Group Analyzer](https://juntogroupanalyzer.lovable.app/) — a Claude skill he shared with our professional group that demonstrated the value of structured analysis over raw message consumption. His six-output framework (themes, big ideas, opportunities, participation analysis, live threads, notable quotes) proved the concept. This implementation extends it into a real-time MCP server with multi-group synthesis and configurable professional context.

---

## Architecture

```
┌─────────────┐     stdio      ┌───────────────┐    WebSocket    ┌──────────────┐
│ Claude Code │◄──────────────►│  MCP Server   │◄───────────────►│  WhatsApp    │
└─────────────┘                │  (index.ts)   │  Noise/Signal   │  Multi-Device│
                               └───────────────┘                 └──────────────┘
┌─────────────┐   HTTP/SSE     ┌───────────────┐
│   Cowork    │◄──────────────►│  HTTP Server  │  (same WhatsApp client)
│  (Desktop)  │  + cloudflared │ (http-server) │
└─────────────┘                └───────────────┘
```

Two transport modes, one WhatsApp client:

- **Claude Code** → stdio transport (`index.ts`) — direct pipe, single session
- **Cowork / Desktop** → StreamableHTTP transport (`http-server.ts`) — multi-session over HTTPS via Cloudflare tunnel

WhatsApp has no open API for group chats. The Business API is for customer messaging only. So this server uses [Baileys](https://github.com/WhiskeySockets/Baileys) — a direct WebSocket implementation of the WhatsApp Multi-Device protocol. No headless browser, no DOM scraping. Credentials and Signal Protocol keys persist to `.baileys_auth-<session>/` via `useMultiFileAuthState`, and the client reconnects in roughly two seconds after restarts.

Every read and write flows through an **AsyncMutex** that serializes WhatsApp operations behind a FIFO queue with a 100ms minimum interval. Baileys is reentrant-safe, but Signal Protocol session setup on unfamiliar recipients benefits from serialization, and the mutex keeps us well under WhatsApp's rate-limit thresholds without having to reason about them explicitly.

Messages stream in over the WebSocket and land in an **in-memory ring buffer** — 500 messages per group, JID-keyed — that the tool layer reads from. The buffer snapshots to `.baileys_auth-<session>/buffer.json` every 60 seconds and rehydrates on boot. This is load-bearing, not optional: the `messages.history-set` event that Baileys emits on first pairing is a one-shot, so on any reconnect the snapshot is the only thing standing between you and a cold buffer.

A **readiness gate** keeps this honest. Tool calls return `503 Service Unavailable` until the WebSocket has reached `connection.update → open` AND the buffer is warm (either `messages.history-set` has drained or 30 seconds have elapsed). The server never crashes into half-initialized state, and clients get a clean retryable error instead.

---

## Setup

### Prerequisites

- Node.js 22+
- A WhatsApp account (pairs via QR code on first run)

### Install and Build

```bash
git clone https://github.com/ericporres/whatsapp-mcp-server.git
cd whatsapp-mcp-server
npm install
npm run build
```

### First Run — QR Pairing

```bash
WHATSAPP_SESSION_NAME=my-session node dist/mcp-server/index.js
```

Scan the QR code with WhatsApp on your phone. Credentials and Signal keys cache in `.baileys_auth-my-session/` — you won't need to scan again unless you remove that directory or revoke the linked device from your phone.

### Register with Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/path/to/whatsapp-mcp-server/dist/mcp-server/index.js"],
      "env": {
        "WHATSAPP_SESSION_NAME": "my-session"
      }
    }
  }
}
```

Then ask Claude: *"What WhatsApp groups am I in?"*

### HTTP Server (Cowork / Remote Access)

The HTTP server supports multiple concurrent MCP sessions. Each `initialize` handshake spawns a fresh Server + Transport pair. All sessions share the single WhatsApp client (protected by the mutex). Sessions are tracked in a `Map<string, McpSession>` with 30-minute TTL and automatic cleanup.

Pick any free high port on your machine and set it as `MCP_HTTP_PORT`. The server binds to `127.0.0.1` only — a tunnel or reverse proxy is responsible for exposing it.

```bash
# pick any free high port on your machine
MCP_HTTP_PORT=<your-port> node dist/mcp-server/http-server.js
```

Expose over HTTPS with a Cloudflare tunnel:

```bash
# Quick tunnel (temporary URL)
cloudflared tunnel --url http://localhost:$MCP_HTTP_PORT

# Named tunnel (stable URL — recommended for persistent setups)
cloudflared tunnel run your-tunnel-name
```

### Securing the Tunnel

The server runs locally — your machine, your data, your paired WhatsApp session. But exposing it via a Cloudflare tunnel creates a public HTTPS endpoint. You should lock it down.

**Security tiers** (pick your comfort level):

| Tier | What It Does | Effort | Notes |
|------|-------------|--------|-------|
| **Obscurity** (default) | Long random subdomain — `mcp-random-words-123.yourdomain.com` | Zero — automatic | Treat the URL like a password |
| **IP Restriction** | Cloudflare Access policy allows only your IP | 5 min in [Zero Trust dashboard](https://one.dash.cloudflare.com/) | **See caveat below** |
| **Bearer Token** | Server validates `Authorization` header on every request | ~20 lines in `http-server.ts` | Requires client support for custom headers |
| **Email OTP** | Cloudflare Access sends a one-time code to your email | 10 min in Zero Trust dashboard | Works if your client handles browser auth flows |
| **OAuth/OIDC** (recommended for remote) | Full identity provider integration (Google, Okta, etc.) | 30 min — identity provider config | Best option for cloud-hosted MCP clients |

> **Important caveat about IP restriction:** Cloudflare Access IP whitelisting works well for clients that connect from your local machine (like Claude Code via stdio). However, cloud-hosted MCP clients — including Claude Cowork, and potentially other platforms that proxy MCP connections through their own infrastructure — connect from the *platform's* IP addresses, not yours. An IP whitelist locked to your home network will block these clients. I learned this the hard way: the tunnel was healthy, the server was running, and Cloudflare was dutifully rejecting every legitimate request from the desktop app I built this for.

**For local-only access (Claude Code, stdio):** Obscurity alone is sufficient — the tunnel isn't even needed since stdio is a direct pipe.

**For remote access (Cowork, Cursor, HTTP clients):** Obscurity is the practical baseline today. The random subdomain is effectively unguessable, and your tunnel URL should never appear in public repos, articles, or documentation. For stronger security, **OAuth/OIDC is the recommended path** — it's the only auth mechanism that both Cloudflare Access and cloud-hosted MCP clients (like Cowork's custom connector) natively support. Bearer tokens require custom HTTP headers, which not all MCP client UIs expose.

For bearer token authentication, set `MCP_AUTH_TOKEN` in your environment and the HTTP server will validate the `Authorization: Bearer <token>` header on every request. See `http-server.ts` for implementation. Note: this requires your MCP client to support custom request headers.

### macOS Persistence (LaunchAgents)

For always-on operation — server starts at login, tunnel reconnects automatically, logs to `~/Library/Logs/`:

```bash
# Edit the variables at the top of the script first (SESSION_NAME, MCP_PORT, TUNNEL_TOKEN)
chmod +x scripts/setup-persistence.sh
./scripts/setup-persistence.sh
```

Templates for the LaunchAgent plists are in `config/`. The script substitutes your paths, your chosen port, and your tunnel token, then loads them.

---

## Configuring the Intelligence Processor

The processor ships with a generic `EXAMPLE_CONTEXT` in `src/processor/analyzer.ts`. Replace it with your own professional context:

```typescript
export const EXAMPLE_CONTEXT: UserContext = {
  name: 'Your Name',
  aliases: ['YourName', 'yourname'],
  role: 'Your role and company',
  focusAreas: [
    'your focus area 1',
    'your focus area 2',
    'your product or platform',
  ],
  opportunityTypes: [
    'partnerships',
    'speaking',
    'pain points your product solves',
    'content ideas',
  ],
  contentOutlets: ['Your Newsletter', 'LinkedIn'],
};
```

This context is the difference between generic summaries and personalized intelligence. The analyzer uses it to flag opportunities that map to your work, assess your participation patterns, and surface cross-group signals that matter to *you specifically*.

Rebuild after editing: `npm run build`

---

## Cowork Plugin

The `plugin/` directory contains a Claude Desktop (Cowork) plugin with a `/whatsapp` slash command. It triggers the full intelligence pipeline: pull messages from your configured groups, run the analyzer, generate a structured briefing. Say "check my WhatsApp" and get the five things that actually matter.

---

## Project Structure

```
src/
├── mcp-server/
│   ├── index.ts          # Stdio transport (Claude Code)
│   ├── http-server.ts    # StreamableHTTP transport (Cowork + tunnel)
│   ├── tools.ts          # MCP tool definitions + fuzzy group matching
│   ├── types.ts          # Zod schemas for tool inputs
│   └── whatsapp.ts       # Baileys client wrapper + ring buffer + mutex
└── processor/
    ├── parser.ts         # Multi-format chat parser
    ├── analyzer.ts       # Theme/idea/opportunity extraction (← customize this)
    └── briefing.ts       # Formatted intelligence briefing output
config/                   # LaunchAgent plist templates
scripts/                  # Setup automation
plugin/                   # Cowork slash command plugin
```

---

## Design Decisions

**Baileys over a headless browser.** An earlier cut of this server drove WhatsApp Web through Puppeteer. It worked, but every failure mode was a browser failure — page-context crashes on large fetches, stale DOM references after reconnects, memory leaks from orphaned Chromium processes. Baileys speaks the WhatsApp Multi-Device protocol directly over a WebSocket. No browser, no DOM, no Chromium. Reconnects take two seconds instead of fifteen, and the whole surface area collapses to "is the socket open and is the buffer warm."

**In-memory ring buffer + disk snapshot.** Baileys streams messages in real time via `messages.upsert`, but its historical sync (`messages.history-set`) fires **once**, on the initial pairing. Every subsequent reconnect delivers only live traffic. That's a trap: a restart would otherwise start from an empty buffer and tools would return stale or partial results. The server keeps a 500-message-per-group ring buffer in memory, snapshots it to `.baileys_auth-<session>/buffer.json` every 60 seconds, and rehydrates on boot. The snapshot is load-bearing — do not treat it as a cache.

**Readiness gate, not a spinlock.** On cold start there's a window between "process alive" and "ready to serve." The server doesn't answer tool calls during that window; it returns `503 Service Unavailable` with a retry hint until `connection.update → open` fires AND the buffer is either drained from `history-set` or 30 seconds have elapsed. Clients that retry sensibly get clean results. Clients that don't fail fast instead of getting silently wrong data.

**AsyncMutex over rate limiting.** Every WhatsApp operation — reads, writes, metadata lookups — flows through a FIFO queue with a 100ms minimum interval between operations. Baileys itself is reentrant-safe, but Signal Protocol session setup on unfamiliar recipients benefits from serialization, and the mutex keeps us comfortably under WhatsApp's rate-limit thresholds without having to model them.

**Multi-session HTTP server.** The StreamableHTTP transport generates unique session IDs. Each Cowork `initialize` creates a fresh MCP Server + Transport pair. All sessions share the single WhatsApp client (already protected by the mutex). The `Map<string, McpSession>` tracks active sessions with 30-minute TTL — stale sessions are cleaned up automatically.

**Fuzzy group name matching.** Levenshtein distance + substring matching, case-insensitive. "book club" finds "Book Club — Monthly Reads." This is a small detail that makes the difference between a system you use daily and one you abandon after a week.

**Write tools require the same mutex.** `whatsapp_send_message` and `whatsapp_reply_to_message` go through the same AsyncMutex as every read. Quoted replies use Baileys' `quoted` field on `sendMessage`, so they render as native quoted messages on all clients — phones, desktop, web.

**Context > Intelligence.** The gap between a chatbot and a useful assistant is almost never a smarter model — it's better context. The `EXAMPLE_CONTEXT` object is a few lines of configuration that transforms the analyzer from generic summarization to personalized intelligence. A well-informed current model beats a brilliant amnesiac every time.

---

## Acknowledgments

The chat intelligence processor was inspired by **[Scott Walker](https://github.com/Scottywalks22)** (Founder & CEO, [UpShift Collective](https://www.upshiftcollective.com/)), who built the [Junto Group Analyzer](https://juntogroupanalyzer.lovable.app/) — a Claude skill that transforms WhatsApp group exports into structured intelligence briefings. Scott shared it as a gift to our professional group, and the six-output framework (themes, big ideas, opportunities, participation analysis, live threads, notable quotes) proved the concept: structured analysis of group conversations surfaces signal that passive consumption misses entirely. This project extends that framework into a real-time MCP server with multi-group synthesis and configurable professional context.

Built with [Baileys](https://github.com/WhiskeySockets/Baileys), the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), and [Cloudflare Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

---

## License

MIT — clone it, fork it, make it yours.

If you build something interesting on top of it, I'd like to hear about it: [github@porres.com](mailto:github@porres.com) or [@eporres on LinkedIn](https://www.linkedin.com/in/eporres/).
