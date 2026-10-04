import { describe, it, expect } from 'vitest';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools.js';

type Tool = { name: string; annotations?: { readOnlyHint?: boolean } };

async function listTools(): Promise<Tool[]> {
  const handlers = new Map<unknown, () => Promise<{ tools: Tool[] }>>();
  const fakeServer = { setRequestHandler: (schema: unknown, fn: () => Promise<{ tools: Tool[] }>) => handlers.set(schema, fn) };
  registerTools(fakeServer as never, {} as never);
  return (await handlers.get(ListToolsRequestSchema)!()).tools;
}

describe('tool annotations', () => {
  it('marks every tool, and only the two send tools as writes', async () => {
    const tools = await listTools();
    expect(tools).toHaveLength(8);
    for (const t of tools) expect(t.annotations, t.name).toBeDefined();
    const writes = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
    expect(writes).toEqual(['whatsapp_reply_to_message', 'whatsapp_send_message']);
  });
});
