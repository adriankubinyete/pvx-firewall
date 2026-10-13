import type { ExecResult, ModuleFs } from "@pvx/sdk";
import type { Desired, ExecFn, Io } from "../src/engines/types.ts";

export interface Call {
  cmd: string;
  args: string[];
  stdin?: string;
}
type Reply = Partial<ExecResult> | undefined;

/** An exec that records every call and answers by `reply` (default: exit 0, no output). Nothing real runs. */
export const fakeExec = (reply: (c: Call) => Reply = () => undefined): { exec: ExecFn; calls: Call[] } => {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, args = [], opts) => {
    const c = { cmd, args, stdin: opts?.stdin };
    calls.push(c);
    return { code: 0, stdout: "", stderr: "", ...reply(c) };
  };
  return { exec, calls };
};

export const line = (c: Call) => `${c.cmd} ${c.args.join(" ")}`;

export const fakeFs = (): ModuleFs & { files: Map<string, string> } => {
  const files = new Map<string, string>();
  return {
    files,
    read: async (p) => {
      if (!files.has(p)) throw new Error(`sem arquivo ${p}`);
      return files.get(p)!;
    },
    write: async (p, d) => void files.set(p, d),
    exists: async (p) => files.has(p),
    list: async () => [],
    remove: async (p) => void files.delete(p),
    append: async (p, t) => void files.set(p, (files.get(p) ?? "") + t),
  };
};

export const memStore = (init: Record<string, unknown> = {}) => {
  const data: Record<string, unknown> = { ...init };
  return { data, get: <T,>(k: string) => data[k] as T | undefined, set: (k: string, v: unknown) => void (data[k] = v), delete: (k: string) => void delete data[k] };
};

export const io = (exec: ExecFn, fs = fakeFs(), zone?: string): Io => ({ exec, fs, zone });

export const sample: Desired = {
  ipAccept: ["127.0.0.1", "10.0.0.0/8", "203.0.113.9"],
  ipDeny: ["198.51.100.0/24"],
  portAccept: ["5060/udp", "10000-20000/udp"],
  portDeny: ["80/tcp", "20-23"],
  failsafe: "203.0.113.7",
};
