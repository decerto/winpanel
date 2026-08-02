import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

/**
 * The only way this agent is permitted to run an external program.
 *
 * Rules enforced here, not by convention:
 *   - `shell` is always false. Nothing is ever handed to cmd.exe or
 *     PowerShell for parsing, so quoting and metacharacters in a filename,
 *     branch name, or manifest value cannot become command injection.
 *   - Arguments are always an array. There is no string-command overload,
 *     because offering one is how injection bugs get written later.
 *   - Output is streamed and size-capped, so a runaway build cannot exhaust
 *     memory.
 *
 * Anything that needs a shell pipeline should be expressed as a package.json
 * script and run through the package manager instead.
 */

export interface RunOptions {
  /** Absolute path to the executable, or a bare name resolved via PATH. */
  readonly exe: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Extra environment variables merged over a minimal inherited base. */
  readonly env?: Readonly<Record<string, string>>;
  /** Kill the process after this many milliseconds. */
  readonly timeoutMs?: number;
  /** Called for each line of stdout/stderr as it arrives. */
  readonly onOutput?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Fed to the process's stdin, then closed. */
  readonly stdin?: string;
  /** Cap on captured output. Beyond this, output is truncated. */
  readonly maxOutputBytes?: number;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** True when output was truncated because it exceeded the cap. */
  readonly truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class CommandError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

/** Rejects arguments that cannot be passed safely to a Windows process. */
function assertSafeArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new TypeError('Command arguments must all be strings.');
    }
    if (arg.includes('\u0000')) {
      throw new Error('Command arguments must not contain null bytes.');
    }
  }
}

/**
 * A deliberately small environment. Inheriting the full parent environment
 * would leak the agent's own secrets into every build process a site runs.
 */
function buildEnv(extra?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    SystemRoot: process.env['SystemRoot'] ?? '',
    windir: process.env['windir'] ?? '',
    TEMP: process.env['TEMP'] ?? '',
    TMP: process.env['TMP'] ?? '',
    COMSPEC: process.env['COMSPEC'] ?? '',
    PATHEXT: process.env['PATHEXT'] ?? '',
    NUMBER_OF_PROCESSORS: process.env['NUMBER_OF_PROCESSORS'] ?? '',
    PROCESSOR_ARCHITECTURE: process.env['PROCESSOR_ARCHITECTURE'] ?? '',
  };
  return extra ? { ...base, ...extra } : base;
}

export async function runCommand(options: RunOptions): Promise<RunResult> {
  assertSafeArgs(options.args);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();

  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: buildEnv(options.env),
    // Never true. See the module comment.
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  return await new Promise<RunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(options.exe, [...options.args], spawnOptions);
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const makeCollector = (stream: 'stdout' | 'stderr') => {
      let partial = '';
      return (chunk: Buffer) => {
        const text = chunk.toString('utf8');

        if (capturedBytes < maxOutputBytes) {
          const remaining = maxOutputBytes - capturedBytes;
          const slice = text.length > remaining ? text.slice(0, remaining) : text;
          capturedBytes += slice.length;
          if (stream === 'stdout') stdout += slice;
          else stderr += slice;
          if (slice.length < text.length) truncated = true;
        } else {
          truncated = true;
        }

        if (options.onOutput) {
          partial += text;
          const lines = partial.split(/\r?\n/);
          partial = lines.pop() ?? '';
          for (const line of lines) options.onOutput(line, stream);
        }
      };
    };

    child.stdout?.on('data', makeCollector('stdout'));
    child.stderr?.on('data', makeCollector('stderr'));

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated,
      });
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => finish(code ?? (timedOut ? 124 : 1)));
  });
}

/** Runs a command and throws unless it exits zero. */
export async function runCommandOrThrow(options: RunOptions): Promise<RunResult> {
  const result = await runCommand(options);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n');
    throw new CommandError(
      result.timedOut
        ? `${options.exe} took too long and was stopped.`
        : `${options.exe} failed (exit code ${result.exitCode}). ${detail}`,
      result,
    );
  }
  return result;
}
