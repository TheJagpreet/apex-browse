# Benchmark methodology

## Question

For common browser tasks, does Apex Browse reduce end-to-end elapsed time, model tokens, MCP calls, and serialized MCP output while preserving task success compared with the official Playwright MCP?

## Frozen comparison

- Agent: Codex CLI with `gpt-5.6-luna`, low reasoning effort, ephemeral thread, and user configuration disabled.
- Apex arm: this repository's compiled stdio MCP server.
- Official arm: `@playwright/mcp@0.0.79`, headless isolated Chromium, image responses omitted, default full semantic snapshots.
- Native context arm: direct Playwright with fixed locators. It provides a non-agent lower bound and is not presented as an agent competitor.
- Every agent receives the same task wording and prohibition on shell, filesystem, web-search, and non-browser tools.

## Workloads and oracle

The local controlled website contains five tasks: a standard profile form, a structurally changed equivalent form, a dynamically opened dialog, a semantically renamed submit control, and a two-stage catalog search. Tasks intentionally cover filling, selection, checking, clicking, keyboard-triggered state, dynamic content, scoping, and semantic drift.

Success is not inferred from an agent's final message or process exit. The website records the submitted payload server-side, and the runner compares it with an exact expected object. Each attempt is reset beforehand.

## Trial protocol

The default run performs ten trials per workload per arm. Arm order rotates cyclically across workload/trial pairs to reduce ordering and thermal bias. Each attempt starts a fresh Codex process, MCP process, and isolated browser. The local website server remains running. Node packages and browsers are warmed before timed trials; MCP and browser startup remain inside elapsed time.

The runner records every trial as one append-only JSONL object, including independent success, elapsed time, exit status, timeout, observed and expected payloads, MCP call names and errors, serialized MCP result bytes, agent final response, and all token counters exposed by Codex. Full Codex JSON event transcripts are retained beside the raw results.

Before publication, `benchmark:sanitize` removes hardware, operating-system, timezone, user-directory, absolute repository-path, dynamic localhost-port, and Codex thread-ID data. Sanitization runs after measurement: numeric timings, token counters, call counts, and original measured MCP byte counts are not recalculated or altered.

## Analysis

The analyzer reports success rate, mean, sample standard deviation, median, and p95. Successful-duration statistics and all-attempt statistics are both preserved. Apex and official trials are paired by workload and repetition; paired mean differences receive a deterministic 10,000-resample bootstrap 95% confidence interval. Positive official-minus-Apex differences favor Apex.

The model cost estimate uses [OpenAI's published Luna prices](https://developers.openai.com/api/docs/models/gpt-5.6-luna) current at protocol creation: $1.00 per million uncached input tokens, $0.10 per million cached input tokens, $1.25 per million cache-write input tokens, and $6.00 per million output tokens. The estimate assumes no individual request crosses the documented long-context threshold. Raw counters are retained so estimates can be recalculated after pricing changes.

The official baseline flags and their behavior are documented in the [Microsoft Playwright MCP repository](https://github.com/microsoft/playwright-mcp). In particular, full snapshots are the default, `--isolated` keeps the profile in memory, and `--image-responses omit` prevents image payloads from entering the comparison.

## Reproduction

```powershell
npm.cmd install
npx.cmd playwright install chromium
npm.cmd run benchmark:run -- --trials 10
npm.cmd run benchmark:analyze
npm.cmd run benchmark:verify
```

To sanitize an existing run before analysis:

```powershell
npm.cmd run benchmark:sanitize -- benchmark/results/raw-luna-2026-08-09.jsonl
```

An interrupted run can be continued without repeating completed attempts:

```powershell
npm.cmd run benchmark:run -- --trials 10 --timeout-ms 120000 --output benchmark/results/raw-luna-2026-08-09.jsonl --resume
```

Resume validates the model, trial count, arms, workloads, and official MCP version against the original metadata, appends a resume event, and skips only exact workload/trial/arm keys already present.

For a smoke run:

```powershell
npm.cmd run benchmark:run -- --trials 1 --workloads profile,renamed-control
```

## Validity limits

The controlled site makes correctness independently observable and removes internet variability, but it does not represent every production site. Results are model-, runtime-version-, and task-dependent. The benchmark measures total agent workflow cost rather than isolated locator execution. Omitting screenshots favors semantic interaction in both MCP arms and avoids comparing vision-token behavior that Apex does not currently offer. Hardware, operating-system, timezone, user-directory, and absolute repository-path metadata are deliberately excluded from publishable artifacts.
