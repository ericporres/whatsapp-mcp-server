import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { WhatsAppClient } from './whatsapp.js';
import {
  GetMessagesInputSchema,
  ExportChatInputSchema,
  SearchMessagesInputSchema,
  GroupInfoInputSchema,
  SendMessageInputSchema,
  ReplyToMessageInputSchema,
  type WhatsAppGroup,
} from './types.js';

// ── Fuzzy Group Name Matching ───────────────────────────────────────────────

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[m][n];
}

type ResolveResult =
  | { kind: 'ok'; group: WhatsAppGroup }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: WhatsAppGroup[] };

export function looksLikeJid(input: string): boolean {
  return /@g\.us$/i.test(input.trim());
}

// Among same-name matches, prefer the one live group. A subject can collide
// across the live group, a Community parent, and migrated shells, but only the
// live group carries buffered activity. Resolve to it when it is unique; refuse
// only when two or more candidates are genuinely active.
function preferActive(matches: WhatsAppGroup[]): ResolveResult {
  const active = matches.filter((g) => g.lastActivityTimestamp > 0);
  if (active.length === 1) return { kind: 'ok', group: active[0] };
  return { kind: 'ambiguous', matches };
}

export async function resolveGroup(
  client: WhatsAppClient,
  groupName: string,
): Promise<ResolveResult> {
  const groups = await client.getGroups();

  // 0. Exact JID — the stable, unambiguous path. The daily brief and any
  //    caller addressing a non-unique name should pass the JID directly.
  if (looksLikeJid(groupName)) {
    const byJid = groups.find((g) => g.id === groupName.trim());
    return byJid ? { kind: 'ok', group: byJid } : { kind: 'none' };
  }

  const needle = normalize(groupName);

  // 1. Exact name (normalized). On a collision, prefer the single live group;
  //    refuse only when two or more candidates are genuinely active.
  const exact = groups.filter((g) => normalize(g.name) === needle);
  if (exact.length === 1) return { kind: 'ok', group: exact[0] };
  if (exact.length > 1) return preferActive(exact);

  // 2. Substring includes. Same rule: prefer the single live match.
  const includes = groups.filter((g) => normalize(g.name).includes(needle));
  if (includes.length === 1) return { kind: 'ok', group: includes[0] };
  if (includes.length > 1) return preferActive(includes);

  // 3. Levenshtein < 3 (typo tolerance) — only when nothing else matched, and
  //    only when the closest match is unique.
  let bestMatch: WhatsAppGroup | null = null;
  let bestDistance = Infinity;
  let bestIsTied = false;
  for (const group of groups) {
    const distance = levenshtein(normalize(group.name), needle);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = group;
      bestIsTied = false;
    } else if (distance === bestDistance) {
      bestIsTied = true;
    }
  }
  if (bestDistance < 3 && bestMatch && !bestIsTied) {
    return { kind: 'ok', group: bestMatch };
  }

  return { kind: 'none' };
}

function describeCandidate(g: WhatsAppGroup): string {
  const last = g.lastActivityTimestamp
    ? new Date(g.lastActivityTimestamp * 1000).toISOString()
    : 'no recent activity';
  return `  - "${g.name}" — jid: ${g.id} — ${g.memberCount} members — last active: ${last}`;
}

export async function resolveGroupOrError(
  client: WhatsAppClient,
  groupName: string,
): Promise<
  | { group: WhatsAppGroup; error?: undefined }
  | { group?: undefined; error: { type: 'text'; text: string } }
> {
  const res = await resolveGroup(client, groupName);

  if (res.kind === 'ok') return { group: res.group };

  if (res.kind === 'ambiguous') {
    const list = res.matches.map(describeCandidate).join('\n');
    return {
      error: {
        type: 'text' as const,
        text:
          `"${groupName}" matches ${res.matches.length} groups — refusing to ` +
          `guess which one. Re-call with the exact JID as groupName:\n${list}`,
      },
    };
  }

  const groups = await client.getGroups();
  const available = groups.map((g) => g.name).join(', ');
  return {
    error: {
      type: 'text' as const,
      text: `No group found matching "${groupName}". Available groups: ${available}`,
    },
  };
}

// ── Tool Registration ───────────────────────────────────────────────────────

export function registerTools(server: Server, client: WhatsAppClient): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'whatsapp_list_groups',
        description:
          'List all WhatsApp groups the authenticated user belongs to, sorted by most recent activity.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      },
      {
        name: 'whatsapp_get_messages',
        description:
          'Get messages from a WhatsApp group. Supports fuzzy group name matching, message count limit, and date range filtering.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            groupName: {
              type: 'string',
              description: 'Group name (fuzzy-matched) or exact group JID (e.g. 12036...@g.us). If the name matches multiple groups, the call fails and returns the JIDs to disambiguate.',
            },
            limit: {
              type: 'number',
              description: 'Maximum messages to return (default: 200, max: 500)',
              default: 200,
            },
            afterDate: {
              type: 'string',
              description: 'Only messages after this date (YYYY-MM-DD)',
            },
            beforeDate: {
              type: 'string',
              description: 'Only messages before this date (YYYY-MM-DD)',
            },
          },
          required: ['groupName'],
        },
      },
      {
        name: 'whatsapp_export_chat',
        description:
          'Export a WhatsApp group chat as .txt in the same format as WhatsApp built-in export.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            groupName: {
              type: 'string',
              description: 'Group name (fuzzy-matched) or exact group JID (e.g. 12036...@g.us). If the name matches multiple groups, the call fails and returns the JIDs to disambiguate.',
            },
            limit: {
              type: 'number',
              description: 'Maximum messages to include (default: 500, max: 500)',
              default: 500,
            },
          },
          required: ['groupName'],
        },
      },
      {
        name: 'whatsapp_search_messages',
        description:
          'Search messages containing a keyword or phrase, optionally scoped to a specific group.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: {
              type: 'string',
              description: 'Search query (keyword or phrase)',
            },
            groupName: {
              type: 'string',
              description: 'Optional: limit search to a specific group (fuzzy-matched)',
            },
            limit: {
              type: 'number',
              description: 'Maximum results to return (default: 50, max: 200)',
              default: 50,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'whatsapp_group_info',
        description:
          'Get detailed metadata about a WhatsApp group including description, participants, and creation date.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            groupName: {
              type: 'string',
              description: 'Group name (fuzzy-matched) or exact group JID (e.g. 12036...@g.us). If the name matches multiple groups, the call fails and returns the JIDs to disambiguate.',
            },
          },
          required: ['groupName'],
        },
      },
      {
        name: 'whatsapp_send_message',
        description:
          'Send a message to a WhatsApp group, addressed by name or exact JID. If the name matches more than one group, the send is refused and the matching JIDs are returned instead of guessing.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            groupName: {
              type: 'string',
              description: 'Group name (fuzzy-matched) or exact group JID (e.g. 12036...@g.us). If the name matches multiple groups, the call fails and returns the JIDs to disambiguate.',
            },
            message: {
              type: 'string',
              description: 'Message text to send',
            },
          },
          required: ['groupName', 'message'],
        },
      },
      {
        name: 'whatsapp_reply_to_message',
        description:
          'Reply to a specific message in a WhatsApp group. The reply will be shown as a quoted reply.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            groupName: {
              type: 'string',
              description: 'Group name (fuzzy-matched) or exact group JID (e.g. 12036...@g.us). If the name matches multiple groups, the call fails and returns the JIDs to disambiguate.',
            },
            messageId: {
              type: 'string',
              description: 'The ID of the message to reply to (from whatsapp_get_messages)',
            },
            message: {
              type: 'string',
              description: 'Reply text to send',
            },
          },
          required: ['groupName', 'messageId', 'message'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Retry helper — one automatic retry on transient errors (Puppeteer crashes,
    // WhatsApp Web flakiness). Waits 3s before retry to let the browser stabilize.
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      switch (name) {
        case 'whatsapp_list_groups': {
          const groups = await client.getGroups();
          const sorted = [...groups].sort(
            (a, b) => b.lastActivityTimestamp - a.lastActivityTimestamp,
          );

          const formatted = sorted
            .map((g, i) => {
              const date = new Date(g.lastActivityTimestamp * 1000).toISOString();
              const preview = g.lastMessage
                ? g.lastMessage.slice(0, 80)
                : '(no messages)';
              return `${i + 1}. ${g.name} (${g.memberCount} members)\n   JID: ${g.id}\n   Last active: ${date}\n   Last message: ${preview}`;
            })
            .join('\n\n');

          return {
            content: [{ type: 'text' as const, text: `Found ${sorted.length} groups:\n\n${formatted}` }],
          };
        }

        case 'whatsapp_get_messages': {
          const parsed = GetMessagesInputSchema.parse(args);
          const result = await resolveGroupOrError(client, parsed.groupName);
          if (result.error) return { content: [result.error], isError: true };

          const options: { limit: number; after?: number; before?: number } = {
            limit: parsed.limit,
          };

          if (parsed.afterDate) {
            options.after = Math.floor(new Date(parsed.afterDate + 'T00:00:00Z').getTime() / 1000);
          }
          if (parsed.beforeDate) {
            options.before = Math.floor(new Date(parsed.beforeDate + 'T23:59:59Z').getTime() / 1000);
          }

          const messages = await client.getGroupMessages(result.group.id, options);

          const formatted = messages
            .map((m) => {
              const date = new Date(m.timestamp * 1000).toISOString();
              const media = m.hasMedia ? ' [media]' : '';
              const fwd = m.isForwarded ? ' [forwarded]' : '';
              const quote = m.quotedMsg
                ? `\n   > ${m.quotedMsg.author}: ${m.quotedMsg.body.slice(0, 60)}`
                : '';
              return `[${date}] [id:${m.id}] ${m.authorName}${media}${fwd}: ${m.body}${quote}`;
            })
            .join('\n');

          return {
            content: [{
              type: 'text' as const,
              text: `${messages.length} messages from "${result.group.name}":\n\n${formatted}`,
            }],
          };
        }

        case 'whatsapp_export_chat': {
          const parsed = ExportChatInputSchema.parse(args);
          const result = await resolveGroupOrError(client, parsed.groupName);
          if (result.error) return { content: [result.error], isError: true };

          const exported = await client.exportChat(result.group.id, parsed.limit);
          return { content: [{ type: 'text' as const, text: exported }] };
        }

        case 'whatsapp_search_messages': {
          const parsed = SearchMessagesInputSchema.parse(args);

          let groupId: string | undefined;
          if (parsed.groupName) {
            const result = await resolveGroupOrError(client, parsed.groupName);
            if (result.error) return { content: [result.error], isError: true };
            groupId = result.group.id;
          }

          const messages = await client.searchMessages(parsed.query, groupId);
          const limited = messages.slice(0, parsed.limit);

          const formatted = limited
            .map((m) => {
              const date = new Date(m.timestamp * 1000).toISOString();
              return `[${date}] [id:${m.id}] ${m.authorName}: ${m.body}`;
            })
            .join('\n');

          const scope = parsed.groupName ? `in "${parsed.groupName}"` : 'across all groups';

          return {
            content: [{
              type: 'text' as const,
              text: `${limited.length} results for "${parsed.query}" ${scope}:\n\n${formatted}`,
            }],
          };
        }

        case 'whatsapp_group_info': {
          const parsed = GroupInfoInputSchema.parse(args);
          const result = await resolveGroupOrError(client, parsed.groupName);
          if (result.error) return { content: [result.error], isError: true };

          const info = await client.getGroupInfo(result.group.id);
          const admins = info.participants.filter((p) => p.isAdmin);
          const members = info.participants.filter((p) => !p.isAdmin);
          const created = new Date(info.createdAt * 1000).toISOString();

          const text = [
            `Group: ${info.name}`,
            `JID: ${info.id}`,
            `Description: ${info.description || '(none)'}`,
            `Created: ${created}`,
            `Total participants: ${info.participants.length}`,
            '',
            `Admins (${admins.length}):`,
            ...admins.map((a) => `  - ${a.name}`),
            '',
            `Members (${members.length}):`,
            ...members.map((m) => `  - ${m.name}`),
          ].join('\n');

          return { content: [{ type: 'text' as const, text }] };
        }

        case 'whatsapp_send_message': {
          const parsed = SendMessageInputSchema.parse(args);
          const result = await resolveGroupOrError(client, parsed.groupName);
          if (result.error) return { content: [result.error], isError: true };

          const sent = await client.sendMessage(result.group.id, parsed.message);
          return {
            content: [{
              type: 'text' as const,
              text: `Message sent to "${result.group.name}".\nMessage ID: ${sent.id}\nTimestamp: ${new Date(sent.timestamp * 1000).toISOString()}`,
            }],
          };
        }

        case 'whatsapp_reply_to_message': {
          const parsed = ReplyToMessageInputSchema.parse(args);
          const result = await resolveGroupOrError(client, parsed.groupName);
          if (result.error) return { content: [result.error], isError: true };

          const sent = await client.sendMessage(
            result.group.id,
            parsed.message,
            parsed.messageId,
          );
          return {
            content: [{
              type: 'text' as const,
              text: `Reply sent to "${result.group.name}" (quoting ${parsed.messageId}).\nMessage ID: ${sent.id}\nTimestamp: ${new Date(sent.timestamp * 1000).toISOString()}`,
            }],
          };
        }

        default:
          return {
            content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < MAX_ATTEMPTS) {
        // Log and retry after a short delay
        process.stderr.write(
          `[${new Date().toISOString()}] [tools] ${name} attempt ${attempt} failed: ${message} — retrying in 3s...\n`,
        );
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return {
        content: [{ type: 'text' as const, text: `Error executing ${name}: ${message}` }],
        isError: true,
      };
    }
    } // end retry loop

    // Unreachable — every path inside the loop returns or continues — but
    // TypeScript can't prove it, so we satisfy the return type here.
    return {
      content: [{ type: 'text' as const, text: `Error executing ${name}: max retries exceeded` }],
      isError: true as const,
    };
  });
}
