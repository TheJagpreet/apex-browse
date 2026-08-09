# Apex Browse benchmark results

Generated 2026-08-09T15:36:52.690Z from `benchmark/results/raw-luna-2026-08-09.jsonl`.

## Aggregate results

Across equal 50-attempt arms, Apex Browse used 45.9% less summed wall time, 54.8% fewer total tokens, 68% fewer MCP calls, and 74.3% fewer serialized MCP-result bytes than official Playwright MCP. Its estimated model cost was 35.3% lower. Apex Browse succeeded on 49/50 attempts versus 50/50 for official MCP.

| Arm | Independent success | Total wall time (min) | Median successful time (ms) | p95 successful time (ms) | Total tokens | Median tokens | Median calls | Median result bytes | Tool errors | Estimated model cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| apex-browse | 49/50 (98%) | 22.46 | 27485.76 | 37518.49 | 4,393,321 | 80994.5 | 2 | 996 | 0 | $1.367294 |
| playwright-mcp | 50/50 (100%) | 41.51 | 49765.97 | 62359.55 | 9,726,675 | 189168.5 | 7 | 4640 | 25 | $2.113408 |
| native | 50/50 (100%) | 0.22 | 264.04 | 333.2 | 0 | 0 | 0 | 0 | 0 | $0 |

Native Playwright is a deterministic lower-bound context, not an agent competitor. Agent success is counted only when the independent server-side oracle observed the exact required payload.

Apex Browse's median reported local DSL execution time was 252.87 ms. The gap between that and end-to-end time is model, Codex, MCP, and browser-process orchestration included by design.

## Results by workload

| Workload | Arm | Success | Median successful time (ms) | Median total tokens | Median tool calls |
| --- | --- | ---: | ---: | ---: | ---: |
| profile | apex-browse | 10/10 | 27546.48 | 81418.5 | 2 |
| profile | playwright-mcp | 10/10 | 46253.88 | 189168.5 | 6 |
| profile | native | 10/10 | 271.52 | 0 | 0 |
| profile-drift | apex-browse | 10/10 | 19341.01 | 57415 | 1 |
| profile-drift | playwright-mcp | 10/10 | 53571.15 | 187918.5 | 9 |
| profile-drift | native | 10/10 | 270.57 | 0 | 0 |
| dialog | apex-browse | 10/10 | 30771.26 | 85297 | 2 |
| dialog | playwright-mcp | 10/10 | 55345.66 | 199541 | 9 |
| dialog | native | 10/10 | 281.57 | 0 | 0 |
| renamed-control | apex-browse | 10/10 | 25962.42 | 80984.5 | 2 |
| renamed-control | playwright-mcp | 10/10 | 43361.81 | 200451 | 6 |
| renamed-control | native | 10/10 | 196.03 | 0 | 0 |
| catalog | apex-browse | 9/10 | 30405.36 | 126057.5 | 4 |
| catalog | playwright-mcp | 10/10 | 44214.96 | 176583 | 7 |
| catalog | native | 10/10 | 253.09 | 0 | 0 |

## Paired comparison

There were 49 workload/trial pairs where both agent arms succeeded. Official Playwright MCP minus Apex Browse had a mean duration difference of 22521.06 ms (deterministic bootstrap 95% CI 19620.91 to 25497.17 ms) and a mean token difference of 105561.22 tokens (95% CI 88214.48 to 122439.24). The median official/Apex Browse ratios were 1.804× for elapsed time and 2.484× for total tokens. Positive differences favor Apex Browse.

## Failure inventory

| Sequence | Arm | Workload | Trial | Classification | Time (ms) | Calls | Tokens |
| ---: | --- | --- | ---: | --- | ---: | ---: | ---: |
| 60 | apex-browse | catalog | 4 | agent_declined_without_tool | 10241.59 | 0 | 12675 |

The only failure was retained in aggregate statistics. Its transcript shows the agent replied `FAILED` without invoking an MCP tool; it was not a browser-runtime or oracle error.

## Interpretation constraints

- These measurements apply to the pinned model, MCP/runtime versions, controlled tasks, and run date recorded in the raw metadata.
- Total elapsed time includes Codex and MCP process startup. Package downloads are excluded after cache warm-up.
- Token counts come directly from Codex JSON events. Estimated cost uses the price schedule recorded in the methodology; raw token fields remain authoritative.
- Tool errors count failed MCP call events, including recoverable argument-validation errors; they do not imply that the overall attempt failed.
- Successful-duration statistics exclude failed trials; success rate and all-attempt timing are retained in `summary.json` to prevent survivorship from being hidden.
- The structural-drift and renamed-control workloads test semantic resilience, but five local workloads cannot establish performance on the whole web.
