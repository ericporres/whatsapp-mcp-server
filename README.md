# WhatsApp MCP Server

An MCP (Model Context Protocol) server that exposes WhatsApp group chats to Claude and other MCP-compatible AI assistants. Includes a chat intelligence processor that extracts themes, ideas, opportunities, and actionable insights from group conversations.

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
- **Cowork / Desktop** → StreamableHTTP transport (`http-server.ts`) — multi-session via Cloudflare tunnel

The WhatsApp client uses `whatsapp-web.js` (Puppeteer-based) with an `AsyncMutex` to serialize all API calls. Puppeteer's single-threaded browser will crash on concurrent `page.evaluate()` calls, so the mutex enforces FIFO ordering with a 2-second minimum interval between operations.

## MCP Tools

| Tool | Description |
|------|-------------|
| `whatsapp_list_groups` | List all groups (sorted by activity) |
| `whatsapp_get_messages` | Get messages from a group (with date filters) |
| `whatsapp_export_chat` | Export conversation as WhatsApp-format .txt |
| `whatsapp_search_messages` | Search across groups by keyword |
| `whatsapp_group_info` | Group metadata, participants, description |

All tools support fuzzy group name matching — you can say "Book Club" instead of the exact group name.

## Chat Intelligence Processor

Beyond raw message access, the processor pipeline analyzes conversations to extract:

- **Themes** — recurring topics with recurrence tagging (hot / important / emerging)
- **Big ideas** — intellectually interesting or actionable ideas, flagged by relevance
- **Opportunities** — collaboration, business leads, speaking, networking, content ideas
- **Participation analysis** — how active you are, topics you engage vs. skip
- **Live threads** — active conversations worth jumping into, with suggested messages
- **Notable quotes** — standout lines worth saving
- **Cross-group synthesis** — amplified signals, network nodes, compounding opportunities

Customize the `EXAMPLE_CONTEXT` in `src/processor/analyzer.ts` with your professional context.

## Setup

### Prerequisites

- Node.js 22+
- A WhatsApp account (will authenticate via QR code on first run)

### Install and Build

```bash
npm install
npm run build
```

### First Run (QR Authentication)

```bash
WHATSAPP_SESSION_NAME=my-session node dist/mcp-server/index.ts
```

Scan the QR code with WhatsApp on your phone. Session credentials are cached in `.wwebjs_auth/` for subsequent runs.

### Register with Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/path/to/whatsapp-mcp-server/dist/mcp-server/index.js"]
    }
  }
}
```

### HTTP Server for Cowork (Desktop App)

The HTTP server supports multiple concurrent MCP sessions, each getting a fresh Server + Transport pair while sharing the single WhatsApp client.

```bash
MCP_HTTP_PORT=3847 node dist/mcp-server/http-server.js
```

Expose via Cloudflare tunnel for HTTPS access:

```bash
cloudflared tunnel --url http://localhost:3847
```

Or use a named tunnel for a stable URL (recommended for persistent setups).

### macOS LaunchAgents (Persistent)

For always-on operation, use the provided setup script:

```bash
# Edit variables in the script first
chmod +x scripts/setup-persistence.sh
./scripts/setup-persistence.sh
```

This creates LaunchAgents that start the MCP server (and optionally the tunnel) at login.

## Cowork Plugin

The `plugin/` directory contains a Claude Desktop plugin with a `/whatsapp` slash command that triggers the full intelligence briefing workflow.

## Project Structure

```
src/
├── mcp-server/
│   ├── index.ts          # Stdio transport (Claude Code)
│   ├── http-server.ts    # HTTP transport (Cowork + tunnel)
│   ├── tools.ts          # MCP tool registration + fuzzy matching
│   ├── types.ts          # Zod schemas for tool inputs
│   └── whatsapp.ts       # WhatsApp client wrapper + AsyncMutex
└── processor/
    ├── parser.ts         # Multi-format chat parser
    ├── analyzer.ts       # Theme, idea, opportunity extraction
    └── briefing.ts       # Formatted intelligence briefing output
config/                   # LaunchAgent templates
scripts/                  # Setup automation
plugin/                   # Cowork slash command plugin
```

## Key Design Decisions

**AsyncMutex over rate limiting.** Puppeteer is single-threaded — concurrent `page.evaluate()` calls don't just slow down, they crash. The mutex serializes all WhatsApp API calls through a FIFO queue with a 2-second minimum interval, preventing both concurrency crashes and rate limit hits.

**Multi-session HTTP server.** Each Cowork `initialize` handshake creates a fresh MCP Server + Transport pair. Sessions are tracked in a `Map<string, McpSession>` with 30-minute TTL cleanup. All sessions share the single WhatsApp client (already protected by the mutex).

**Fuzzy group name matching.** Uses Levenshtein distance + substring matching so you can refer to groups naturally ("Book Club" finds "Book Club - Monthly Reads").

## License

MIT
