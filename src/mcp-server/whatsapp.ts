import pkg from 'whatsapp-web.js';
import type { Client as ClientType, Chat, Message, GroupChat, Contact } from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

import qrcode from 'qrcode-terminal';
import { format } from 'date-fns';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WhatsAppGroupSummary {
  id: string;
  name: string;
  memberCount: number;
  lastMessage: string;
  lastActivityTimestamp: number;
}

export interface WhatsAppMessageEntry {
  id: string;
  body: string;
  author: string;
  authorName: string;
  timestamp: number;
  hasMedia: boolean;
  isForwarded: boolean;
  quotedMsg?: { body: string; author: string } | undefined;
}

export interface GroupParticipant {
  id: string;
  name: string;
  isAdmin: boolean;
}

export interface WhatsAppGroupInfo {
  id: string;
  name: string;
  description: string;
  participants: GroupParticipant[];
  createdAt: number;
}

export interface GetMessagesOptions {
  limit?: number;
  after?: number;   // unix timestamp (seconds)
  before?: number;  // unix timestamp (seconds)
}

// ---------------------------------------------------------------------------
// Logging — always stderr so MCP protocol (stdout) is not polluted
// ---------------------------------------------------------------------------

function log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [whatsapp-client] [${level.toUpperCase()}]`;
  if (data !== undefined) {
    process.stderr.write(`${prefix} ${message} ${JSON.stringify(data)}\n`);
  } else {
    process.stderr.write(`${prefix} ${message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Async Mutex — serializes WhatsApp API calls (Puppeteer is single-threaded)
// ---------------------------------------------------------------------------

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;
  private lastRelease = 0;

  constructor(private readonly minIntervalMs: number = 2000) {}

  async acquire(): Promise<void> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.locked = true;

    // Enforce minimum interval between calls
    const now = Date.now();
    const elapsed = now - this.lastRelease;
    if (elapsed < this.minIntervalMs && this.lastRelease > 0) {
      const delay = this.minIntervalMs - elapsed;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  release(): void {
    this.lastRelease = Date.now();
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ---------------------------------------------------------------------------
// WhatsAppClient
// ---------------------------------------------------------------------------

export class WhatsAppClient {
  private client: ClientType;
  private ready = false;
  private mutex = new AsyncMutex(2000); // serialize + 2s min interval

  constructor(private readonly sessionName: string) {
    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionName }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    this.registerEventHandlers();
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async initialize(): Promise<void> {
    const MAX_RETRIES = 3;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      attempt++;
      try {
        log('info', `Initializing WhatsApp client (attempt ${attempt}/${MAX_RETRIES})...`);
        await this.connectWithTimeout(120_000);
        log('info', 'WhatsApp client ready.');
        return;
      } catch (err) {
        log('error', `Initialization attempt ${attempt} failed.`, err);
        if (attempt < MAX_RETRIES) {
          const backoff = Math.min(1000 * Math.pow(2, attempt), 16_000);
          log('info', `Retrying in ${backoff}ms...`);
          await new Promise<void>((resolve) => setTimeout(resolve, backoff));
          try {
            await this.client.destroy();
          } catch {
            // ignore — client may not be initialized
          }
          this.client = new Client({
            authStrategy: new LocalAuth({ clientId: this.sessionName }),
            puppeteer: {
              headless: true,
              args: ['--no-sandbox', '--disable-setuid-sandbox'],
            },
          });
          this.registerEventHandlers();
        } else {
          throw new Error(
            `WhatsApp client failed to initialize after ${MAX_RETRIES} attempts: ${String(err)}`,
          );
        }
      }
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  async destroy(): Promise<void> {
    log('info', 'Shutting down WhatsApp client...');
    this.ready = false;
    try {
      await this.client.destroy();
    } catch (err) {
      log('error', 'Error during client destroy.', err);
    }
    log('info', 'WhatsApp client destroyed.');
  }

  // -----------------------------------------------------------------------
  // Groups
  // -----------------------------------------------------------------------

  async getGroups(): Promise<WhatsAppGroupSummary[]> {
    this.ensureReady();
    return this.mutex.run(async () => {
      log('info', 'getGroups: acquiring mutex, fetching chats...');
      const chats = await this.client.getChats();
      const groupChats = chats.filter((c: Chat): c is GroupChat => c.isGroup);

      const summaries: WhatsAppGroupSummary[] = groupChats.map((g: GroupChat) => ({
        id: g.id._serialized,
        name: g.name,
        memberCount: g.participants?.length ?? 0,
        lastMessage: g.lastMessage?.body ?? '',
        lastActivityTimestamp: g.timestamp ?? 0,
      }));

      summaries.sort((a, b) => b.lastActivityTimestamp - a.lastActivityTimestamp);
      log('info', `getGroups: returning ${summaries.length} groups`);
      return summaries;
    });
  }

  async getGroupMessages(
    groupId: string,
    options: GetMessagesOptions = {},
  ): Promise<WhatsAppMessageEntry[]> {
    this.ensureReady();
    return this.mutex.run(async () => {
      log('info', `getGroupMessages: groupId=${groupId}, options=${JSON.stringify(options)}`);
      const { limit = 200, after, before } = options;
      const chat = await this.getChatById(groupId);

      const fetchCount = Math.min(limit * 2, 500);
      const rawMessages: Message[] = await chat.fetchMessages({ limit: fetchCount });

      let filtered = rawMessages;

      if (after !== undefined) {
        filtered = filtered.filter((m) => m.timestamp >= after);
      }
      if (before !== undefined) {
        filtered = filtered.filter((m) => m.timestamp <= before);
      }

      filtered = filtered.slice(0, limit);

      const entries = await Promise.all(
        filtered.map(async (m) => this.messageToEntry(m)),
      );

      log('info', `getGroupMessages: returning ${entries.length} messages`);
      return entries;
    });
  }

  async getGroupInfo(groupId: string): Promise<WhatsAppGroupInfo> {
    this.ensureReady();
    return this.mutex.run(async () => {
      log('info', `getGroupInfo: groupId=${groupId}`);
      const chat = await this.getChatById(groupId);
      if (!chat.isGroup) {
        throw new Error(`Chat ${groupId} is not a group.`);
      }
      const group = chat as GroupChat;

      const participants: GroupParticipant[] = await Promise.all(
        (group.participants ?? []).map(async (p) => {
          let name = p.id._serialized;
          try {
            const contact = await this.client.getContactById(p.id._serialized);
            name = contact.pushname || contact.name || contact.number || name;
          } catch {
            // fallback to serialized id
          }
          return {
            id: p.id._serialized,
            name,
            isAdmin: p.isAdmin || p.isSuperAdmin || false,
          };
        }),
      );

      log('info', `getGroupInfo: returning info for "${group.name}" with ${participants.length} participants`);
      return {
        id: group.id._serialized,
        name: group.name,
        description: group.description ?? '',
        participants,
        createdAt: group.createdAt?.getTime?.()
          ? Math.floor(group.createdAt.getTime() / 1000)
          : (group as any).groupMetadata?.creation ?? 0,
      };
    });
  }

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  async searchMessages(
    query: string,
    groupId?: string,
    limit = 50,
  ): Promise<WhatsAppMessageEntry[]> {
    this.ensureReady();
    return this.mutex.run(async () => {
      log('info', `searchMessages: query="${query}", groupId=${groupId ?? 'all'}, limit=${limit}`);
      const lowerQuery = query.toLowerCase();
      const results: WhatsAppMessageEntry[] = [];

      if (groupId) {
        const chat = await this.getChatById(groupId);
        const messages = await chat.fetchMessages({ limit: 500 });
        for (const m of messages) {
          if (m.body?.toLowerCase().includes(lowerQuery)) {
            results.push(await this.messageToEntry(m));
            if (results.length >= limit) break;
          }
        }
      } else {
        // Cross-group search — all calls already serialized by outer mutex
        const chats = await this.client.getChats();
        const groupChats = chats.filter((c: Chat): c is GroupChat => c.isGroup);

        for (const group of groupChats) {
          if (results.length >= limit) break;

          try {
            const messages = await group.fetchMessages({ limit: 200 });
            for (const m of messages) {
              if (m.body?.toLowerCase().includes(lowerQuery)) {
                results.push(await this.messageToEntry(m));
                if (results.length >= limit) break;
              }
            }
          } catch (err) {
            log('warn', `Failed to search group "${group.name}".`, err);
          }
        }
      }

      log('info', `searchMessages: returning ${results.length} results`);
      return results;
    });
  }

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  async exportChat(groupId: string, limit = 500): Promise<string> {
    this.ensureReady();
    return this.mutex.run(async () => {
      log('info', `exportChat: groupId=${groupId}, limit=${limit}`);
      const chat = await this.getChatById(groupId);
      const messages = await chat.fetchMessages({ limit });

      const lines: string[] = [];

      for (const m of messages) {
        const authorName = await this.resolveAuthorName(m);
        const date = new Date(m.timestamp * 1000);
        const dateStr = format(date, 'dd/MM/yyyy, HH:mm:ss');
        const body = m.hasMedia ? '<Media omitted>' : (m.body || '');

        const bodyLines = body.split('\n');
        const firstLine = `[${dateStr}] ${authorName}: ${bodyLines[0]}`;
        lines.push(firstLine);
        for (let i = 1; i < bodyLines.length; i++) {
          lines.push(bodyLines[i]);
        }
      }

      log('info', `exportChat: returning ${lines.length} lines`);
      return lines.join('\n');
    });
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private registerEventHandlers(): void {
    this.client.on('qr', (qr: string) => {
      log('info', 'QR code received. Scan with your phone:');
      qrcode.generate(qr, { small: true }, (output: string) => {
        process.stderr.write(output + '\n');
      });
    });

    this.client.on('authenticated', () => {
      log('info', 'WhatsApp authentication successful.');
    });

    this.client.on('auth_failure', (msg: string) => {
      log('error', 'WhatsApp authentication failure.', msg);
      this.ready = false;
    });

    this.client.on('ready', () => {
      log('info', 'WhatsApp client is ready.');
      this.ready = true;
    });

    this.client.on('disconnected', (reason: string) => {
      log('warn', `WhatsApp client disconnected: ${reason}`);
      this.ready = false;
    });
  }

  private connectWithTimeout(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`WhatsApp client initialization timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const onReady = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };

      const onAuthFailure = (msg: string) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Authentication failed: ${msg}`));
        }
      };

      this.client.once('ready', onReady);
      this.client.once('auth_failure', onAuthFailure);

      this.client.initialize().catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  private ensureReady(): void {
    if (!this.ready) {
      throw new Error(
        'WhatsApp client is not ready. Call initialize() first and wait for it to resolve.',
      );
    }
  }

  private async getChatById(chatId: string): Promise<Chat> {
    try {
      return await this.client.getChatById(chatId);
    } catch (err) {
      throw new Error(`Chat not found: ${chatId}. ${String(err)}`);
    }
  }

  private async resolveAuthorName(msg: Message): Promise<string> {
    try {
      const contact: Contact = await msg.getContact();
      return contact.pushname || contact.name || contact.number || msg.author || 'Unknown';
    } catch {
      return msg.author || 'Unknown';
    }
  }

  private async messageToEntry(msg: Message): Promise<WhatsAppMessageEntry> {
    const authorName = await this.resolveAuthorName(msg);

    let quotedMsg: WhatsAppMessageEntry['quotedMsg'] | undefined;
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        const quotedAuthor = await this.resolveAuthorName(quoted);
        quotedMsg = { body: quoted.body, author: quotedAuthor };
      } catch {
        // quoted message may have been deleted
      }
    }

    return {
      id: msg.id._serialized,
      body: msg.body || '',
      author: msg.author || msg.from || '',
      authorName,
      timestamp: msg.timestamp,
      hasMedia: msg.hasMedia,
      isForwarded: (msg as any).isForwarded ?? false,
      quotedMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

const instances = new Map<string, WhatsAppClient>();

export function getWhatsAppClient(sessionName = 'default'): WhatsAppClient {
  let instance = instances.get(sessionName);
  if (!instance) {
    instance = new WhatsAppClient(sessionName);
    instances.set(sessionName, instance);
  }
  return instance;
}
