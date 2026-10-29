/**
 * The small `psql` plumbing the per-job database clones share: a runner that
 * reports a non-zero exit through its result instead of throwing, and the
 * connection-string tidy-up psql needs.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Test-seam shape for overriding shell invocation. */
export type ExecRunner = (
  bin: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const MAXBUFFER_OVERFLOW_MSG =
  "exec output exceeded maxBuffer — refusing to use potentially-truncated content";

type ExecFileP = (
  bin: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Build a runner with the given output budget. A non-zero exit is REPORTED in
 * the result, never thrown — psql errors are normal flow here. A missing
 * binary (spawn ENOENT) maps to the conventional command-not-found code 127.
 * `execFilePImpl` is an injection point for tests.
 */
export function _createExecRunner(
  maxBuffer: number,
  execFilePImpl: ExecFileP = execFileP as unknown as ExecFileP,
): ExecRunner {
  return async (bin, args, opts) => {
    try {
      const { stdout, stderr } = await execFilePImpl(bin, [...args], {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeout,
        maxBuffer,
      });
      // Some Node versions return stdout exactly at the cap without throwing
      // when the child exits as the buffer fills: treat that as truncation.
      if (typeof stdout === "string" && stdout.length === maxBuffer) {
        return { stdout: "", stderr: MAXBUFFER_OVERFLOW_MSG, exitCode: 1 };
      }
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        return { stdout: "", stderr: MAXBUFFER_OVERFLOW_MSG, exitCode: 1 };
      }
      const exitCode =
        typeof e.code === "number" ? e.code : e.code === "ENOENT" ? 127 : 1;
      return {
        stdout: typeof e.stdout === "string" ? e.stdout : "",
        stderr:
          typeof e.stderr === "string"
            ? e.stderr
            : (e.message ?? "execFile failed"),
        exitCode,
      };
    }
  };
}

/**
 * Strip connection-string query parameters that libpq/psql rejects but the
 * application's JS driver tolerates (a Vercel/Supabase pooler appends
 * `?workaround=supabase-pooler.vercel`; psql exits 2 on it). Only that one
 * param is removed, so legitimate libpq params (sslmode, connect_timeout, …)
 * survive. Non-URL strings are returned unchanged.
 */
export function toPsqlUri(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    u.searchParams.delete("workaround");
    return u.toString();
  } catch {
    return databaseUrl;
  }
}
