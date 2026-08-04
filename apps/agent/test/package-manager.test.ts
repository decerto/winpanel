import { describe, expect, it } from 'vitest';
import type { BuildStep } from '@winpanel/shared';
import { retargetSteps } from '../src/sites/package-manager.js';

function step(partial: Partial<BuildStep>): BuildStep {
  return { name: 'Step', cwd: '', command: 'pnpm', args: [], optional: false, env: {}, ...partial };
}

describe('retargetSteps', () => {
  it('moves install and build steps onto the chosen package manager', () => {
    const result = retargetSteps(
      [
        step({ name: 'Install packages', command: 'pnpm', args: ['install'] }),
        step({ name: 'Build', command: 'pnpm', args: ['run', 'build'] }),
      ],
      'npm',
    );

    expect(result.changed).toBe(2);
    expect(result.steps[0]).toMatchObject({ command: 'npm', args: ['install'] });
    expect(result.steps[1]).toMatchObject({ command: 'npm', args: ['run', 'build'] });
  });

  it('keeps a production install a production install', () => {
    const result = retargetSteps(
      [step({ command: 'pnpm', args: ['install', '--prod'] })],
      'npm',
    );

    expect(result.steps[0]?.args).toEqual(['install', '--omit=dev']);
  });

  it('translates npm ci back to a plain install, which needs no lockfile', () => {
    const result = retargetSteps([step({ command: 'npm', args: ['ci', '--omit=dev'] })], 'pnpm');

    expect(result.steps[0]?.args).toEqual(['install', '--prod']);
  });

  it('leaves steps that are not a package manager alone', () => {
    const original = step({ name: 'Migrate', command: 'node', args: ['scripts/migrate.js'] });
    const result = retargetSteps([original], 'npm');

    expect(result.changed).toBe(0);
    expect(result.steps[0]).toBe(original);
  });

  it('reports no change when the steps already use that manager', () => {
    const result = retargetSteps([step({ command: 'npm', args: ['run', 'build'] })], 'npm');

    expect(result.changed).toBe(0);
  });
});
