import { parse, isValid } from 'date-fns';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedMessage {
  platform: string;
  timestamp: Date;
  author: string;
  body: string;
  isMedia: boolean;
  isSystem: boolean;
}

export interface ParsedChat {
  platform: string;
  messages: ParsedMessage[];
  participants: string[];
  dateRange: { start: Date; end: Date };
  messageCount: number;
}

export type ChatFormat = 'whatsapp' | 'signal' | 'raw' | 'mcp-json' | 'auto';

// ---------------------------------------------------------------------------
// Media & system message patterns
// ---------------------------------------------------------------------------

const MEDIA_PATTERNS = [
  '<media omitted>',
  'image omitted',
  'video omitted',
  'audio omitted',
  'gif omitted',
  'sticker omitted',
  'document omitted',
  'contact card omitted',
];

const SYSTEM_PATTERNS = [
  /^messages and calls are end-to-end encrypted/i,
  /^your security code .* changed/i,
  /^.+ created group ".+"/i,
  /^.+ added .+/i,
  /^.+ removed .+/i,
  /^.+ left$/i,
  /^.+ changed the group/i,
  /^.+ changed this group/i,
  /^.+ changed the subject/i,
  /^.+ changed the description/i,
  /^you're now an admin$/i,
  /^.+ is now an admin$/i,
  /^this message was deleted$/i,
  /^you deleted this message$/i,
  /^.+ pinned a message$/i,
  /^waiting for this message/i,
  /^.+ joined using this group/i,
];

// ---------------------------------------------------------------------------
// WhatsApp .txt format parsers
// ---------------------------------------------------------------------------

// Format 1: [DD/MM/YYYY, HH:MM:SS] Name: Message
const WA_BRACKET_RE = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+?):\s(.*)$/;

// Format 2: DD/MM/YYYY, HH:MM - Name: Message
const WA_DASH_RE = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*(.+?):\s(.*)$/;

// System messages (no author) in bracket format
const WA_BRACKET_SYSTEM_RE = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+)$/;

// System messages in dash format
const WA_DASH_SYSTEM_RE = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*(.+)$/;

// ---------------------------------------------------------------------------
// Signal format parser
// ---------------------------------------------------------------------------

// Signal: [YYYY-MM-DD HH:MM] Name: Message
const SIGNAL_RE = /^\[(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+?):\s(.*)$/;

// ---------------------------------------------------------------------------
// Date parsing helpers
// ---------------------------------------------------------------------------

function parseWhatsAppDate(dateStr: string, timeStr: string): Date {
  // Try DD/MM/YYYY first, then MM/DD/YYYY
  const formats = [
    `dd/MM/yyyy, ${timeStr.includes(':') && timeStr.split(':').length === 3 ? 'HH:mm:ss' : 'HH:mm'}`,
    `MM/dd/yyyy, ${timeStr.includes(':') && timeStr.split(':').length === 3 ? 'HH:mm:ss' : 'HH:mm'}`,
  ];

  const combined = `${dateStr}, ${timeStr}`;

  for (const fmt of formats) {
    const parsed = parse(combined, fmt, new Date());
    if (isValid(parsed)) return parsed;
  }

  // Fallback: try native Date constructor
  const fallback = new Date(`${dateStr} ${timeStr}`);
  if (isValid(fallback)) return fallback;

  return new Date(0); // Invalid date sentinel
}

function parseSignalDate(dateStr: string, timeStr: string): Date {
  const combined = `${dateStr}T${timeStr}`;
  const parsed = new Date(combined);
  if (isValid(parsed)) return parsed;
  return new Date(0);
}

// ---------------------------------------------------------------------------
// Detect if a line is a message start (vs continuation)
// ---------------------------------------------------------------------------

function isMessageStart(line: string): boolean {
  return (
    WA_BRACKET_RE.test(line) ||
    WA_DASH_RE.test(line) ||
    WA_BRACKET_SYSTEM_RE.test(line) ||
    WA_DASH_SYSTEM_RE.test(line) ||
    SIGNAL_RE.test(line)
  );
}

// ---------------------------------------------------------------------------
// Detect media and system messages
// ---------------------------------------------------------------------------

function isMediaMessage(body: string): boolean {
  const lower = body.toLowerCase().trim();
  return MEDIA_PATTERNS.some((p) => lower.includes(p));
}

function isSystemMessage(body: string): boolean {
  return SYSTEM_PATTERNS.some((p) => p.test(body.trim()));
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): ChatFormat {
  const sample = lines.slice(0, 10);

  let waBracket = 0;
  let waDash = 0;
  let signal = 0;

  for (const line of sample) {
    if (WA_BRACKET_RE.test(line) || WA_BRACKET_SYSTEM_RE.test(line)) waBracket++;
    if (WA_DASH_RE.test(line) || WA_DASH_SYSTEM_RE.test(line)) waDash++;
    if (SIGNAL_RE.test(line)) signal++;
  }

  if (waBracket >= 2) return 'whatsapp';
  if (waDash >= 2) return 'whatsapp';
  if (signal >= 2) return 'signal';

  // Try MCP JSON
  const joined = lines.join('\n').trim();
  if (joined.startsWith('[') || joined.startsWith('{')) {
    try {
      JSON.parse(joined);
      return 'mcp-json';
    } catch {
      // not JSON
    }
  }

  return 'raw';
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseWhatsApp(lines: string[]): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  let currentMsg: ParsedMessage | null = null;

  for (const line of lines) {
    // Try bracket format with author
    let match = WA_BRACKET_RE.exec(line);
    if (match) {
      if (currentMsg) messages.push(currentMsg);
      const body = match[4];
      currentMsg = {
        platform: 'whatsapp',
        timestamp: parseWhatsAppDate(match[1], match[2]),
        author: match[3].trim(),
        body,
        isMedia: isMediaMessage(body),
        isSystem: false,
      };
      continue;
    }

    // Try dash format with author
    match = WA_DASH_RE.exec(line);
    if (match) {
      if (currentMsg) messages.push(currentMsg);
      const body = match[4];
      currentMsg = {
        platform: 'whatsapp',
        timestamp: parseWhatsAppDate(match[1], match[2]),
        author: match[3].trim(),
        body,
        isMedia: isMediaMessage(body),
        isSystem: false,
      };
      continue;
    }

    // Try bracket system message (no colon-separated author)
    match = WA_BRACKET_SYSTEM_RE.exec(line);
    if (match && !WA_BRACKET_RE.test(line)) {
      if (currentMsg) messages.push(currentMsg);
      const body = match[3];
      currentMsg = {
        platform: 'whatsapp',
        timestamp: parseWhatsAppDate(match[1], match[2]),
        author: 'System',
        body,
        isMedia: false,
        isSystem: true,
      };
      continue;
    }

    // Try dash system message
    match = WA_DASH_SYSTEM_RE.exec(line);
    if (match && !WA_DASH_RE.test(line)) {
      if (currentMsg) messages.push(currentMsg);
      const body = match[3];
      currentMsg = {
        platform: 'whatsapp',
        timestamp: parseWhatsAppDate(match[1], match[2]),
        author: 'System',
        body,
        isMedia: false,
        isSystem: true,
      };
      continue;
    }

    // Continuation line — append to current message
    if (currentMsg && line.trim() !== '') {
      currentMsg.body += '\n' + line;
    }
  }

  if (currentMsg) messages.push(currentMsg);
  return messages;
}

function parseSignal(lines: string[]): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  let currentMsg: ParsedMessage | null = null;

  for (const line of lines) {
    const match = SIGNAL_RE.exec(line);
    if (match) {
      if (currentMsg) messages.push(currentMsg);
      const body = match[4];
      currentMsg = {
        platform: 'signal',
        timestamp: parseSignalDate(match[1], match[2]),
        author: match[3].trim(),
        body,
        isMedia: isMediaMessage(body),
        isSystem: isSystemMessage(body),
      };
      continue;
    }

    // Continuation line
    if (currentMsg && line.trim() !== '') {
      currentMsg.body += '\n' + line;
    }
  }

  if (currentMsg) messages.push(currentMsg);
  return messages;
}

interface McpMessage {
  id?: string;
  body?: string;
  author?: string;
  authorName?: string;
  timestamp?: number;
  hasMedia?: boolean;
  isForwarded?: boolean;
  quotedMsg?: { body: string; author: string };
}

function parseMcpJson(input: string): ParsedMessage[] {
  const data = JSON.parse(input);
  const items: McpMessage[] = Array.isArray(data) ? data : [data];

  return items
    .filter((m) => m.body !== undefined || m.hasMedia)
    .map((m) => ({
      platform: 'whatsapp',
      timestamp: new Date((m.timestamp ?? 0) * 1000),
      author: m.authorName || m.author || 'Unknown',
      body: m.body || '',
      isMedia: m.hasMedia ?? false,
      isSystem: isSystemMessage(m.body || ''),
    }));
}

function parseRaw(lines: string[]): ParsedMessage[] {
  // Best-effort: treat each non-empty line as a message
  // Try to detect "Name: message" pattern
  const nameColonRe = /^([^:]{1,40}):\s+(.+)$/;
  const messages: ParsedMessage[] = [];
  const now = new Date();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = nameColonRe.exec(trimmed);
    if (match) {
      messages.push({
        platform: 'raw',
        timestamp: now,
        author: match[1].trim(),
        body: match[2],
        isMedia: isMediaMessage(match[2]),
        isSystem: isSystemMessage(match[2]),
      });
    } else {
      // No author detected
      messages.push({
        platform: 'raw',
        timestamp: now,
        author: 'Unknown',
        body: trimmed,
        isMedia: isMediaMessage(trimmed),
        isSystem: false,
      });
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function parseChat(input: string, format: ChatFormat = 'auto'): ParsedChat {
  const lines = input.split('\n');

  // Auto-detect format if needed
  const detectedFormat = format === 'auto' ? detectFormat(lines) : format;

  let messages: ParsedMessage[];

  switch (detectedFormat) {
    case 'whatsapp':
      messages = parseWhatsApp(lines);
      break;
    case 'signal':
      messages = parseSignal(lines);
      break;
    case 'mcp-json':
      messages = parseMcpJson(input);
      break;
    case 'raw':
      messages = parseRaw(lines);
      break;
    default:
      messages = parseRaw(lines);
  }

  // Filter out empty messages
  messages = messages.filter((m) => m.body.trim() !== '' || m.isMedia);

  // Extract unique participants (excluding System)
  const participants = [...new Set(
    messages
      .filter((m) => !m.isSystem && m.author !== 'System' && m.author !== 'Unknown')
      .map((m) => m.author),
  )];

  // Calculate date range
  const timestamps = messages.map((m) => m.timestamp.getTime()).filter((t) => t > 0);
  const dateRange = {
    start: timestamps.length > 0 ? new Date(Math.min(...timestamps)) : new Date(),
    end: timestamps.length > 0 ? new Date(Math.max(...timestamps)) : new Date(),
  };

  return {
    platform: detectedFormat === 'auto' ? 'unknown' : detectedFormat,
    messages,
    participants,
    dateRange,
    messageCount: messages.length,
  };
}
