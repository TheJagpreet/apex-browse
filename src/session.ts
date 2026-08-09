import { chromium, type Browser, type Locator, type Page } from 'playwright';
import type { Action, Control, Program, RepairPacket, Role, RunMetrics, RunResult, Snapshot, StepReceipt, Target } from './types.js';

const CONTROL_SELECTOR = 'button, dialog, input, select, textarea, a[href], [role="button"], [role="checkbox"], [role="combobox"], [role="dialog"], [role="link"], [role="radio"], [role="searchbox"], [role="textbox"]';
const EXPECT_TIMEOUT = 4_000;
const MAX_CONTROLS = 24;
const MAX_TEXT = 800;
const HIGH_IMPACT = /\b(delete|remove|pay|payment|purchase|place order|security|password)\b/i;

type Resolved = { locator: Locator; control: Control; via: 'exact' | 'normalized' } | { kind: 'missing' | 'ambiguous'; candidates: Control[] };
type Paused = { program: Program; step: number; receipts: StepReceipt[]; metrics: RunMetrics; repair: RepairPacket };

export class ApexBrowseSession {
  #browser?: Browser;
  #page?: Page;
  #revision = 0;
  #evidence = new Map<string, unknown>();
  #paused = new Map<string, Paused>();
  #run = 0;
  #cachedControls?: { revision: number; controls: Control[] };

  constructor(private readonly options: { approveHighImpact?: (action: Action) => boolean | Promise<boolean> } = {}) {}

  async navigate(url: string): Promise<Snapshot> {
    await this.#navigate(url);
    return this.snapshot();
  }

  async #navigate(url: string): Promise<void> {
    if (!this.#browser) this.#browser = await chromium.launch({ headless: true });
    if (!this.#page) {
      this.#page = await this.#browser.newPage();
      this.#page.setDefaultTimeout(5_000);
    }
    await this.#page.goto(url);
    this.#advance();
  }

  async close(): Promise<void> {
    await this.#browser?.close();
    this.#browser = undefined;
    this.#page = undefined;
    this.#paused.clear();
    this.#cachedControls = undefined;
  }

  async snapshot(): Promise<Snapshot> {
    const page = this.#requirePage();
    const controls = await this.#controls();
    const visibleText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
    return {
      revision: this.#revision, url: page.url(), title: await page.title(), controls: controls.slice(0, MAX_CONTROLS), visibleText: visibleText.slice(0, MAX_TEXT),
      omitted: { controls: Math.max(0, controls.length - MAX_CONTROLS), textCharacters: Math.max(0, visibleText.length - MAX_TEXT) }, untrusted: true,
    };
  }

  async search(query: string, limit = 5): Promise<{ revision: number; query: string; status: 'unique' | 'missing' | 'ambiguous'; candidates: Control[]; omittedCandidates: number; untrusted: true }> {
    const terms = normalize(query).split(' ').filter(Boolean);
    const matches = (await this.#controls()).filter(control => terms.every(term => normalize(`${control.role} ${control.name}`).includes(term)));
    return { revision: this.#revision, query, status: matches.length === 0 ? 'missing' : matches.length === 1 ? 'unique' : 'ambiguous', candidates: matches.slice(0, limit), omittedCandidates: Math.max(0, matches.length - limit), untrusted: true };
  }

  evidence(id: string): unknown {
    if (!this.#evidence.has(id)) throw new Error(`Unknown evidence: ${id}`);
    return this.#evidence.get(id);
  }

  async run(program: Program): Promise<RunResult> {
    this.#currentProgram = program;
    const start = performance.now();
    const metrics: RunMetrics = { durationMs: 0, localActions: 0, repairs: 0 };
    const receipts: StepReceipt[] = [];
    for (let step = 0; step < program.steps.length; step += 1) {
      const outcome = await this.#step(program.steps[step], step, receipts, metrics);
      if (outcome !== 'continue') {
        metrics.durationMs = performance.now() - start;
        return outcome;
      }
    }
    metrics.durationMs = performance.now() - start;
    return { status: 'success', receipts, metrics };
  }

  async repair(runId: string, target: Target): Promise<RunResult> {
    const paused = this.#paused.get(runId);
    if (!paused) throw new Error(`Unknown or completed repair run: ${runId}`);
    this.#paused.delete(runId);
    this.#currentProgram = paused.program;
    const original = paused.program.steps[paused.step];
    if (!('target' in original) || original.target.role !== target.role) throw new Error('A repair may only replace the target name for the paused action');
    if (!paused.repair.candidates.some(candidate => candidate.role === target.role && candidate.name === target.name)) {
      throw new Error('A repair target must be one of the bounded candidates in the repair packet');
    }
    const patched = { ...original, target: { ...target, aliases: undefined } } as Action;
    paused.program.steps[paused.step] = patched;
    paused.metrics.repairs += 1;
    const start = performance.now();
    for (let step = paused.step; step < paused.program.steps.length; step += 1) {
      const outcome = await this.#step(paused.program.steps[step], step, paused.receipts, paused.metrics);
      if (outcome !== 'continue') {
        paused.metrics.durationMs += performance.now() - start;
        return outcome;
      }
    }
    paused.metrics.durationMs += performance.now() - start;
    return { status: 'success', receipts: paused.receipts, metrics: paused.metrics };
  }

  async #step(action: Action, step: number, receipts: StepReceipt[], metrics: RunMetrics): Promise<'continue' | Exclude<RunResult, { status: 'success' }>> {
    try {
      if (action.op === 'navigate') {
        await this.#navigate(action.url);
        receipts.push(this.#receipt(step, action, undefined));
        metrics.localActions += 1;
        return 'continue';
      }
      if (action.op === 'expect') {
        const passed = await this.#expect(action);
        if (!passed) return { status: 'failed', receipts, error: `Postcondition failed at step ${step}`, metrics };
        receipts.push(this.#receipt(step, action, undefined));
        return 'continue';
      }
      await this.#confirm(action);
      if (action.op === 'press') {
        await this.#requirePage().keyboard.press(action.key);
        this.#advance();
        receipts.push(this.#receipt(step, action, undefined));
        metrics.localActions += 1;
        return 'continue';
      }
      const resolved = await this.#resolve(action.target);
      if ('kind' in resolved) return this.#pause(resolved.kind, action, step, receipts, metrics, resolved.candidates);
      if (action.op === 'click') await resolved.locator.click();
      if (action.op === 'fill') { await resolved.locator.fill(action.value); if (action.submit) await resolved.locator.press('Enter'); }
      if (action.op === 'select') await this.#select(resolved.locator, action.value);
      if (action.op === 'check') await resolved.locator.check();
      this.#advance();
      receipts.push(this.#receipt(step, action, resolved));
      metrics.localActions += 1;
      return 'continue';
    } catch (cause) {
      return { status: 'failed', receipts, error: cause instanceof Error ? cause.message : String(cause), metrics };
    }
  }

  #pause(reason: RepairPacket['reason'], intent: Action, step: number, receipts: StepReceipt[], metrics: RunMetrics, candidates: Control[]): Exclude<RunResult, { status: 'success' | 'failed' }> {
    const runId = `run_${++this.#run}`;
    const repair: RepairPacket = { runId, step, intent, reason, candidates: candidates.slice(0, 5), pageRevision: this.#revision, untrusted: true };
    this.#paused.set(runId, { program: { steps: [...(this.#currentProgram?.steps ?? [])] }, step, receipts, metrics, repair });
    // #currentProgram is set by run/repair before #step. The defensive fallback is never used by public calls.
    return { status: reason === 'ambiguous' ? 'ambiguous' : 'needs_repair', receipts, repair, metrics };
  }

  #currentProgram?: Program;

  #receipt(step: number, action: Action, resolved?: Extract<Resolved, { locator: Locator }>): StepReceipt {
    const evidenceId = `memory://evidence/${this.#revision}/${step}`;
    this.#evidence.set(evidenceId, { action, snapshotRevision: this.#revision, resolved: resolved?.control });
    return { step, op: action.op, status: 'success', evidenceId, resolved: resolved ? { role: resolved.control.role, name: resolved.control.name, via: resolved.via } : undefined };
  }

  async #resolve(target: Target): Promise<Resolved> {
    const controls = await this.#controls();
    const exact = controls.filter(control => control.role === target.role && control.name === target.name);
    if (exact.length === 1) return { locator: this.#locator(target, exact[0].name), control: exact[0], via: 'exact' };
    if (exact.length > 1) return { kind: 'ambiguous', candidates: exact };
    const names = [target.name, ...(target.aliases ?? [])].map(normalize);
    const normalized = controls.filter(control => control.role === target.role && names.includes(normalize(control.name)));
    if (normalized.length === 1) return { locator: this.#locator(target, normalized[0].name), control: normalized[0], via: 'normalized' };
    return { kind: normalized.length > 1 ? 'ambiguous' : 'missing', candidates: normalized.length ? normalized : controls.filter(control => control.role === target.role).slice(0, 5) };
  }

  #locator(target: Target, name: string): Locator {
    const root = target.scope ? this.#locator(target.scope, target.scope.name) : this.#requirePage();
    return root.getByRole(target.role, { name, exact: true });
  }

  async #controls(): Promise<Control[]> {
    if (this.#cachedControls?.revision === this.#revision) return this.#cachedControls.controls;
    const page = this.#requirePage();
    const controls = await page.locator(CONTROL_SELECTOR).evaluateAll((elements, revision) => elements
      .filter(element => { const style = getComputedStyle(element); return element.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden'; })
      .map((element, index) => {
        const input = element as HTMLInputElement;
        const implicitRole = element.tagName === 'A' ? 'link'
          : element.tagName === 'BUTTON' ? 'button'
          : element.tagName === 'DIALOG' ? 'dialog'
          : element.tagName === 'SELECT' ? 'combobox'
          : element.tagName === 'TEXTAREA' ? 'textbox'
          : input.type === 'checkbox' ? 'checkbox'
          : input.type === 'radio' ? 'radio'
          : input.type === 'search' ? 'searchbox'
          : ['button', 'submit', 'reset', 'image'].includes(input.type) ? 'button'
          : 'textbox';
        const role = (element.getAttribute('role') || implicitRole) as Role;
        const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim() || '').filter(Boolean).join(' ');
        const labels = Array.from(input.labels || []).map(label => {
          const clone = label.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('button,input,select,textarea').forEach(control => control.remove());
          return (clone.textContent || '').replace(/\s+/g, ' ').trim();
        }).filter(Boolean).join(' ');
        const name = (element.getAttribute('aria-label') || labelledBy || labels || (element as HTMLElement).innerText || input.placeholder || '').trim();
        return { id: `c${revision}_${index}`, role, name, disabled: input.disabled || false, checked: ['checkbox', 'radio'].includes(role) ? input.checked : undefined };
      })
      .filter(control => ['button', 'checkbox', 'combobox', 'dialog', 'link', 'radio', 'searchbox', 'textbox'].includes(control.role) && control.name),
    this.#revision) as Control[];
    this.#cachedControls = { revision: this.#revision, controls };
    return controls;
  }

  async #expect(action: Extract<Action, { op: 'expect' }>): Promise<boolean> {
    const page = this.#requirePage();
    try {
      if (action.text) await page.waitForFunction(expected => document.body.innerText.includes(expected), action.text, { timeout: EXPECT_TIMEOUT });
      if (action.urlIncludes) await page.waitForURL(url => url.toString().includes(action.urlIncludes!), { timeout: EXPECT_TIMEOUT });
      return true;
    } catch { return false; }
  }

  async #select(locator: Locator, requested: string): Promise<void> {
    const options = await locator.locator('option').evaluateAll(elements => elements.map(element => ({
      value: (element as HTMLOptionElement).value,
      label: (element.textContent || '').replace(/\s+/g, ' ').trim(),
      disabled: (element as HTMLOptionElement).disabled,
    })));
    const exactValue = options.filter(option => !option.disabled && option.value === requested);
    const byLabel = options.filter(option => !option.disabled && normalize(option.label) === normalize(requested));
    const matches = exactValue.length ? exactValue : byLabel;
    if (matches.length !== 1) throw new Error(`Select option ${JSON.stringify(requested)} was ${matches.length ? 'ambiguous' : 'not found'}`);
    await locator.selectOption(matches[0].value);
  }

  async #confirm(action: Action): Promise<void> {
    if (!('target' in action) || !HIGH_IMPACT.test(action.target.name)) return;
    if (!action.confirm || !(await this.options.approveHighImpact?.(action))) {
      throw new Error(`Host confirmation required for high-impact action: ${action.target.name}`);
    }
  }

  #requirePage(): Page {
    if (!this.#page) throw new Error('No page is open. Use navigate or begin the program with a navigate step.');
    return this.#page;
  }

  #advance(): void {
    this.#revision += 1;
    this.#cachedControls = undefined;
  }
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
