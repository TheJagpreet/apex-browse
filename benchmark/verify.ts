import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

type Arm = 'apex-browse' | 'playwright-mcp' | 'native';
type Trial = {
  sequence: number; trial: number; workload: string; arm: Arm; orderPosition: number; durationMs: number;
  success: boolean; oracleMatched: boolean; timedOut: boolean; exitCode: number | null; expected: unknown; observed: unknown;
  toolCalls: number; toolNames: string[]; toolErrors: number; mcpResultBytes: number; usageAvailable: boolean;
  usage: { input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number; output_tokens: number; reasoning_output_tokens: number };
};

function fail(message: string): never { throw new Error(`Benchmark verification failed: ${message}`); }
function assert(condition: unknown, message: string): asserts condition { if (!condition) fail(message); }
const inputPath = resolve(process.argv[2] ?? 'benchmark/results/raw-luna-2026-08-09.jsonl');
const records = (await readFile(inputPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); } catch { fail(`invalid JSON on raw line ${index + 1}`); }
});
const metadataRecords = records.filter(record => record.type === 'metadata');
assert(metadataRecords.length === 1, `expected one metadata record, found ${metadataRecords.length}`);
const metadata = metadataRecords[0];
const trials = records.filter(record => !record.type) as Trial[];
const expectedCount = metadata.trialCount * metadata.workloads.length * metadata.arms.length;
assert(trials.length === expectedCount, `expected ${expectedCount} trials, found ${trials.length}`);
assert(metadata.model === 'gpt-5.6-luna', `unexpected model ${metadata.model}`);
assert(metadata.reasoningEffort === 'low', `unexpected reasoning effort ${metadata.reasoningEffort}`);
assert(metadata.officialPlaywrightMcpVersion === '0.0.79', `unexpected official MCP version ${metadata.officialPlaywrightMcpVersion}`);
assert(metadata.machineDetailsRedacted === true, 'metadata is not marked machine-details-redacted');
assert(!('environment' in metadata) && !('git' in metadata), 'machine or worktree metadata remains in raw metadata');

function assertSanitized(text: string, label: string): void {
  assert(!/http:\/\/127\.0\.0\.1:\d+/.test(text), `dynamic localhost port remains in ${label}`);
  assert(!/[A-Za-z]:[\\/]{1,2}(?:Users|github|Program Files)[\\/]/i.test(text), `absolute machine path remains in ${label}`);
  assert(!/"thread_id"\s*:\s*"(?!<REDACTED_THREAD_ID>)/.test(text), `unredacted thread id remains in ${label}`);
}
assertSanitized(await readFile(inputPath, 'utf8'), 'raw results');

const keys = new Set<string>();
const sequences = new Set<number>();
const baseOrder: Arm[] = ['apex-browse', 'playwright-mcp', 'native'];
for (const row of trials) {
  const key = `${row.trial}:${row.workload}:${row.arm}`;
  assert(!keys.has(key), `duplicate trial key ${key}`); keys.add(key);
  assert(!sequences.has(row.sequence), `duplicate sequence ${row.sequence}`); sequences.add(row.sequence);
  assert(row.trial >= 1 && row.trial <= metadata.trialCount, `trial number out of range at sequence ${row.sequence}`);
  assert(metadata.workloads.includes(row.workload), `unknown workload at sequence ${row.sequence}`);
  assert(metadata.arms.includes(row.arm), `unknown arm at sequence ${row.sequence}`);
  assert(row.durationMs > 0 && Number.isFinite(row.durationMs), `invalid duration at sequence ${row.sequence}`);
  assert(row.toolCalls === row.toolNames.length, `tool count mismatch at sequence ${row.sequence}`);
  assert(row.toolErrors >= 0 && row.mcpResultBytes >= 0, `negative counter at sequence ${row.sequence}`);
  assert(row.usageAvailable, `missing token measurement at sequence ${row.sequence}`);
  for (const value of Object.values(row.usage)) assert(Number.isFinite(value) && value >= 0, `invalid usage counter at sequence ${row.sequence}`);
  if (row.success) assert(row.oracleMatched && !row.timedOut && row.exitCode === 0, `success invariants failed at sequence ${row.sequence}`);
  if (row.arm === 'native') assert(row.toolCalls === 0 && Object.values(row.usage).every(value => value === 0), `native arm has agent counters at sequence ${row.sequence}`);
  const workloadIndex = metadata.workloads.indexOf(row.workload);
  const rotation = ((row.trial - 1) * metadata.workloads.length + workloadIndex) % baseOrder.length;
  const expectedOrder = [...baseOrder.slice(rotation), ...baseOrder.slice(0, rotation)].filter(arm => metadata.arms.includes(arm));
  assert(expectedOrder[row.orderPosition] === row.arm, `counterbalanced order mismatch at sequence ${row.sequence}`);
}
for (let sequence = 1; sequence <= expectedCount; sequence++) assert(sequences.has(sequence), `missing sequence ${sequence}`);

const transcriptDir = join(dirname(inputPath), `${basename(inputPath, '.jsonl')}-transcripts`);
const transcriptFiles = (await readdir(transcriptDir)).filter(file => file.endsWith('.json'));
const agentTrials = trials.filter(row => row.arm !== 'native');
assert(transcriptFiles.length === agentTrials.length, `expected ${agentTrials.length} transcripts, found ${transcriptFiles.length}`);
for (const row of agentTrials) {
  const filename = `${String(row.sequence).padStart(3, '0')}-${row.arm}-${row.workload}-t${row.trial}.json`;
  assert(transcriptFiles.includes(filename), `missing transcript ${filename}`);
  const transcript = JSON.parse(await readFile(join(transcriptDir, filename), 'utf8'));
  assert(Array.isArray(transcript) && transcript.some(event => event.type === 'turn.completed'), `incomplete transcript ${filename}`);
  assertSanitized(JSON.stringify(transcript), filename);
}

const summary = JSON.parse(await readFile(join(dirname(inputPath), 'summary.json'), 'utf8'));
assert(summary.byArm['apex-browse'].attempts === 50 && summary.byArm['playwright-mcp'].attempts === 50 && summary.byArm.native.attempts === 50, 'summary arm counts are incomplete');
assert(summary.failures.length === trials.filter(row => !row.success).length, 'summary failure count differs from raw data');
assert(!/^[A-Za-z]:[\\/]/.test(summary.source), 'summary source path is absolute');
assertSanitized(JSON.stringify(summary), 'summary');
assertSanitized(await readFile(join(dirname(inputPath), 'report.md'), 'utf8'), 'report');

process.stdout.write(`Verified ${trials.length} unique attempts, ${agentTrials.length} complete agent transcripts, ${records.filter(record => record.type === 'resume').length} resume event, and analyzed artifacts.\n`);
