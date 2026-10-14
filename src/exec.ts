import type { ExecResult } from "@pvx/sdk";
import type { ExecFn } from "./engines/types.ts";

/** The exit code `run` reports for a program that is not installed (the shell convention for "command not found"). */
export const EXEC_NOT_FOUND = 127;

/** The host's message when a program is not in `permissions.exec`: a module bug, never swallowed. */
const PERMISSION_ERROR = /permiss/i;

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A missing program is exit 127, not a throw; a permission violation of the host still throws. */
export const run = async (exec: ExecFn, cmd: string, args: string[] = [], opts?: Parameters<ExecFn>[2]): Promise<ExecResult> => {
  try {
    return await exec(cmd, args, opts);
  } catch (error) {
    const message = errorMessage(error);
    if (PERMISSION_ERROR.test(message)) throw error;
    return { code: EXEC_NOT_FOUND, stdout: "", stderr: message };
  }
};

export const ok = (result: ExecResult) => result.code === 0;
export const notFound = (result: ExecResult) => result.code === EXEC_NOT_FOUND;

/** The error a failed step throws: what was run, its exit code and the first useful output. */
export const fail = (what: string, result: ExecResult) =>
  new Error(`${what} falhou (exit ${result.code}): ${(result.stderr || result.stdout).trim() || "sem mensagem"}`);

/** Runs a step that must succeed: throws `fail(what, ...)` otherwise. */
export async function runOrFail(exec: ExecFn, cmd: string, args: string[], what: string, opts?: Parameters<ExecFn>[2]): Promise<ExecResult> {
  const result = await run(exec, cmd, args, opts);
  if (!ok(result)) throw fail(what, result);
  return result;
}

/** Single-quotes a string for `sh`. */
export const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
