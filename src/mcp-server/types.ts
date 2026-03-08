import { z } from 'zod';

// ── WhatsApp Group ──────────────────────────────────────────────────────────

export const WhatsAppGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  memberCount: z.number().int().nonnegative(),
  lastMessage: z.string().optional(),
  lastActivityTimestamp: z.number().int().nonnegative(),
});

export type WhatsAppGroup = z.infer<typeof WhatsAppGroupSchema>;

// ── WhatsApp Message ────────────────────────────────────────────────────────

export const WhatsAppMessageSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: z.string(),
  authorName: z.string(),
  timestamp: z.number().int().nonnegative(),
  hasMedia: z.boolean(),
  isForwarded: z.boolean(),
  quotedMsg: z
    .object({
      body: z.string(),
      author: z.string(),
    })
    .optional(),
});

export type WhatsAppMessage = z.infer<typeof WhatsAppMessageSchema>;

// ── Group Info ──────────────────────────────────────────────────────────────

export const GroupParticipantSchema = z.object({
  id: z.string(),
  name: z.string(),
  isAdmin: z.boolean(),
});

export type GroupParticipant = z.infer<typeof GroupParticipantSchema>;

export const GroupInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  participants: z.array(GroupParticipantSchema),
  createdAt: z.number().int().nonnegative(),
});

export type GroupInfo = z.infer<typeof GroupInfoSchema>;

// ── Export Options ──────────────────────────────────────────────────────────

export const ExportOptionsSchema = z.object({
  groupName: z.string().min(1, 'Group name is required'),
  limit: z.number().int().positive().max(500).default(500),
});

export type ExportOptions = z.infer<typeof ExportOptionsSchema>;

// ── Tool Input Schemas ──────────────────────────────────────────────────────

export const ListGroupsInputSchema = z.object({});

export type ListGroupsInput = z.infer<typeof ListGroupsInputSchema>;

export const GetMessagesInputSchema = z.object({
  groupName: z.string().min(1, 'Group name is required'),
  limit: z.number().int().positive().max(500).default(200),
  afterDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .optional(),
  beforeDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .optional(),
});

export type GetMessagesInput = z.infer<typeof GetMessagesInputSchema>;

export const ExportChatInputSchema = z.object({
  groupName: z.string().min(1, 'Group name is required'),
  limit: z.number().int().positive().max(500).default(500),
});

export type ExportChatInput = z.infer<typeof ExportChatInputSchema>;

export const SearchMessagesInputSchema = z.object({
  query: z.string().min(1, 'Search query is required'),
  groupName: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).default(50),
});

export type SearchMessagesInput = z.infer<typeof SearchMessagesInputSchema>;

export const GroupInfoInputSchema = z.object({
  groupName: z.string().min(1, 'Group name is required'),
});

export type GroupInfoInput = z.infer<typeof GroupInfoInputSchema>;

export const SendMessageInputSchema = z.object({
  groupName: z.string().min(1, 'Group name is required'),
  message: z.string().min(1, 'Message text is required'),
});

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const ReplyToMessageInputSchema = z.object({
  groupName: z.string().min(1, 'Group name is required'),
  messageId: z.string().min(1, 'Message ID to reply to is required'),
  message: z.string().min(1, 'Reply text is required'),
});

export type ReplyToMessageInput = z.infer<typeof ReplyToMessageInputSchema>;
