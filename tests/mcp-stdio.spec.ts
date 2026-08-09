import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { startFixtureApp } from './fixture-app.js';

test('serves the Apex MCP surface over stdio', async () => {
  const app = await startFixtureApp();
  const root = fileURLToPath(new URL('../', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [`${root}dist/mcp-server.js`], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1' });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: 'apex_navigate', arguments: { url: app.url('/send') } });
    expect(response.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"revision":1') });
  } finally { await client.close(); await app.close(); }
});
