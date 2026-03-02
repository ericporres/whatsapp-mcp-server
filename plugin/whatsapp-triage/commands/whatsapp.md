---
name: whatsapp
description: WhatsApp group chat intelligence — pull messages and produce a structured briefing
allowed-tools: mcp__*__whatsapp_*, Bash, Read, Write, Edit, WebSearch
---

## WhatsApp Group Chat Triage

When the user says `/whatsapp`, pull messages from their WhatsApp groups and produce
an intelligence briefing. Use the WhatsApp MCP tools to list groups, fetch messages,
and search across conversations.

### Default Behavior

1. Call `whatsapp_list_groups` to see all available groups
2. Ask the user which groups to analyze (or use their configured defaults)
3. For each selected group, call `whatsapp_get_messages` (last 48 hours by default)
4. Analyze the messages using the chat intelligence processor
5. Present a structured briefing with themes, ideas, opportunities, and action items

### Tips

- Use `whatsapp_search_messages` to find specific topics across all groups
- Use `whatsapp_export_chat` for full conversation exports
- When multiple groups are analyzed, include cross-group synthesis
