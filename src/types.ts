export const roles = ['button', 'checkbox', 'combobox', 'dialog', 'link', 'radio', 'searchbox', 'textbox'] as const;
export type Role = typeof roles[number];

export type Target = { role: Role; name: string; aliases?: string[]; scope?: Target };
export type Action =
  | { op: 'navigate'; url: string }
  | { op: 'click'; target: Target; confirm?: boolean }
  | { op: 'fill'; target: Target; value: string; submit?: boolean; confirm?: boolean }
  | { op: 'select'; target: Target; value: string; confirm?: boolean }
  | { op: 'check'; target: Target; confirm?: boolean }
  | { op: 'press'; key: string; confirm?: boolean }
  | { op: 'expect'; text?: string; urlIncludes?: string };

export type Program = { steps: Action[] };
export type Control = { id: string; role: Role; name: string; disabled: boolean; checked?: boolean };
export type Snapshot = { revision: number; url: string; title: string; controls: Control[]; visibleText: string; omitted: { controls: number; textCharacters: number }; untrusted: true };
export type RepairPacket = { runId: string; step: number; intent: Action; reason: 'missing' | 'ambiguous'; candidates: Control[]; pageRevision: number; untrusted: true };
export type StepReceipt = { step: number; op: Action['op']; status: 'success'; evidenceId: string; resolved?: { role: Role; name: string; via: 'exact' | 'normalized' } };
export type RunMetrics = { durationMs: number; localActions: number; repairs: number };
export type RunResult =
  | { status: 'success'; receipts: StepReceipt[]; metrics: RunMetrics }
  | { status: 'needs_repair'; receipts: StepReceipt[]; repair: RepairPacket; metrics: RunMetrics }
  | { status: 'ambiguous'; receipts: StepReceipt[]; repair: RepairPacket; metrics: RunMetrics }
  | { status: 'failed'; receipts: StepReceipt[]; error: string; metrics: RunMetrics };
