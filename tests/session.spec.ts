import { expect, test } from '@playwright/test';
import { ApexSession, runWithOneRepair, type Program } from '../src/index.js';
import { startFixtureApp } from './fixture-app.js';

const send = (url: string, button = 'Send'): Program => ({ steps: [
  { op: 'navigate', url },
  { op: 'fill', target: { role: 'textbox', name: 'Email' }, value: 'ada@example.test' },
  { op: 'click', target: { role: 'button', name: button } },
  { op: 'expect', text: 'Message sent' },
] });

test('executes a complete program locally with no repair', async () => {
  const app = await startFixtureApp(); const session = new ApexSession();
  try {
    const result = await session.run(send(app.url('/send')));
    expect(result).toMatchObject({ status: 'success', metrics: { localActions: 3, repairs: 0 } });
    if (result.status === 'success') expect(result.receipts).toHaveLength(4);
  } finally { await session.close(); await app.close(); }
});

test('returns one compact repair packet and resumes after a target rename', async () => {
  const app = await startFixtureApp(); const session = new ApexSession();
  try {
    const first = await session.run(send(app.url('/sent')));
    expect(first).toMatchObject({ status: 'needs_repair', repair: { reason: 'missing', step: 2, candidates: [expect.objectContaining({ name: 'Sent' })] } });
    if (first.status !== 'needs_repair') throw new Error('Expected repair');
    const repaired = await session.repair(first.repair.runId, { role: 'button', name: 'Sent' });
    expect(repaired).toMatchObject({ status: 'success', metrics: { repairs: 1 } });
  } finally { await session.close(); await app.close(); }
});

test('reports a missing target without serializing the full page', async () => {
  const app = await startFixtureApp(); const session = new ApexSession();
  try {
    const result = await session.run(send(app.url('/missing')));
    expect(result).toMatchObject({ status: 'needs_repair', repair: { reason: 'missing', candidates: [] } });
  } finally { await session.close(); await app.close(); }
});

test('uses configured aliases locally before asking a model to repair', async () => {
  const app = await startFixtureApp(); const session = new ApexSession();
  try {
    const program = send(app.url('/sent')); (program.steps[2] as { target: { aliases?: string[] } }).target.aliases = ['Sent'];
    const result = await session.run(program);
    expect(result).toMatchObject({ status: 'success', metrics: { repairs: 0 } });
    if (result.status === 'success') expect(result.receipts[2].resolved).toMatchObject({ name: 'Sent', via: 'normalized' });
  } finally { await session.close(); await app.close(); }
});

test('host loop exposes only one bounded repair decision to the model', async () => {
  const app = await startFixtureApp(); const session = new ApexSession();
  try {
    const result = await runWithOneRepair(session, send(app.url('/sent')), async packet => {
      expect(packet.candidates).toEqual([expect.objectContaining({ role: 'button', name: 'Sent' })]);
      return { role: 'button', name: 'Sent' };
    });
    expect(result).toMatchObject({ status: 'success', metrics: { repairs: 1 } });
  } finally { await session.close(); await app.close(); }
});

test('does not mutate when a mutating target is ambiguous', async () => {
  const app = await startFixtureApp(); const session = new ApexSession();
  try {
    const result = await session.run({ steps: [{ op: 'navigate', url: app.url('/ambiguous') }, { op: 'click', target: { role: 'button', name: 'Send' } }] });
    expect(result).toMatchObject({ status: 'ambiguous', repair: { reason: 'ambiguous' } });
    expect((await session.snapshot()).visibleText).not.toContain('mutated');
  } finally { await session.close(); await app.close(); }
});

test('rejects a repair target that was not present in the bounded repair packet', async () => {
  const app = await startFixtureApp(); const session = new ApexSession();
  try {
    const result = await session.run(send(app.url('/sent')));
    if (result.status !== 'needs_repair') throw new Error('Expected repair');
    await expect(session.repair(result.repair.runId, { role: 'button', name: 'Delete account' })).rejects.toThrow('bounded candidates');
  } finally { await session.close(); await app.close(); }
});

test('resolves controls scoped inside a dynamically created dialog', async () => {
  const app = await startFixtureApp(); const session = new ApexSession();
  try {
    const result = await session.run({ steps: [
      { op: 'navigate', url: app.url('/dialog') },
      { op: 'click', target: { role: 'button', name: 'Open composer' } },
      { op: 'fill', target: { role: 'textbox', name: 'Message', scope: { role: 'dialog', name: 'Composer' } }, value: 'Hello' },
      { op: 'click', target: { role: 'button', name: 'Send', scope: { role: 'dialog', name: 'Composer' } } },
      { op: 'expect', text: 'Message sent' },
    ] });
    expect(result).toMatchObject({ status: 'success' });
  } finally { await session.close(); await app.close(); }
});

test('uses the accessible select label, accepts a visible option label, and omits hidden controls', async () => {
  const app = await startFixtureApp(); const session = new ApexSession();
  try {
    const initial = await session.navigate(app.url('/select'));
    expect(initial.controls).toContainEqual(expect.objectContaining({ role: 'combobox', name: 'Role' }));
    expect(initial.controls).not.toContainEqual(expect.objectContaining({ name: 'Hidden action' }));
    const result = await session.run({ steps: [
      { op: 'select', target: { role: 'combobox', name: 'Role' }, value: 'Administrator' },
      { op: 'expect', text: 'admin' },
    ] });
    expect(result).toMatchObject({ status: 'success' });
  } finally { await session.close(); await app.close(); }
});

test('requires confirmation for high-impact actions', async () => {
  const app = await startFixtureApp(); const session = new ApexSession();
  try {
    const result = await session.run({ steps: [{ op: 'navigate', url: app.url('/delete') }, { op: 'click', target: { role: 'button', name: 'Delete account' } }] });
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('Host confirmation required') });
  } finally { await session.close(); await app.close(); }
});

test('requires an out-of-band host approval even when the DSL requests confirmation', async () => {
  const app = await startFixtureApp(); const denied = new ApexSession(); const approved = new ApexSession({ approveHighImpact: async () => true });
  const program: Program = { steps: [{ op: 'navigate', url: app.url('/delete') }, { op: 'click', target: { role: 'button', name: 'Delete account' }, confirm: true }, { op: 'expect', text: 'deleted' }] };
  try {
    await expect(denied.run(program)).resolves.toMatchObject({ status: 'failed' });
    await expect(approved.run(program)).resolves.toMatchObject({ status: 'success' });
  } finally { await denied.close(); await approved.close(); await app.close(); }
});
