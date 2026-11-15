import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface CliInfo {
  available: boolean;
  /** Command to run, or null when the CLI was not found. */
  command: string | null;
  version: string | null;
  reason?: string;
}

export interface CliRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

function run(file: string, args: string[], cwd: string, timeoutMs: number, shell: boolean): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, shell, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout, stderr });
        const timedOut = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
        resolve({ ok: false, stdout, stderr, error: timedOut ? 'انتهت مهلة الأمر' : `رمز الخروج ${String(error.code ?? '?')}` });
      },
    );
  });
}

/**
 * Locates the Claude CLI. `CLAUDE_ADDS_CLAUDE_BIN` overrides the lookup, which
 * is also how the missing-CLI state is exercised in tests.
 */
export async function detectCli(cwd: string, env: NodeJS.ProcessEnv): Promise<CliInfo> {
  const override = env.CLAUDE_ADDS_CLAUDE_BIN;
  let command: string;
  if (override) {
    if (!existsSync(override)) {
      return { available: false, command: null, version: null, reason: 'المسار المحدد لـ Claude CLI غير موجود.' };
    }
    command = `"${override}"`;
  } else {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    const found = await run(finder, ['claude'], cwd, 10000, false);
    if (!found.ok || !found.stdout.trim()) {
      return { available: false, command: null, version: null, reason: 'لم يُعثر على الأمر claude في PATH.' };
    }
    command = 'claude';
  }

  const version = await run(command, ['--version'], cwd, 20000, true);
  if (!version.ok) {
    return { available: false, command: null, version: null, reason: `تعذّر تشغيل claude --version (${version.error}).` };
  }
  return { available: true, command, version: version.stdout.trim().split(/\r?\n/)[0] ?? null };
}

/** Runs a read-only CLI subcommand. Arguments are fixed strings, never user input. */
export function runCli(cli: CliInfo, args: string[], cwd: string, timeoutMs: number): Promise<CliRun> {
  if (!cli.command) return Promise.resolve({ ok: false, stdout: '', stderr: '', error: 'Claude CLI غير متاح' });
  return run(cli.command, args, cwd, timeoutMs, true);
}
