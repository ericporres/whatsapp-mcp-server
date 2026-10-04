# WhatsApp MCP Server

**Your WhatsApp groups are a live intelligence network. This server lets MCP-compatible AI clients read them.**

An open-source [MCP](https://modelcontextprotocol.io) server that connects WhatsApp group chats to Claude, ChatGPT, Codex, and other MCP-compatible AI clients. It exposes eight tools for reading, searching, exporting, backfilling history, and replying to group conversations — plus a chat intelligence processor that extracts themes, opportunities, and actionable briefings from hundreds of messages.

I built this because I'm in a dozen professional WhatsApp groups — practitioners, investors, founders — where the information density is remarkable and the retrieval rate is abysmal. WhatsApp is optimized for *conversation*, not *comprehension*. This server fixes that.

---

## What It Does

**Eight MCP tools** give your AI client structured access to your WhatsApp groups:

| Tool | What It Does |
|------|-------------|
| `whatsapp_list_groups` | Every group you belong to, sorted by recent activity |
| `whatsapp_get_messages` | Pull messages from any group with date range filtering |
| `whatsapp_group_info` | Metadata, participants, descriptions |
| `whatsapp_search_messages` | Keyword search across all groups or scoped to one |
| `whatsapp_export_chat` | Full export in WhatsApp's native `.txt` format |
| `whatsapp_sync_history` | On-demand backfill of older group messages from WhatsApp servers |
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
│ Remote MCP  │◄──────────────►│  HTTP Server  │  (same WhatsApp client)
│   client    │  + cloudflared │ (http-server) │
└─────────────┘                └───────────────┘
```

Two transport modes, one WhatsApp client:

- **Local clients such as Claude Code** → stdio transport (`index.ts`) — direct pipe, single session
- **Remote clients such as ChatGPT, Codex, and Cowork** → StreamableHTTP transport (`http-server.ts`) — multi-session over HTTPS via a tunnel or reverse proxy

WhatsApp has no open API for group chats. The Business API is for customer messaging only. So this server uses [Baileys](https://github.com/WhiskeySockets/Baileys) — a direct WebSocket implementation of the WhatsApp Multi-Device protocol. No headless browser, no DOM scraping. Credentials and Signal Protocol keys persist to `.baileys_auth-<session>/` via `useMultiFileAuthState`, and the client reconnects in roughly two seconds after restarts.

Every read and write flows through an **AsyncMutex** that serializes WhatsApp operations behind a FIFO queue with a 100ms minimum interval. Baileys is reentrant-safe, but Signal Protocol session setup on unfamiliar recipients benefits from serialization, and the mutex keeps us well under WhatsApp's rate-limit thresholds without having to reason about them explicitly.

Messages stream in over the WebSocket and land in an **in-memory ring buffer** — 1500 messages per group, JID-keyed — that the tool layer reads from. The buffer snapshots to `.baileys_auth-<session>/buffer.json` every 60 seconds and rehydrates on boot. This is load-bearing, not optional: the `messages.history-set` event that Baileys emits on first pairing is a one-shot, so on any reconnect the snapshot is the only thing standing between you and a cold buffer. For groups that need more history after pairing, `whatsapp_sync_history` walks backwards from the oldest buffered message via Baileys `fetchMessageHistory`.

A **readiness gate** keeps this honest. Tool calls return `503 Service Unavailable` until the WebSocket has reached `connection.update → open` AND the buffer is warm (either `messages.history-set` has drained or 30 seconds have elapsed). The server never crashes into half-initialized state, and clients get a clean retryable error instead.

---

## Setup

### Choose Your Client

Install, build, and pair WhatsApp using the shared steps below, then choose a transport:

| Client | Setup path |
|---|---|
| Claude Code using a local process | [Register with Claude Code](#register-with-claude-code); no tunnel needed |
| ChatGPT | [HTTP server and tunnel](#http-server-chatgpt-codex-cowork-and-other-remote-clients), then [Connect ChatGPT](#connect-chatgpt) |
| Codex using the remote endpoint | [HTTP server and tunnel](#http-server-chatgpt-codex-cowork-and-other-remote-clients), then [Connect Codex](#connect-codex) |
| Cowork or another remote MCP client | Use the same HTTP endpoint and OAuth credentials |

This server exposes **group chats**, not one-to-one conversations. A ChatGPT connection provides the MCP tools; it does not install the Claude-specific slash command in `plugin/`.

### Prerequisites

- Node.js 22+
- A WhatsApp account (pairs via QR code on first run)

> **Upgrading from an earlier version:** the server now runs [Baileys](https://github.com/WhiskeySockets/Baileys) 7, the release npm installs by default (6.x is the `legacy` line). Run `npm install` after pulling. If an existing session can't reconnect after the upgrade, stop the server, remove its `.baileys_auth*` directory, and pair again.

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

Scan the QR code with WhatsApp on your phone. Credentials and Signal keys cache in `.baileys_auth-my-session/` — you won't need to scan again unless you remove that directory or revoke the linked device from your phone. Each `WHATSAPP_SESSION_NAME` gets its own directory under the package root, whichever directory you launch the server from. Installs from before per-session directories keep using an existing `.baileys_auth/` until a `.baileys_auth-<session>/` exists, so upgrading never forces a re-pair.

Stop the pairing process with Ctrl+C before starting the HTTP server with the **same session name**. Run one WhatsApp client process per auth directory; remote AI clients can share that HTTP process.

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

### HTTP Server (ChatGPT, Codex, Cowork, and Other Remote Clients)

ChatGPT connects to an HTTPS MCP endpoint. It cannot start the local stdio process described in the Claude Code section. The HTTP server supports multiple concurrent MCP sessions sharing one paired WhatsApp client.

You need `cloudflared` (or another HTTPS reverse proxy), a stable public hostname, and a tunnel configured to forward that hostname to `http://127.0.0.1:<your-port>`. Configure a named Cloudflare tunnel before starting the server; see [Cloudflare's tunnel setup documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

Choose a free high port. The server binds to `127.0.0.1` only. Follow the OAuth setup below **before exposing it**, then run your configured tunnel in another terminal:

```bash
cloudflared tunnel run your-tunnel-name
```

Use the HTTPS **origin** (no `/mcp`) for `MCP_PUBLIC_URL`, and the full **endpoint** (`/mcp` included) when connecting your AI client. If a temporary tunnel URL changes, update `MCP_PUBLIC_URL`, restart the server, and update the client connection. A named tunnel avoids this churn.

### Securing the Tunnel

The server runs locally — your machine, your data, your paired WhatsApp session. Exposing it through a tunnel creates a public HTTPS endpoint that can read and send messages as you. **Turn on OAuth before you expose it.**

The HTTP server ships with a built-in OAuth 2.1 authorization server (Authorization Code + PKCE, refresh-token rotation). It is single-user: one client ID and secret, generated locally, stored in a file git ignores. Replace the port and hostname placeholders below with your tunnel configuration; use the session name you paired earlier. Generate credentials only for a new setup, not each restart.

```bash
npm run build
npm run oauth:generate            # writes .mcp-credentials.json (mode 0600)

WHATSAPP_SESSION_NAME=my-session \
MCP_HTTP_PORT='<your-port>' \
MCP_PUBLIC_URL='https://<your-tunnel-hostname>' \
node dist/mcp-server/http-server.js
```

Then add the server in your MCP client as `https://<your-tunnel-hostname>/mcp` with the `client_id` and `client_secret` from `.mcp-credentials.json`. The client discovers `/.well-known/oauth-authorization-server`, runs the PKCE flow, and sends `Authorization: Bearer <token>` on every `/mcp` request. Requests without a valid token get `401`.

How the server decides:

| `.mcp-credentials.json` | `MCP_PUBLIC_URL` | Result |
|---|---|---|
| present | set | OAuth enforced on `/mcp` |
| present | unset | refuses to start (the issuer URL is required) |
| absent | set | refuses to start (a public URL with no auth would be open) |
| absent | unset | refuses to start, unless `MCP_ALLOW_NO_AUTH=1` |

`MCP_ALLOW_NO_AUTH=1` runs `/mcp` with no authentication. The server can't tell whether a tunnel forwards to its port, so this is opt-in and meant for local testing only. Never set it on a machine with a tunnel pointed at the server.

| Variable | Default | Purpose |
|---|---|---|
| `MCP_PUBLIC_URL` (alias `MCP_TUNNEL_URL`) | — | HTTPS origin clients use; the OAuth issuer |
| `MCP_OAUTH_CREDENTIALS` | `<package root>/.mcp-credentials.json` | Credentials file location |
| `MCP_ALLOW_NO_AUTH` | unset | `1` to run without OAuth (local testing only) |

Issued tokens persist to `.mcp-token-store.json` (mode 0600) next to the credentials, so restarts don't force a re-login. Access tokens last 1 hour. Refresh tokens last 24 hours and rotate on use, so a client that refreshes at least daily stays signed in; using a refresh token revokes the access token issued with it. To rotate the secret, stop the server, delete both files, generate again, and update your client.

Keep your tunnel hostname out of public repos, articles, and screenshots anyway. You can layer Cloudflare Access on top, with one caveat: cloud-hosted MCP clients (including ChatGPT and Cowork) connect from the *platform's* IP addresses, not yours, so an IP allowlist tied to your home network blocks them. I learned this the hard way: the tunnel was healthy, the server was running, and Cloudflare was dutifully rejecting every legitimate request from the desktop app I built this for.

`/authorize` accepts any `https` redirect URI (or `http` on localhost), because MCP clients register their own callbacks. The authorization code it returns is worthless without the client secret, but the endpoint can still bounce a browser to an arbitrary site from your hostname.

**Local-only use (Claude Code over stdio)** needs none of this — stdio is a direct pipe and opens no port.

### Connect ChatGPT

These steps follow OpenAI's [plugin quickstart](https://developers.openai.com/plugins/quickstart). Menu labels and availability can vary by account or workspace; check that guide if your UI differs.

1. In ChatGPT, open **Settings → Security and login** and enable **Developer mode**.
2. Open **Plugins**, select the **plus/Add** button, and create a custom MCP server.
3. Enter a name such as **WhatsApp Messages**, server URL `https://<your-tunnel-hostname>/mcp`, and authentication **OAuth**.
4. Expand **Advanced OAuth settings**. Wait for discovery, then change **Registration method** to **User-Defined OAuth Client**.
5. Enter `client_id` and `client_secret` from your local `.mcp-credentials.json`. Use **Token endpoint auth method** `client_secret_post` and select scope **`mcp`**. Leave OpenID/OIDC disabled; this server does not implement it.
6. Confirm that you trust your server, select **Create as a plugin**, and complete the connection. If it appears in your personal plugin directory without being installed, install it there.
7. Start a new chat, type `@`, select **WhatsApp Messages**, and ask: *"What WhatsApp groups am I in?"* The official quickstart uses a new **Work** chat. Then test a message read: *"Summarize the latest 20 messages in [group name]."*

**Why not Dynamic Client Registration?** ChatGPT may select DCR automatically because the server advertises `/register`. This implementation returns the existing client ID but deliberately never returns its secret. The token endpoint requires that secret, so use a User-Defined OAuth Client rather than relying on automatic registration. See OpenAI's [OAuth guidance](https://developers.openai.com/plugins/build/auth).

Discovered settings should look like this:

| Setting | Value |
|---|---|
| Authorization URL | `https://<your-tunnel-hostname>/authorize` |
| Token URL | `https://<your-tunnel-hostname>/token` |
| Authorization server / issuer | `https://<your-tunnel-hostname>` |
| Resource | `https://<your-tunnel-hostname>/mcp` |
| Token endpoint auth method | `client_secret_post` |
| Scope | `mcp` |

In the plugin's account settings, choose when ChatGPT should request approval. **Allow read-only tools** means reads can run without asking and writes require approval; it does **not** disable the server's send/reply tools. Classification depends on the tool annotations exposed by the server. After changing server tool definitions, use **Refresh tools** in the plugin's settings and test in a new chat.

Keep the host, WhatsApp server, and tunnel running whenever ChatGPT needs access. Connecting the plugin does not move the WhatsApp session into OpenAI's cloud. Protect the local credentials file; do not include its contents in issues, screenshots, or pull requests.

### Connect Codex

Codex can use the same HTTPS endpoint and pre-generated OAuth client. Run `codex mcp add --help` to check your installed version's support for `--url`, `--oauth-client-id`, and `--oauth-client-secret`. Supply the client ID and secret from `.mcp-credentials.json` using those options and complete the OAuth flow. Avoid putting literal secrets in shell history or committed configuration.

Verify registration with `codex mcp get whatsapp` (if you named the server `whatsapp`), then start a new Codex chat to load the tools. A direct Codex MCP registration is separate from installing the personal ChatGPT plugin.

### Troubleshooting Remote Connections

| Symptom | What to check |
|---|---|
| Server refuses to start | Generate credentials, set `MCP_HTTP_PORT` and `MCP_PUBLIC_URL`, and use the paired `WHATSAPP_SESSION_NAME`. |
| Plugin creation or connection fails during OAuth | Select User-Defined OAuth Client, check both credentials, `client_secret_post`, and scope `mcp`. Do not regenerate credentials that other clients already use. |
| Cloudflare login page or `403` | Check Access policies, IP allowlists, and challenges. MCP requests come from the AI platform; it must be able to reach `/mcp`, OAuth metadata, and `/token`. |
| Host unreachable / `502` | Check that the server and tunnel are running and the tunnel forwards to the configured local port. |
| `401` when opening `/mcp` without credentials | Expected: the endpoint requires an OAuth bearer token. Test the connection through your authenticated MCP client. |
| Tools changed but ChatGPT still shows the old list | Refresh tools in the plugin settings and start a new chat. |
| Group is missing or history is incomplete | This server handles groups and bounded local history. Use `whatsapp_list_groups` and, where available, `whatsapp_sync_history`; it is not a full WhatsApp archive. |

Before debugging the AI client, check `https://<your-tunnel-hostname>/health`. It should return JSON with `status: "ok"`, `whatsapp: "connected"`, and `oauth: "enabled"`. OAuth metadata is available at `/.well-known/oauth-authorization-server`. Health and discovery checks confirm reachability; an authenticated tool call confirms the connection works.

### macOS Persistence (LaunchAgents)

For always-on operation — server starts at login, tunnel reconnects automatically, logs to `~/Library/Logs/`:

```bash
# Edit the variables at the top of the script first (SESSION_NAME, MCP_PORT, TUNNEL_TOKEN, PUBLIC_URL)
chmod +x scripts/setup-persistence.sh
./scripts/setup-persistence.sh
```

Templates for the LaunchAgent plists are in `config/`. The script substitutes your paths, your chosen port, and your tunnel token, then loads them.

### Linux Persistence (systemd)

For always-on operation on Linux, copy the unit template and fill in the placeholders:

```bash
# config/whatsapp-mcp.service.template → replace __USER__, __PROJECT__, __BUN__
sudo cp config/whatsapp-mcp.service /etc/systemd/system/whatsapp-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-mcp
```

The template runs the TypeScript source directly with bun (no build step). Keep the concrete `config/whatsapp-mcp.service` local — it is gitignored.

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

## Claude Cowork Plugin

The `plugin/` directory contains a Claude Desktop (Cowork) plugin with a `/whatsapp` slash command. It triggers the full intelligence pipeline: pull messages from your configured groups, run the analyzer, generate a structured briefing. Say "check my WhatsApp" and get the five things that actually matter.

---

## Project Structure

```
src/
├── mcp-server/
│   ├── index.ts          # Stdio transport (Claude Code)
│   ├── http-server.ts    # StreamableHTTP transport (remote clients + tunnel)
│   ├── mcp-oauth.ts      # OAuth 2.1 + PKCE authorization server for the HTTP transport
│   ├── tools.ts          # MCP tool definitions + fuzzy group matching
│   ├── types.ts          # Zod schemas for tool inputs
│   └── whatsapp.ts       # Baileys client wrapper + ring buffer + mutex
└── processor/
    ├── parser.ts         # Multi-format chat parser
    ├── analyzer.ts       # Theme/idea/opportunity extraction (← customize this)
    └── briefing.ts       # Formatted intelligence briefing output
config/                   # LaunchAgent plist + systemd unit templates
scripts/                  # Setup automation
plugin/                   # Cowork slash command plugin
```

---

## Design Decisions

**Baileys over a headless browser.** An earlier cut of this server drove WhatsApp Web through Puppeteer. It worked, but every failure mode was a browser failure — page-context crashes on large fetches, stale DOM references after reconnects, memory leaks from orphaned Chromium processes. Baileys speaks the WhatsApp Multi-Device protocol directly over a WebSocket. No browser, no DOM, no Chromium. Reconnects take two seconds instead of fifteen, and the whole surface area collapses to "is the socket open and is the buffer warm."

**In-memory ring buffer + disk snapshot.** Baileys streams messages in real time via `messages.upsert`, but its historical sync (`messages.history-set`) fires **once**, on the initial pairing. Every subsequent reconnect delivers only live traffic. That's a trap: a restart would otherwise start from an empty buffer and tools would return stale or partial results. The server keeps a 1500-message-per-group ring buffer in memory, snapshots it to `.baileys_auth-<session>/buffer.json` every 60 seconds, and rehydrates on boot. The snapshot is load-bearing — do not treat it as a cache. When a group still has older history on WhatsApp's servers, `whatsapp_sync_history` backfills on demand (needs at least one anchor message already buffered). Do not enable `syncFullHistory` with a desktop browser identity on an already-paired Android account — WhatsApp rejects that handshake and the client loops on status 428.

**Readiness gate, not a spinlock.** On cold start there's a window between "process alive" and "ready to serve." The server doesn't answer tool calls during that window; it returns `503 Service Unavailable` with a retry hint until `connection.update → open` fires AND the buffer is either drained from `history-set` or 30 seconds have elapsed. Clients that retry sensibly get clean results. Clients that don't fail fast instead of getting silently wrong data.

**AsyncMutex over rate limiting.** Every WhatsApp operation — reads, writes, metadata lookups — flows through a FIFO queue with a 100ms minimum interval between operations. Baileys itself is reentrant-safe, but Signal Protocol session setup on unfamiliar recipients benefits from serialization, and the mutex keeps us comfortably under WhatsApp's rate-limit thresholds without having to model them.

**Multi-session HTTP server.** The StreamableHTTP transport generates unique session IDs. Each client `initialize` creates a fresh MCP Server + Transport pair. All sessions share the single WhatsApp client (already protected by the mutex). The `Map<string, McpSession>` tracks active sessions with 30-minute TTL — stale sessions are cleaned up automatically.

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
