# apex-browse

Deterministic Playwright execution with bounded LLM repair.

An agent sends one strict JSON DSL program to `apex_browse_run`. Apex Browse owns the Playwright page and resolves browser actions locally. On the normal path there is no model-in-the-loop browser conversation. Only an unresolved target returns a compact repair packet; the host can repair that one target through `apex_browse_repair`.

```powershell
npm install
npx playwright install chromium
npm run build
npm run mcp
```

To attach the compiled server to Codex from this workspace:

```powershell
$repositoryRoot = (Resolve-Path .).Path
codex mcp add apex-browse -- node "$repositoryRoot\dist\mcp-server.js"
```

## Normal agent loop

```json
{
  "steps": [
    { "op": "navigate", "url": "https://app.example.test/contact" },
    { "op": "fill", "target": { "role": "textbox", "name": "Email" }, "value": "ada@example.test" },
    { "op": "click", "target": { "role": "button", "name": "Send" } },
    { "op": "expect", "text": "Message sent" }
  ]
}
```

Send the complete JSON to `apex_browse_run` as `programJson`.

- **Success:** Apex Browse returns status, local action count, repair count, duration, and compact evidence IDs. Detailed evidence remains local and is fetched only on demand.
- **Missing target:** Apex Browse pauses and returns one `RepairPacket` containing the failed intent and at most five semantic candidates.
- **Ambiguous target:** Apex Browse does not click anything. The host must disambiguate or ask the user.

For a rename from `Send` to `Sent`, a host passes the returned `runId` and `{ "role": "button", "name": "Sent" }` to `apex_browse_repair`. The replacement must be one of the packet’s bounded candidates; the paused step is replaced and no new DSL actions can be added through repair.

## MCP tools

| Tool | Use |
| --- | --- |
| `apex_browse_navigate` | Open a URL and return a bounded private semantic snapshot. |
| `apex_browse_run` | Run one complete allow-listed DSL program locally. |
| `apex_browse_snapshot` | Retrieve capped visible text and controls only when discovery is necessary. |
| `apex_browse_search` | Search the local semantic index without a full page dump. |
| `apex_browse_repair` | Apply one validated target replacement to a paused action. |
| `apex_browse_evidence` | Retrieve local execution evidence by ID for debugging. |

The agent prompts for this loop are in [skills/planner.md](skills/planner.md) and [skills/repair.md](skills/repair.md). The first plans a complete program; the second sees only the bounded repair packet.

## Safety

- The DSL has no arbitrary JavaScript, locator expressions, shell commands, or page evaluation.
- Page data is marked untrusted.
- Exact accessible role/name resolution happens first; aliases are explicit and auditable.
- Multiple matching mutating controls return `ambiguous`; Apex Browse does not guess.
- High-impact targets such as delete/payment actions require `confirm: true` **and** an out-of-band `approveHighImpact` callback supplied by the host application. The MCP agent cannot approve its own high-impact action.

The full design is in [research/apex-browse-plan.md](research/apex-browse-plan.md).

## Benchmark

The reproducible comparison uses Luna against both Apex Browse and the official Playwright MCP, plus direct Playwright as a lower-bound context. It records exact server-side outcomes, elapsed time, Codex token counters, MCP calls/errors, response bytes, and complete JSON event transcripts.

```powershell
npm.cmd run benchmark:setup
npm.cmd run benchmark:run -- --trials 10
npm.cmd run benchmark:analyze
```

See [benchmark/methodology.md](benchmark/methodology.md) for the frozen protocol and `benchmark/results` for generated raw and analyzed statistics.
