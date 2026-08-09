import { z } from 'zod';
import { roles, type Action, type Program, type Target } from './types.js';

const target: z.ZodType<Target> = z.lazy(() => z.object({
  role: z.enum(roles), name: z.string().min(1), aliases: z.array(z.string().min(1)).max(8).optional(), scope: target.optional(),
}));
const confirmation = { confirm: z.boolean().optional() };
export const ActionSchema: z.ZodType<Action> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('navigate'), url: z.string().url() }),
  z.object({ op: z.literal('click'), target, ...confirmation }),
  z.object({ op: z.literal('fill'), target, value: z.string(), submit: z.boolean().optional(), ...confirmation }),
  z.object({ op: z.literal('select'), target, value: z.string(), ...confirmation }),
  z.object({ op: z.literal('check'), target, ...confirmation }),
  z.object({ op: z.literal('press'), key: z.string().min(1), ...confirmation }),
  z.object({ op: z.literal('expect'), text: z.string().min(1).optional(), urlIncludes: z.string().min(1).optional() }).refine(value => Boolean(value.text || value.urlIncludes), 'expect needs text or urlIncludes'),
]);
export const ProgramSchema: z.ZodType<Program> = z.object({ steps: z.array(ActionSchema).min(1).max(50) });

export function parseProgram(value: unknown): Program {
  return ProgramSchema.parse(value);
}
