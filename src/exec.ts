import type { ExecResult } from "@pvx/sdk";
import type { ExecFn } from "./engines/types.ts";

/** A missing program is exit 127, not a throw; a permission violation of the host still throws. */
export const run = async (exec: ExecFn, cmd: string, args: string[] = [], opts?: Parameters<ExecFn>[2]): Promise<ExecResult> => {
  try {
    return await exec(cmd, args, opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/permiss/i.test(msg)) throw e;
    return { code: 127, stdout: "", stderr: msg };
  }
};

export const ok = (r: ExecResult) => r.code === 0;
export const fail = (what: string, r: ExecResult) => new Error(`${what} falhou (exit ${r.code}): ${(r.stderr || r.stdout).trim() || "sem mensagem"}`);

/** Single-quotes a string for `sh`. */
export const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
