import type { ExecOpts, ExecResult, ModuleFs } from "@pvx/sdk";

export type ExecFn = (cmd: string, args?: string[], opts?: ExecOpts) => Promise<ExecResult>;
export type EngineId = "firewalld" | "nftables" | "iptables";

/** What an engine needs from the host: `ctx.exec` and `ctx.fs` (tests hand it fakes). */
export interface Io {
  exec: ExecFn;
  fs: ModuleFs;
  /** firewalld zone; default `pvxfw`. */
  zone?: string;
}

/** What the lists ask for. `failsafe` is the SSH client IP: it comes first and is never saved in the lists. */
export interface Desired {
  ipAccept: string[];
  ipDeny: string[];
  portAccept: string[];
  portDeny: string[];
  failsafe?: string;
}

export interface EngineStatus {
  /** The engine can be driven on this host. */
  available: boolean;
  reason?: string;
  /** Rules owned by pvx are loaded. */
  active: boolean;
  /** The loaded rules, in the same canonical form `render` returns. */
  rules: string[];
}

export interface Engine {
  id: EngineId;
  status(io: Io): Promise<EngineStatus>;
  /** Pure: the rules, in order, in the engine's canonical form. One line is one rule. */
  render(d: Desired, zone?: string): string[];
  /** Loads the rules (atomically where the engine allows). Throws on failure. */
  apply(io: Io, d: Desired): Promise<void>;
  /** A `sh` script that puts the current rules back. */
  snapshot(io: Io): Promise<string>;
  /** Runs a script `snapshot` produced. */
  restore(io: Io, scriptPath: string): Promise<void>;
  bootEnable(io: Io, pvxBin: string): Promise<void>;
  bootDisable(io: Io): Promise<void>;
  bootStatus(io: Io): Promise<"enabled" | "disabled">;
}
