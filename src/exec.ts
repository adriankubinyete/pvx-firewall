import type { ExecResult } from "@pvx/sdk";

// Every program runs through `ctx.shell` (a probe gets the read-only one from its `ReadCtx`), so what is left here is about its results.

/** The exit code `shell.run` reports for a program that is not installed (the shell convention for "command not found"). */
export const EXEC_NOT_FOUND = 127;

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const ok = (result: Pick<ExecResult, "code">) => result.code === 0;
export const notFound = (result: Pick<ExecResult, "code">) => result.code === EXEC_NOT_FOUND;

/** Single-quotes a string for `sh`. */
export const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
