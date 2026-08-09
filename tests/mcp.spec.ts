import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApexBrowseSession, createApexBrowseMcpServer, parseProgram } from '../src/index.js';
import { startFixtureApp } from './fixture-app.js';

test('exposes the session-oriented MCP surface and performs a one-call run', async () => {
  const app = await startFixtureApp(); const session = new ApexBrowseSession(); const server = createApexBrowseMcpServer(session); const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['apex_browse_evidence', 'apex_browse_navigate', 'apex_browse_repair', 'apex_browse_run', 'apex_browse_search', 'apex_browse_snapshot']);
    const program = { steps: [{ op: 'navigate', url: app.url('/send') }, { op: 'fill', target: { role: 'textbox', name: 'Email' }, value: 'ada@example.test' }, { op: 'click', target: { role: 'button', name: 'Send' } }, { op: 'expect', text: 'Message sent' }] };
    const result = await client.callTool({ name: 'apex_browse_run', arguments: { programJson: JSON.stringify(program) } });
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"status":"success"') });
  } finally { await session.close(); await client.close(); await server.close(); await app.close(); }
});

test('uses bounded MCP discovery, repair, and evidence tools', async () => {
  const app = await startFixtureApp(); const session = new ApexBrowseSession(); const server = createApexBrowseMcpServer(session); const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const navigated = await client.callTool({ name: 'apex_browse_navigate', arguments: { url: app.url('/sent') } });
    expect(navigated.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"untrusted":true') });
    const search = await client.callTool({ name: 'apex_browse_search', arguments: { query: 'sent' } });
    expect(search.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"name":"Sent"') });
    const program = { steps: [{ op: 'click', target: { role: 'button', name: 'Send' } }, { op: 'expect', text: 'Message sent' }] };
    const attempted = await client.callTool({ name: 'apex_browse_run', arguments: { programJson: JSON.stringify(program) } });
    const pending = JSON.parse((attempted.content[0] as { text: string }).text);
    expect(pending).toMatchObject({ status: 'needs_repair' });
    const repaired = await client.callTool({ name: 'apex_browse_repair', arguments: { runId: pending.repair.runId, target: { role: 'button', name: 'Sent' } } });
    const complete = JSON.parse((repaired.content[0] as { text: string }).text);
    expect(complete).toMatchObject({ status: 'success' });
    const evidence = await client.callTool({ name: 'apex_browse_evidence', arguments: { evidenceId: complete.evidenceIds[0] } });
    expect(evidence.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"op":"click"') });
  } finally { await session.close(); await client.close(); await server.close(); await app.close(); }
});

test('rejects arbitrary browser code in the DSL', () => {
  expect(() => parseProgram({ steps: [{ op: 'evaluate', code: 'document.body.innerHTML = "unsafe"' }] })).toThrow();
});
