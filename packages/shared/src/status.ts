import { z } from 'zod';

/**
 * Red/Amber/Green status model used by the check engine.
 *
 * Colour is never the only signal: every state carries an icon name and a text
 * label so the UI stays readable for colour-blind users and in high-contrast
 * modes. See `statusPresentation` below.
 */
export const CheckState = z.enum([
  /** Something will not work until this is fixed. */
  'blocked',
  /** Works, but degraded, risky, or suboptimal. */
  'warning',
  /** Verified good. */
  'ok',
  /** Optional component absent / not configured. */
  'absent',
  /** Check is currently running. */
  'checking',
  /** The check could not be run (e.g. needs admin rights, or the host is offline). */
  'unknown',
]);
export type CheckState = z.infer<typeof CheckState>;

/**
 * Ordering used to roll several checks up into one badge. Higher wins, so a
 * single blocked check dominates a page full of green ones.
 */
const STATE_SEVERITY: Record<CheckState, number> = {
  ok: 0,
  absent: 1,
  unknown: 2,
  checking: 3,
  warning: 4,
  blocked: 5,
};

export function rollUpState(states: readonly CheckState[]): CheckState {
  let worst: CheckState = 'ok';
  for (const state of states) {
    if (STATE_SEVERITY[state] > STATE_SEVERITY[worst]) worst = state;
  }
  return worst;
}

export interface StatusPresentation {
  /** lucide-vue-next icon name. */
  readonly icon: string;
  /** Short text label. Always rendered — colour is never the only signal. */
  readonly label: string;
  /** Semantic Tailwind theme token, defined in the panel's `@theme` block. */
  readonly token: string;
}

export const statusPresentation: Record<CheckState, StatusPresentation> = {
  blocked: { icon: 'circle-x', label: 'Needs fixing', token: 'status-blocked' },
  warning: { icon: 'triangle-alert', label: 'Warning', token: 'status-warn' },
  ok: { icon: 'circle-check', label: 'OK', token: 'status-ok' },
  absent: { icon: 'circle-dashed', label: 'Not installed', token: 'status-absent' },
  checking: { icon: 'loader-circle', label: 'Checking', token: 'status-checking' },
  unknown: { icon: 'circle-help', label: 'Unknown', token: 'status-absent' },
};

/** Groups checks in the UI. */
export const CheckCategory = z.enum([
  'runtimes',
  'components',
  'server',
  'network',
  'integrations',
  'security',
  'site',
]);
export type CheckCategory = z.infer<typeof CheckCategory>;

/**
 * A fix the panel can perform on the user's behalf.
 *
 * `kind: 'automatic'` fixes can be queued by the "Fix everything safe" action.
 * `kind: 'manual'` fixes cannot be automated (OVH port 25, PTR records) and
 * instead link out with instructions.
 */
export const CheckFix = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('automatic'),
    /** Identifier the agent maps to a fix handler. */
    action: z.string().min(1),
    label: z.string().min(1),
    /** Plain-English description of exactly what will change. */
    describesChange: z.string().min(1),
    /** Whether this is safe to run unattended as part of "Fix everything safe". */
    safeToBatch: z.boolean().default(true),
    /** Whether the change records an undo entry. */
    reversible: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('manual'),
    label: z.string().min(1),
    instructions: z.string().min(1),
    url: z.string().url().optional(),
  }),
]);
export type CheckFix = z.infer<typeof CheckFix>;

export const CheckResult = z.object({
  id: z.string().min(1),
  category: CheckCategory,
  /** Short title, plain English, no jargon. */
  name: z.string().min(1),
  /** One or two sentences explaining what this is and why it matters. */
  plainDescription: z.string().min(1),
  state: CheckState,
  /** The detected value, shown alongside the state (e.g. "Node 22.14.0"). */
  detail: z.string().optional(),
  /** Why it is not OK, in plain English. Required when not ok/checking. */
  reason: z.string().optional(),
  fix: CheckFix.optional(),
  /** Site slug, when this check belongs to a specific site. */
  siteSlug: z.string().optional(),
  checkedAt: z.coerce.date(),
  /** How long the result may be reused before re-running. */
  ttlSeconds: z.number().int().positive().default(60),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const CheckReport = z.object({
  results: z.array(CheckResult),
  overall: CheckState,
  generatedAt: z.coerce.date(),
});
export type CheckReport = z.infer<typeof CheckReport>;
