import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium, type Page } from 'playwright';
import { startBenchmarkServer } from './app.js';
import { workloads, workloadById, type Workload, type WorkloadId } from './workloads.js';

type Arm = 'apex-browse' | 'playwright-mcp' | 'native';
type Usage = { input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number; output_tokens: number; reasoning_output_tokens: number };
type Trial = {
  schemaVersion: 1; runId: string; sequence: number; trial: number; workload: WorkloadId; arm: Arm; orderPosition: number;
  startedAt: string; durationMs: number; success: boolean; oracleMatched: boolean; timedOut: boolean; exitCode: number | null;
  expected: Record<string, unknown>; observed: Record<string, unknown> | null; toolCalls: number; toolNames: string[];
  toolErrors: number; mcpResultBytes: number; agentFinal: string | null; usage: Usage; usageAvailable: boolean;
  apexBrowseReportedDurationMs: number | null; apexBrowseReportedLocalActions: number | null; apexBrowseReportedRepairs: number | null; error: string | null;
};

const OFFICIAL_MCP_VERSION = '0.0.79';
const MODEL = 'gpt-5.6-luna';
const REASONING_EFFORT = 'low';
const require = createRequire(import.meta.url);
const emptyUsage = (): Usage => ({ input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });

function redactString(value: string): string {
  const root = process.cwd();
  return value
    .replaceAll(root, '<REPOSITORY_ROOT>')
    .replaceAll(root.replaceAll('\\', '/'), '<REPOSITORY_ROOT>')
    .replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://benchmark.local')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, '<USER_HOME>')
    .replace(/[A-Za-z]:\/Users\/[^/\s"']+/g, '<USER_HOME>');
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'thread_id' ? '<REDACTED_THREAD_ID>' : redactValue(entry)]));
  return value;
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const trialCount = Number(option('--trials', '10'));
const requestedArms = option('--arms', 'apex-browse,playwright-mcp,native').split(',') as Arm[];
const requestedWorkloads = option('--workloads', workloads.map(item => item.id).join(',')).split(',').map(workloadById);
const timeoutMs = Number(option('--timeout-ms', '120000'));
const outputPath = resolve(option('--output', join('benchmark', 'results', `raw-${new Date().toISOString().replaceAll(':', '-')}.jsonl`)));
const resume = process.argv.includes('--resume');
const validArms: Arm[] = ['apex-browse', 'playwright-mcp', 'native'];
if (!Number.isInteger(trialCount) || trialCount < 1) throw new Error('--trials must be a positive integer');
if (requestedArms.some(arm => !validArms.includes(arm))) throw new Error(`--arms must use ${validArms.join(',')}`);

const taskPrompt = (workload: Workload, url: string) => [
  'Use only the browser MCP tools available in this session.',
  'Do not use shell commands, file tools, web search, or non-browser tools.',
  `Complete this browser task: ${workload.task.replace('{{url}}', url)}`,
  'Stop after verifying the required final state. Reply exactly DONE if completed, otherwise FAILED.',
].join(' ');

async function runNative(page: Page, workload: Workload, url: string): Promise<void> {
  await page.goto(url);
  switch (workload.id) {
    case 'profile': case 'profile-drift':
      await page.getByRole('textbox', { name: 'First name' }).fill('Ada');
      await page.getByRole('textbox', { name: 'Last name' }).fill('Lovelace');
      await page.getByRole('textbox', { name: 'Email' }).fill('ada@example.test');
      await page.getByRole('combobox', { name: 'Role' }).selectOption('admin');
      await page.getByRole('checkbox', { name: 'Terms and conditions' }).check();
      await page.getByRole('button', { name: 'Save profile' }).click();
      await page.getByText('Profile saved').waitFor();
      return;
    case 'dialog':
      await page.getByRole('button', { name: 'Open team settings' }).click();
      await page.getByRole('textbox', { name: 'Team name' }).fill('Platform');
      await page.getByRole('combobox', { name: 'Time zone' }).selectOption('ist');
      await page.getByRole('checkbox', { name: 'Email notifications' }).check();
      await page.getByRole('button', { name: 'Save changes' }).click();
      await page.getByText('Team settings saved').waitFor();
      return;
    case 'renamed-control':
      await page.getByRole('textbox', { name: 'Message' }).fill('Hello');
      await page.getByRole('button', { name: 'Sent' }).click();
      await page.getByText('Message sent').waitFor();
      return;
    case 'catalog':
      await page.getByRole('searchbox', { name: 'Search catalog' }).fill('Samsung S25 Ultra');
      await page.getByRole('button', { name: 'Search' }).click();
      await page.getByRole('link', { name: 'Galaxy S25 Ultra', exact: true }).click();
      await page.getByText('Product details').waitFor();
  }
}

function mcpOverrides(arm: Exclude<Arm, 'native'>): string[] {
  if (arm === 'apex-browse') {
    const server = resolve('dist', 'mcp-server.js').replaceAll('\\', '\\\\');
    return ['-c', `mcp_servers.apex-browse.command="${process.execPath.replaceAll('\\', '\\\\')}"`, '-c', `mcp_servers.apex-browse.args=["${server}"]`];
  }
  return [
    '-c', 'mcp_servers.playwright.command="npx.cmd"',
    '-c', `mcp_servers.playwright.args=["-y","@playwright/mcp@${OFFICIAL_MCP_VERSION}","--headless","--isolated","--image-responses","omit","--browser","chromium"]`,
  ];
}

async function runCodex(arm: Exclude<Arm, 'native'>, prompt: string): Promise<{
  exitCode: number | null; timedOut: boolean; usage: Usage; toolNames: string[]; toolErrors: number;
  mcpResultBytes: number; agentFinal: string | null; usageAvailable: boolean; apexBrowseReportedDurationMs: number | null;
  apexBrowseReportedLocalActions: number | null; apexBrowseReportedRepairs: number | null; error: string | null; transcript: unknown[];
}> {
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--approve-for-me', '--ignore-user-config',
    '-m', MODEL, '-c', `model_reasoning_effort="${REASONING_EFFORT}"`, ...mcpOverrides(arm), prompt];
  const child = spawn('codex.exe', args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = ''; let stderr = ''; let timedOut = false;
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32' && child.pid) spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref();
    else child.kill('SIGKILL');
  }, timeoutMs);
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject); child.once('close', resolveExit);
  }).finally(() => clearTimeout(timer));
  const transcript: unknown[] = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try { transcript.push(JSON.parse(line)); } catch { transcript.push({ type: 'unparsed_stdout', text: line }); }
  }
  const usage = emptyUsage(); let usageAvailable = false; const toolNames: string[] = []; let toolErrors = 0; let mcpResultBytes = 0; let agentFinal: string | null = null;
  let apexBrowseReportedDurationMs: number | null = null; let apexBrowseReportedLocalActions: number | null = null; let apexBrowseReportedRepairs: number | null = null;
  for (const event of transcript as Array<Record<string, any>>) {
    if (event.type === 'turn.completed' && event.usage) {
      usageAvailable = true;
      for (const key of Object.keys(usage) as Array<keyof Usage>) usage[key] = Number(event.usage[key] ?? 0);
    }
    const item = event.item;
    if (event.type === 'item.completed' && item?.type === 'mcp_tool_call') {
      toolNames.push(`${item.server ?? 'mcp'}.${item.tool ?? item.name ?? 'unknown'}`);
      if (item.error || item.status === 'failed') toolErrors++;
      if (item.result !== undefined) mcpResultBytes += Buffer.byteLength(JSON.stringify(item.result));
      if (item.server === 'apex-browse' && item.result?.content) {
        for (const content of item.result.content) {
          if (content.type !== 'text') continue;
          try {
            const payload = JSON.parse(content.text);
            if (payload.metrics) {
              apexBrowseReportedDurationMs = Math.max(apexBrowseReportedDurationMs ?? 0, Number(payload.metrics.durationMs ?? 0));
              apexBrowseReportedLocalActions = Math.max(apexBrowseReportedLocalActions ?? 0, Number(payload.metrics.localActions ?? 0));
              apexBrowseReportedRepairs = Math.max(apexBrowseReportedRepairs ?? 0, Number(payload.metrics.repairs ?? 0));
            }
          } catch { /* A validation error is not a JSON receipt. */ }
        }
      }
    }
    if (event.type === 'item.completed' && item?.type === 'agent_message') agentFinal = String(item.text ?? '');
  }
  const error = timedOut ? `Timed out after ${timeoutMs}ms` : exitCode === 0 ? null : stderr.trim().slice(0, 4000) || `Codex exited ${exitCode}`;
  return { exitCode, timedOut, usage, usageAvailable, toolNames, toolErrors, mcpResultBytes, agentFinal,
    apexBrowseReportedDurationMs, apexBrowseReportedLocalActions, apexBrowseReportedRepairs, error, transcript };
}

function rotatedOrder(index: number): Arm[] {
  const base: Arm[] = ['apex-browse', 'playwright-mcp', 'native'];
  const rotation = index % base.length;
  return [...base.slice(rotation), ...base.slice(0, rotation)].filter(arm => requestedArms.includes(arm));
}

await mkdir(dirname(outputPath), { recursive: true });
const transcriptDir = join(dirname(outputPath), `${outputPath.slice(outputPath.lastIndexOf('\\') + 1, -6)}-transcripts`);
await mkdir(transcriptDir, { recursive: true });
const app = await startBenchmarkServer();
const createdRunId = new Date().toISOString();
const newMetadata = {
  schemaVersion: 1, type: 'metadata', runId: createdRunId, createdAt: createdRunId, model: MODEL, reasoningEffort: REASONING_EFFORT,
  officialPlaywrightMcpVersion: OFFICIAL_MCP_VERSION, playwrightVersion: require('playwright/package.json').version,
  apexBrowseVersion: '0.1.0', codexCliVersion: spawnSync('codex.exe', ['--version'], { encoding: 'utf8' }).stdout.trim(), trialCount,
  arms: requestedArms, workloads: requestedWorkloads.map(item => item.id), timeoutMs,
  counterbalancing: 'cyclic Latin order across workload-trial pairs', cachePolicy: 'fresh isolated browser/MCP/Codex process per trial; npm package cache warm',
  agentPromptTemplate: taskPrompt(requestedWorkloads[0], '{{url}}').replace(requestedWorkloads[0].task.replace('{{url}}', '{{url}}'), '{{task}}'),
  apexBrowseMcpCommand: 'node dist/mcp-server.js',
  officialMcpCommand: `npx.cmd -y @playwright/mcp@${OFFICIAL_MCP_VERSION} --headless --isolated --image-responses omit --browser chromium`,
  runtime: { node: process.version }, machineDetailsRedacted: true,
};
let runId = createdRunId;
let sequence = 0;
const completed = new Set<string>();
if (resume) {
  const existing = (await readFile(outputPath, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const metadata = existing.find(record => record.type === 'metadata');
  if (!metadata) throw new Error('--resume file has no metadata record');
  const same = metadata.model === MODEL && metadata.reasoningEffort === REASONING_EFFORT && metadata.trialCount === trialCount
    && JSON.stringify(metadata.arms) === JSON.stringify(requestedArms) && JSON.stringify(metadata.workloads) === JSON.stringify(requestedWorkloads.map(item => item.id))
    && metadata.officialPlaywrightMcpVersion === OFFICIAL_MCP_VERSION;
  if (!same) throw new Error('--resume arguments or pinned versions do not match the existing run metadata');
  runId = metadata.runId;
  for (const record of existing.filter(record => !record.type) as Trial[]) {
    const key = `${record.trial}:${record.workload}:${record.arm}`;
    if (completed.has(key)) throw new Error(`Duplicate completed attempt in resume file: ${key}`);
    completed.add(key); sequence = Math.max(sequence, record.sequence);
  }
  await appendFile(outputPath, `${JSON.stringify({ schemaVersion: 1, type: 'resume', runId, resumedAt: new Date().toISOString(), completedAttempts: completed.size })}\n`);
  process.stdout.write(`Resuming ${outputPath} after ${completed.size} completed attempts\n`);
} else {
  await writeFile(outputPath, `${JSON.stringify(newMetadata)}\n`, { flag: 'wx' });
}
try {
  for (let trial = 1; trial <= trialCount; trial++) {
    for (let workloadIndex = 0; workloadIndex < requestedWorkloads.length; workloadIndex++) {
      const workload = requestedWorkloads[workloadIndex];
      const order = rotatedOrder((trial - 1) * requestedWorkloads.length + workloadIndex);
      for (let orderPosition = 0; orderPosition < order.length; orderPosition++) {
        const arm = order[orderPosition];
        if (completed.has(`${trial}:${workload.id}:${arm}`)) continue;
        sequence++; app.reset(workload.id);
        const url = `${app.baseUrl}${workload.path}`; const startedAt = new Date().toISOString(); const started = performance.now();
        let exitCode: number | null = 0; let timedOut = false; let usage = emptyUsage(); let toolNames: string[] = [];
        let toolErrors = 0; let mcpResultBytes = 0; let agentFinal: string | null = null; let error: string | null = null; let usageAvailable = arm === 'native';
        let apexBrowseReportedDurationMs: number | null = null; let apexBrowseReportedLocalActions: number | null = null; let apexBrowseReportedRepairs: number | null = null;
        try {
          if (arm === 'native') {
            const browser = await chromium.launch({ headless: true });
            try { await runNative(await browser.newPage(), workload, url); } finally { await browser.close(); }
          } else {
            const result = await runCodex(arm, taskPrompt(workload, url));
            ({ exitCode, timedOut, usage, usageAvailable, toolNames, toolErrors, mcpResultBytes, agentFinal, apexBrowseReportedDurationMs, apexBrowseReportedLocalActions, apexBrowseReportedRepairs, error } = result);
            await writeFile(join(transcriptDir, `${String(sequence).padStart(3, '0')}-${arm}-${workload.id}-t${trial}.json`), JSON.stringify(redactValue(result.transcript), null, 2));
          }
        } catch (cause) { exitCode = null; error = cause instanceof Error ? cause.stack ?? cause.message : String(cause); }
        const durationMs = Math.round((performance.now() - started) * 100) / 100;
        const outcome = app.outcome(workload.id); const observed = outcome?.payload ?? null; const oracleMatched = isDeepStrictEqual(observed, workload.expected);
        const record: Trial = { schemaVersion: 1, runId, sequence, trial, workload: workload.id, arm, orderPosition,
          startedAt, durationMs, success: oracleMatched && !timedOut && exitCode === 0, oracleMatched, timedOut, exitCode,
          expected: workload.expected, observed, toolCalls: toolNames.length, toolNames, toolErrors, mcpResultBytes, agentFinal, usage, usageAvailable,
          apexBrowseReportedDurationMs, apexBrowseReportedLocalActions, apexBrowseReportedRepairs, error: error ? redactString(error) : null };
        await appendFile(outputPath, `${JSON.stringify(record)}\n`);
        process.stdout.write(`[${sequence}] t${trial} ${workload.id} ${arm}: ${record.success ? 'PASS' : 'FAIL'} ${Math.round(durationMs)}ms tools=${toolNames.length} tokens=${usage.input_tokens + usage.output_tokens}\n`);
      }
    }
  }
} finally { await app.close(); }
process.stdout.write(`Raw results: ${outputPath}\n`);
