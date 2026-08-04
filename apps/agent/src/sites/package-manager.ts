import type { BuildStep, PackageManager, StepCommand } from '@winpanel/shared';

/**
 * Switching a site from one package manager to another.
 *
 * `manifest.packageManager` alone is not enough: every build step carries its
 * own command, worked out when the project was first inspected. Changing the
 * setting without touching the steps left a site that says "npm" everywhere in
 * the panel and still runs `pnpm install` on every deploy, which is how a
 * pnpm-only problem survives being told to stop using pnpm.
 */

const MANAGERS: readonly StepCommand[] = ['npm', 'pnpm', 'yarn', 'bun'];

/** Install subcommands, including npm's `ci` and pnpm's `i` shorthand. */
const INSTALL_VERBS = new Set(['install', 'i', 'ci', 'add']);

const PRODUCTION_FLAGS = new Set(['--prod', '--production', '--omit=dev']);

function installArgs(manager: PackageManager, production: boolean): string[] {
  if (!production) return ['install'];

  // npm's `ci` is not used here even though it is the better command: it
  // refuses to run without a package-lock.json that matches package.json, and
  // a project being moved onto npm is exactly the one unlikely to have it.
  if (manager === 'npm') return ['install', '--omit=dev'];
  if (manager === 'pnpm') return ['install', '--prod'];
  return ['install', '--production'];
}

/**
 * Rewrites every build step that invokes a package manager so it invokes
 * `manager` instead. Steps running `node`, `npx` or `dotnet` are left alone.
 */
export function retargetSteps(
  steps: readonly BuildStep[],
  manager: PackageManager,
): { steps: BuildStep[]; changed: number } {
  let changed = 0;

  const next = steps.map((step) => {
    if (!MANAGERS.includes(step.command)) return step;

    const verb = step.args[0] ?? '';
    const args = INSTALL_VERBS.has(verb)
      ? installArgs(manager, step.args.some((arg) => PRODUCTION_FLAGS.has(arg)))
      : [...step.args];

    if (step.command === manager && sameArgs(step.args, args)) return step;

    changed++;
    return { ...step, command: manager as StepCommand, args };
  });

  return { steps: next, changed };
}

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
