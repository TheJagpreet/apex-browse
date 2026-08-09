import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

type Arm = 'apex' | 'playwright-mcp' | 'native';
type Usage = { input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number; output_tokens: number; reasoning_output_tokens: number };
type Trial = { type?: string; sequence: number; trial: number; workload: string; arm: Arm; durationMs: number; success: boolean; oracleMatched: boolean; timedOut: boolean; exitCode: number | null; toolCalls: number; toolNames: string[]; toolErrors: number; mcpResultBytes: number; agentFinal: string | null; error: string | null; usage: Usage; usageAvailable?: boolean; apexReportedDurationMs?: number | null };
type Distribution = { n: number; mean: number; stddev: number; p50: number; p95: number; min: number; max: number };

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const percentile = (values: number[], probability: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b); const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index); const fraction = index - lower;
  return sorted[lower] + (sorted[lower + 1] === undefined ? 0 : fraction * (sorted[lower + 1] - sorted[lower]));
};
const distribution = (values: number[]): Distribution => {
  if (!values.length) return { n: 0, mean: 0, stddev: 0, p50: 0, p95: 0, min: 0, max: 0 };
  const average = mean(values); const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1) : 0;
  return { n: values.length, mean: round(average), stddev: round(Math.sqrt(variance)), p50: round(percentile(values, .5)), p95: round(percentile(values, .95)), min: round(Math.min(...values)), max: round(Math.max(...values)) };
};
const totalTokens = (trial: Trial) => trial.usage.input_tokens + trial.usage.output_tokens;
const estimatedUsd = (trial: Trial) => {
  const uncached = Math.max(0, trial.usage.input_tokens - trial.usage.cached_input_tokens - trial.usage.cache_write_input_tokens);
  return (uncached * 1.00 + trial.usage.cached_input_tokens * .10 + trial.usage.cache_write_input_tokens * 1.25 + trial.usage.output_tokens * 6.00) / 1_000_000;
};

let randomState = 0xA93F21;
const random = () => { randomState |= 0; randomState = randomState + 0x6D2B79F5 | 0; let t = Math.imul(randomState ^ randomState >>> 15, 1 | randomState); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const bootstrapMeanCi = (values: number[], iterations = 10_000): [number, number] => {
  if (!values.length) return [0, 0];
  const estimates = Array.from({ length: iterations }, () => mean(Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)])));
  return [round(percentile(estimates, .025)), round(percentile(estimates, .975))];
};

async function newestRaw(): Promise<string> {
  const folder = resolve('benchmark', 'results');
  const files = (await readdir(folder)).filter(file => file.startsWith('raw-') && file.endsWith('.jsonl')).sort();
  if (!files.length) throw new Error('No benchmark/results/raw-*.jsonl file found');
  return join(folder, files.at(-1)!);
}

const inputPath = resolve(process.argv[2] ?? await newestRaw());
const records = (await readFile(inputPath, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const metadata = records.find(record => record.type === 'metadata');
const resumeEvents = records.filter(record => record.type === 'resume');
const trials = records.filter(record => !record.type) as Trial[];
if (!metadata || !trials.length) throw new Error('Raw results must contain metadata and trials');

function summarize(rows: Trial[]) {
  const successful = rows.filter(row => row.success);
  const measuredUsage = rows.filter(row => row.usageAvailable !== false);
  const reportedLocal = rows.map(row => row.apexReportedDurationMs).filter((value): value is number => typeof value === 'number');
  return {
    attempts: rows.length, successes: successful.length, successRate: round(successful.length / rows.length * 100), oracleMatches: rows.filter(row => row.oracleMatched).length,
    totalAttemptTimeMs: round(rows.reduce((sum, row) => sum + row.durationMs, 0)),
    durationMsAllAttempts: distribution(rows.map(row => row.durationMs)), durationMsSuccessful: distribution(successful.map(row => row.durationMs)),
    tokenMeasurementsAvailable: measuredUsage.length, totalTokensConsumed: measuredUsage.reduce((sum, row) => sum + totalTokens(row), 0), totalTokens: distribution(measuredUsage.map(totalTokens)), inputTokens: distribution(measuredUsage.map(row => row.usage.input_tokens)),
    outputTokens: distribution(measuredUsage.map(row => row.usage.output_tokens)), toolCalls: distribution(rows.map(row => row.toolCalls)),
    totalToolCalls: rows.reduce((sum, row) => sum + row.toolCalls, 0), totalMcpResultBytes: rows.reduce((sum, row) => sum + row.mcpResultBytes, 0),
    mcpResultBytes: distribution(rows.map(row => row.mcpResultBytes)), apexReportedLocalDurationMs: distribution(reportedLocal), estimatedCostUsd: round(measuredUsage.reduce((sum, row) => sum + estimatedUsd(row), 0), 6),
    toolErrors: rows.reduce((sum, row) => sum + row.toolErrors, 0),
  };
}

const arms = [...new Set(trials.map(row => row.arm))] as Arm[];
const workloadIds = [...new Set(trials.map(row => row.workload))];
const byArm = Object.fromEntries(arms.map(arm => [arm, summarize(trials.filter(row => row.arm === arm))]));
const byWorkload = Object.fromEntries(workloadIds.map(workload => [workload, Object.fromEntries(arms.map(arm => [arm, summarize(trials.filter(row => row.workload === workload && row.arm === arm))]))]));

const pairs: Array<{ apex: Trial; official: Trial }> = [];
for (const apex of trials.filter(row => row.arm === 'apex')) {
  const official = trials.find(row => row.arm === 'playwright-mcp' && row.workload === apex.workload && row.trial === apex.trial);
  if (official?.success && apex.success) pairs.push({ apex, official });
}
const durationDifferences = pairs.map(pair => pair.official.durationMs - pair.apex.durationMs);
const tokenDifferences = pairs.map(pair => totalTokens(pair.official) - totalTokens(pair.apex));
const paired = {
  jointlySuccessfulPairs: pairs.length,
  durationMsOfficialMinusApex: { distribution: distribution(durationDifferences), bootstrapMean95Ci: bootstrapMeanCi(durationDifferences) },
  totalTokensOfficialMinusApex: { distribution: distribution(tokenDifferences), bootstrapMean95Ci: bootstrapMeanCi(tokenDifferences) },
  medianDurationSpeedupOfficialOverApex: round(percentile(pairs.map(pair => pair.official.durationMs / pair.apex.durationMs), .5), 3),
  medianTokenRatioOfficialOverApex: round(percentile(pairs.map(pair => totalTokens(pair.official) / Math.max(1, totalTokens(pair.apex))), .5), 3),
};
const failures = trials.filter(row => !row.success).map(row => ({
  sequence: row.sequence, trial: row.trial, workload: row.workload, arm: row.arm,
  classification: row.timedOut ? 'timeout' : row.toolCalls === 0 && row.agentFinal === 'FAILED' ? 'agent_declined_without_tool' : row.toolErrors ? 'tool_error' : row.oracleMatched ? 'process_failure' : 'oracle_mismatch',
  durationMs: row.durationMs, toolCalls: row.toolCalls, totalTokens: totalTokens(row), agentFinal: row.agentFinal, error: row.error,
}));
const portableSource = relative(process.cwd(), inputPath).replaceAll('\\', '/');
const summary = { schemaVersion: 1, generatedAt: new Date().toISOString(), source: portableSource, metadata, resumeEvents, byArm, byWorkload, paired, failures };
const summaryPath = join(dirname(inputPath), 'summary.json');
await writeFile(summaryPath, JSON.stringify(summary, null, 2));

const armRows = arms.map(arm => {
  const item = byArm[arm];
  return `| ${arm} | ${item.successes}/${item.attempts} (${item.successRate}%) | ${round(item.totalAttemptTimeMs / 60000)} | ${item.durationMsSuccessful.p50} | ${item.durationMsSuccessful.p95} | ${item.totalTokensConsumed.toLocaleString('en-US')} | ${item.totalTokens.p50} | ${item.toolCalls.p50} | ${item.mcpResultBytes.p50} | ${item.toolErrors} | $${item.estimatedCostUsd} |`;
}).join('\n');
const workloadRows = workloadIds.flatMap(workload => arms.map(arm => {
  const item = byWorkload[workload][arm];
  return `| ${workload} | ${arm} | ${item.successes}/${item.attempts} | ${item.durationMsSuccessful.p50} | ${item.totalTokens.p50} | ${item.toolCalls.p50} |`;
})).join('\n');
const apex = byArm.apex; const official = byArm['playwright-mcp'];
const reduction = (apexValue: number, officialValue: number) => round((1 - apexValue / officialValue) * 100, 1);
const failureRows = failures.length ? failures.map(failure => `| ${failure.sequence} | ${failure.arm} | ${failure.workload} | ${failure.trial} | ${failure.classification} | ${failure.durationMs} | ${failure.toolCalls} | ${failure.totalTokens} |`).join('\n') : '| — | — | — | — | none | — | — | — |';
const failureNarrative = failures.length === 1 && failures[0].classification === 'agent_declined_without_tool'
  ? 'The only failure was retained in aggregate statistics. Its transcript shows the agent replied `FAILED` without invoking an MCP tool; it was not a browser-runtime or oracle error.'
  : `${failures.length} failures were retained in aggregate statistics and are classified above from raw runner evidence.`;
const report = `# Apex Browse benchmark results

Generated ${summary.generatedAt} from \`${portableSource}\`.

## Aggregate results

Across equal 50-attempt arms, Apex used ${reduction(apex.totalAttemptTimeMs, official.totalAttemptTimeMs)}% less summed wall time, ${reduction(apex.totalTokensConsumed, official.totalTokensConsumed)}% fewer total tokens, ${reduction(apex.totalToolCalls, official.totalToolCalls)}% fewer MCP calls, and ${reduction(apex.totalMcpResultBytes, official.totalMcpResultBytes)}% fewer serialized MCP-result bytes than official Playwright MCP. Its estimated model cost was ${reduction(apex.estimatedCostUsd, official.estimatedCostUsd)}% lower. Apex succeeded on ${apex.successes}/${apex.attempts} attempts versus ${official.successes}/${official.attempts} for official MCP.

| Arm | Independent success | Total wall time (min) | Median successful time (ms) | p95 successful time (ms) | Total tokens | Median tokens | Median calls | Median result bytes | Tool errors | Estimated model cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${armRows}

Native Playwright is a deterministic lower-bound context, not an agent competitor. Agent success is counted only when the independent server-side oracle observed the exact required payload.

Apex's median reported local DSL execution time was ${apex.apexReportedLocalDurationMs.p50} ms. The gap between that and end-to-end time is model, Codex, MCP, and browser-process orchestration included by design.

## Results by workload

| Workload | Arm | Success | Median successful time (ms) | Median total tokens | Median tool calls |
| --- | --- | ---: | ---: | ---: | ---: |
${workloadRows}

## Paired comparison

There were ${paired.jointlySuccessfulPairs} workload/trial pairs where both agent arms succeeded. Official Playwright MCP minus Apex Browse had a mean duration difference of ${paired.durationMsOfficialMinusApex.distribution.mean} ms (deterministic bootstrap 95% CI ${paired.durationMsOfficialMinusApex.bootstrapMean95Ci[0]} to ${paired.durationMsOfficialMinusApex.bootstrapMean95Ci[1]} ms) and a mean token difference of ${paired.totalTokensOfficialMinusApex.distribution.mean} tokens (95% CI ${paired.totalTokensOfficialMinusApex.bootstrapMean95Ci[0]} to ${paired.totalTokensOfficialMinusApex.bootstrapMean95Ci[1]}). The median official/Apex ratios were ${paired.medianDurationSpeedupOfficialOverApex}× for elapsed time and ${paired.medianTokenRatioOfficialOverApex}× for total tokens. Positive differences favor Apex.

## Failure inventory

| Sequence | Arm | Workload | Trial | Classification | Time (ms) | Calls | Tokens |
| ---: | --- | --- | ---: | --- | ---: | ---: | ---: |
${failureRows}

${failureNarrative}

## Interpretation constraints

- These measurements apply to the pinned model, MCP/runtime versions, controlled tasks, and run date recorded in the raw metadata.
- Total elapsed time includes Codex and MCP process startup. Package downloads are excluded after cache warm-up.
- Token counts come directly from Codex JSON events. Estimated cost uses the price schedule recorded in the methodology; raw token fields remain authoritative.
- Tool errors count failed MCP call events, including recoverable argument-validation errors; they do not imply that the overall attempt failed.
- Successful-duration statistics exclude failed trials; success rate and all-attempt timing are retained in \`summary.json\` to prevent survivorship from being hidden.
- The structural-drift and renamed-control workloads test semantic resilience, but five local workloads cannot establish performance on the whole web.
`;
const reportPath = join(dirname(inputPath), 'report.md');
await writeFile(reportPath, report);
process.stdout.write(`Summary: ${summaryPath}\nReport: ${reportPath}\n`);
