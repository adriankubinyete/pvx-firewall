import type { ExecResult, StepError } from "@pvx/sdk";
import type { ExecFn } from "./engines/types.ts";

// Commands use `ctx.shell`. The probes (a query, a proof, a widget) get a ReadCtx, which has no `shell`, so they keep this small `run` over `exec`.

/** The exit code `run` reports for a program that is not installed (the shell convention for "command not found"). */
export const EXEC_NOT_FOUND = 127;

/** The host's message when a program is not in `permissions.exec`: a module bug, never swallowed. */
const PERMISSION_ERROR = /permiss/i;

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A `ctx.shell.must` failure: its `output` has the lines that name the cause. */
const isStepError = (error: unknown): error is StepError => error instanceof Error && error.name === "StepError";

/** What went wrong, for the technician: a failed step adds the lines of output that explain it. */
export function describeFailure(error: unknown): string {
  const message = errorMessage(error);
  if (!isStepError(error) || !error.output.length) return message;
  return `${message}: ${error.output.join("; ")}`;
}

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

/** Single-quotes a string for `sh`. */
export const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
