import { ApexBrowseSession } from './session.js';
import type { Program, RepairPacket, RunResult, Target } from './types.js';

/** The only model-facing decision in a normal run: one bounded target repair. */
export type RepairDecider = (packet: RepairPacket) => Promise<Target | undefined>;

export async function runWithOneRepair(session: ApexBrowseSession, program: Program, decideRepair: RepairDecider): Promise<RunResult> {
  const first = await session.run(program);
  if (first.status !== 'needs_repair') return first;
  const target = await decideRepair(first.repair);
  if (!target) return { status: 'failed', receipts: first.receipts, error: 'Host declined to repair unresolved target', metrics: first.metrics };
  return session.repair(first.repair.runId, target);
}
