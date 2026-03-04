# WhatsApp MCP Server

**Your WhatsApp groups are a live intelligence network. This server lets Claude read them.**

An open-source [MCP](https://modelcontextprotocol.io) server that connects WhatsApp group chats to Claude (and any MCP-compatible AI client). It exposes five tools for reading, searching, and exporting group conversations — plus a chat intelligence processor that extracts themes, opportunities, and actionable briefings from hundreds of messages.

I built this because I'm in a dozen professional WhatsApp groups — practitioners, investors, founders — where the information density is remarkable and the retrieval rate is abysmal. WhatsApp is optimized for *conversation*, not *comprehension*. This server fixes that.

---

## What It Does

**Five MCP tools** give Claude (or any MCP client) structured access to your WhatsApp groups:

| Tool | What It Does |
|------|-------------|
| `whatsapp_list_groups` | Every group you belong to, sorted by recent activity |
| `whatsapp_get_messages` | Pull messages from any group with date range filtering |
| `whatsapp_group_info` | Metadata, participants, descriptions |
| `whatsapp_search_messages` | Keyword search across all groups or scoped to one |
| `whatsapp_export_chat` | Full export in WhatsApp's native `.txt` format |

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
┌─────────────┐     stdio      ┌───────────────┐     Puppeteer    ┌──────────────┐
│ Claude Code  │◄──────────────►│  MCP Server   │◄────────────────►│  WhatsApp    │
└─────────────┘                │  (index.ts)   │                  │  Web Client  │
                               └───────────────┘                  └──────────────┘
┌─────────────┐   HTTP/SSE     ┌───────────────┐
│   Cowork    │◄──────────────►│  HTTP Server  │  (same WhatsApp client)
│  (Desktop)  │  + cloudflared │ (http-server) │
└─────────────┘                └───────────────┘
```

Two transport modes, one WhatsApp client:

- **Claude Code** → stdio transport (`index.ts`) — direct pipe, single session
- **Cowork / Desktop** → StreamableHTTP transport (`http-server.ts`) — multi-session over HTTPS via Cloudflare tunnel

WhatsApp has no API for group chats. There's the Business API (customer messaging only) and WhatsApp Web (a browser session authenticated by QR code). So the server uses [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) — Puppeteer driving a headless Chromium instance that maintains a persistent authenticated session, just like your browser tab does.

This creates a single-threaded bottleneck. One browser, one page context, multiple MCP sessions potentially requesting data simultaneously. The solution is an **AsyncMutex** — a FIFO queue with a 2-second minimum interval between operations. Every WhatsApp interaction goes through the mutex. No race conditions, no page state corruption, no rate-limit triggers. It's not glamorous. It's load-bearing.

---

## Setup

### Prerequisites

- Node.js 22+
- A WhatsApp account (authenticates via QR code on first run)

### Install and Build

```bash
git clone https://github.com/ericporres/whatsapp-mcp-server.git
cd whatsapp-mcp-server
npm install
npm run build
```

### First Run — QR Authentication

```bash
WHATSAPP_SESSION_NAME=my-session node dist/mcp-server/index.js
```

Scan the QR code with WhatsApp on your phone. Session credentials cache in `.wwebjs_auth/` — you won't need to scan again unless you revoke the session.

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

```bash
MCP_HTTP_PORT=3847 node dist/mcp-server/http-server.js
```

Expose over HTTPS with a Cloudflare tunnel:

```bash
# Quick tunnel (temporary URL)
cloudflared tunnel --url http://localhost:3847

# Named tunnel (stable URL — recommended for persistent setups)
cloudflared tunnel run your-tunnel-name
```

### Securing the Tunnel

The server runs locally — your machine, your data, your authenticated WhatsApp session. But exposing it via a Cloudflare tunnel creates a public HTTPS endpoint. You should lock it down.

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
# Edit the variables at the top of the script first
chmod +x scripts/setup-persistence.sh
./scripts/setup-persistence.sh
```

Templates for the LaunchAgent plists are in `config/`. The script substitutes your paths and loads them.

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
│   └── whatsapp.ts       # WhatsApp client wrapper + AsyncMutex
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

**AsyncMutex over rate limiting.** Puppeteer's single-threaded browser doesn't degrade gracefully under concurrent `page.evaluate()` calls — it crashes. The mutex serializes all WhatsApp API calls through a FIFO queue with a 2-second minimum interval. This prevents concurrency crashes *and* WhatsApp rate-limit triggers. Every tool call, every message fetch, every search goes through the same queue.

**Fetch cap at 300 messages.** `chat.fetchMessages({limit: N})` scrolls through WhatsApp Web's DOM to load messages. At 400+ messages on high-volume groups, the headless browser becomes unreliable — Puppeteer's page context destabilizes and calls start returning 500s. The server caps every fetch at 300 regardless of what the client requests, then applies date filtering client-side. This trades theoretical completeness for practical reliability.

**Automatic retry on transient errors.** Despite the mutex, WhatsApp Web is a browser session — flaky by nature. The tool handler wraps every operation in a retry loop: one automatic retry after a 3-second delay. Most transient failures (Puppeteer page crashes, stale DOM references, brief network hiccups) resolve on the second attempt. The delay gives the browser time to stabilize before retrying.

**Multi-session HTTP server.** The StreamableHTTP transport generates unique session IDs. Each Cowork `initialize` creates a fresh MCP Server + Transport pair. All sessions share the single WhatsApp client (already protected by the mutex). The `Map<string, McpSession>` tracks active sessions with 30-minute TTL — stale sessions are cleaned up automatically.

**Fuzzy group name matching.** Levenshtein distance + substring matching, case-insensitive. "book club" finds "Book Club — Monthly Reads." This is a small detail that makes the difference between a system you use daily and one you abandon after a week.

**Context > Intelligence.** The gap between a chatbot and a useful assistant is almost never a smarter model — it's better context. The `EXAMPLE_CONTEXT` object is a few lines of configuration that transforms the analyzer from generic summarization to personalized intelligence. A well-informed current model beats a brilliant amnesiac every time.

---

## Acknowledgments

The chat intelligence processor was inspired by **[Scott Walker](https://github.com/Scottywalks22)** (Founder & CEO, [UpShift Collective](https://www.upshiftcollective.com/)), who built the [Junto Group Analyzer](https://juntogroupanalyzer.lovable.app/) — a Claude skill that transforms WhatsApp group exports into structured intelligence briefings. Scott shared it as a gift to our professional group, and the six-output framework (themes, big ideas, opportunities, participation analysis, live threads, notable quotes) proved the concept: structured analysis of group conversations surfaces signal that passive consumption misses entirely. This project extends that framework into a real-time MCP server with multi-group synthesis and configurable professional context.

Built with [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), and [Cloudflare Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

---

## License

MIT — clone it, fork it, make it yours.

If you build something interesting on top of it, I'd like to hear about it: [github@porres.com](mailto:github@porres.com) or [@eporres on LinkedIn](https://www.linkedin.com/in/eporres/).
