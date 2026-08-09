# Apex Browse: deterministic browser execution with LLM fallback

## The product

Apex Browse is an MCP layer above Playwright that makes browser work **local and deterministic by default** and uses an LLM only to plan a task or repair a failed selector.

The target is not a flow-maintenance tool and not another autonomous browser agent. It is a fast execution runtime for coding agents, skills, and subagents that need to browse or test a UI with fewer model turns, smaller prompts, and lower latency.

The core rule is:

> The model writes intent once. Apex executes as much as possible locally. When an action cannot be resolved, Apex returns the smallest useful browser delta for one repair attempt.

## Concrete example

An agent receives: “Submit this data by clicking the Send button.” It produces a small declarative browser program:

```yaml
- navigate: https://app.example.test/contact
- fill:
    field: Email
    value: ada@example.test
- fill:
    field: Message
    value: Hello
- click:
    button: Send
- expect:
    text: Message sent
```

Apex executes it with Playwright.

1. It resolves `Email`, `Message`, and `Send` locally using accessibility semantics and session-local page state.
2. It clicks the button and checks the postcondition locally.
3. If the page changed `Send` to `Sent`, Apex first tries deterministic normalization and configured aliases.
4. If that still does not yield one safe target, it returns a compact repair packet such as:

```json
{
  "step": 4,
  "intent": { "action": "click", "role": "button", "name": "Send" },
  "reason": "missing",
  "candidates": [
    { "id": "c17", "role": "button", "name": "Sent", "enabled": true }
  ],
  "pageRevision": 12
}
```

The LLM sees this small packet—not a full browser snapshot—and returns a one-step patch such as `click button "Sent"`. Apex validates and retries only that step.

If there are two matching buttons, the result is `ambiguous`; Apex does not guess or mutate the page.

## Execution model

```text
Agent / skill creates DSL
        |
        v
  Apex DSL validator
        |
        v
  Local Playwright executor
   | exact role/name resolution
   | normalization and aliases
   | session-local snapshot index
   | local postconditions
        |
        +-- success → compact receipt
        |
        +-- missing / ambiguous target
                |
                v
         bounded repair packet
                |
                v
           LLM repair decision
                |
                v
        validated one-step retry

        +-- failed postcondition → compact failure receipt
```

The executor, not the LLM, owns browser state. The LLM never receives unrestricted page content by default and never sends arbitrary JavaScript to the page. A failed postcondition is not repairable by changing the assertion: Apex reports it as a failure so the host can decide whether a new user-approved program is appropriate.

## DSL

The first DSL should be intentionally small:

```yaml
- navigate: <url>
- click: { role: button, name: <text> }
- fill: { field: <text>, value: <string> }
- select: { field: <text>, value: <string> }
- check: { field: <text> }
- press: { key: Enter }
- expect: { text: <text> }
- expect: { urlIncludes: <text> }
```

Every instruction compiles to an allow-listed Playwright action. No `evaluate`, arbitrary locator expression, shell command, or injected JavaScript belongs in v1.

Targets should use accessibility roles and names first. A target may have a local alias list, for example `Send | Sent | Submit`, but aliases must be explicit and observable in logs.

## Local resolver and snapshot index

For each page revision, Apex keeps a private semantic index:

- interactive controls: role, accessible name, enabled/checked state, and stable local ID;
- visible text chunks, capped and indexed locally;
- dialogs and scope relationships;
- page URL, title, and a revision number;
- optional screenshot/evidence reference held locally, not inserted into prompts.

Resolution order:

1. Exact accessible role and name.
2. Normalized exact name: case, whitespace, punctuation, and configured synonyms.
3. Unique deterministic local candidate above a conservative score threshold.
4. Return `missing` or `ambiguous` with a compact candidate set.

The resolver must never convert a low-confidence fuzzy match into a mutation. That is where the LLM repair path or user approval begins.

## MCP surface

The MCP server should expose a small session-oriented API:

| Tool | Purpose |
| --- | --- |
| `apex_navigate` | Open a URL and create a private page revision. |
| `apex_run` | Validate and execute a complete DSL program locally. |
| `apex_snapshot` | Return a bounded semantic snapshot only when requested. |
| `apex_search` | Search the private snapshot index and return bounded candidates. |
| `apex_repair` | Validate and apply one repair to a paused DSL step. |
| `apex_evidence` | Retrieve locally retained evidence by ID when debugging is required. |

`apex_run` is the hot path. A successful multi-step program should normally require one MCP call after the initial plan. `apex_snapshot` and `apex_search` are discovery/repair tools, not a mandatory observe loop.

## Agents, subagents, and skills

- **Host agent:** owns the user goal and decides whether to create a DSL program, request a repair, or ask the user.
- **Browser executor:** a single Apex session owns a page. Subagents never concurrently mutate the same session.
- **Planner skill:** turns a user request into DSL plus explicit assertions.
- **Repair skill:** receives only a repair packet and can return a constrained one-step patch.
- **Domain skills:** may provide approved target aliases, data-entry conventions, or reusable DSL templates for a known application.

Subagents are useful for planning or interpreting a compact repair packet. They should not each receive full snapshots or independently drive a browser; that recreates the token and coordination cost Apex is intended to remove.

## Safety model

- Treat all page text, attributes, and screenshots as untrusted data, never as instructions.
- Validate DSL and repairs against a strict schema.
- Enforce one-action repair scope; a repair cannot replace the remaining program.
- Report ambiguity rather than choose among multiple mutating targets.
- Require explicit host/user confirmation for irreversible or external actions: purchase, submit payment, delete, send externally, account/security changes.
- Retain local evidence and action receipts for debugging and audit.

## Measurements that matter

Measure against raw Playwright MCP on identical tasks:

- end-to-end wall time;
- model turns and MCP calls;
- input/output tokens, including repair-token cost;
- success, wrong-action, ambiguity, and false-success rates;
- selector-drift recovery rate;
- added local executor latency.

The important comparison is not only a known flow. It includes exact success, a harmless label rename (`Send` → `Sent`), a missing control, duplicate mutating controls, an asynchronous postcondition, and a dynamic dialog.

## Build plan

### Phase 1 — executor core

1. Define the DSL schema and receipt schema.
2. Implement `apex_navigate` and `apex_run` over one Playwright page.
3. Implement exact role/name resolution, private page revisions, and postcondition waits.
4. Return compact success, missing, ambiguous, and failed receipts.

### Phase 2 — compact discovery and repair

1. Build the bounded snapshot index and `apex_search`.
2. Define repair packets and `apex_repair` validation.
3. Add deterministic normalization and auditable aliases.
4. Add a planner/repair skill prompt contract.

### Phase 3 — agent integration

1. Connect the MCP server to Codex/other agents.
2. Add a sample host-agent loop: plan once → `apex_run` → repair only on a bounded failure.
3. Add per-session token, tool-call, and timing receipts.

### Phase 4 — evaluation and hardening

1. Build controlled UI fixtures for success, drift, ambiguity, dialog, and delayed UI updates.
2. Run real-agent comparisons with pinned versions and repeated trials.
3. Add policy gates for high-impact actions and user confirmation.

## First implementation milestone

Build a working MCP demo where an agent sends the YAML/JSON DSL once, Apex fills a form and clicks `Send` without any intermediate model call, and then recovers from the page changing that label to `Sent` by returning one compact repair packet. This is the smallest end-to-end proof of the actual product.
