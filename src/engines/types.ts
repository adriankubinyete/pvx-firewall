import type { ExecOpts, ExecResult, ModuleFs, Shell } from "@pvx/sdk";

export type ExecFn = (cmd: string, args?: string[], opts?: ExecOpts) => Promise<ExecResult>;
export type EngineId = "firewalld" | "nftables" | "iptables";
export type BootStatus = "enabled" | "disabled";

/** What an engine needs from the host: `ctx.exec`, `ctx.shell` and `ctx.fs` (tests hand it fakes). */
export interface Io {
  exec: ExecFn;
  shell: Shell;
  fs: ModuleFs;
  /** firewalld zone; default `pvxfw`. */
  zone?: string;
}

/** What a probe needs: no file access, so a read-only context (a query, a proof) can ask an engine for its status. */
export type ProbeIo = Pick<Io, "exec" | "zone">;

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
  status(io: ProbeIo): Promise<EngineStatus>;
  /** Pure: the rules, in order, in the engine's canonical form. One line is one rule. */
  render(desired: Desired): string[];
  /** The one rule that keeps the SSH session alive, in the same form `render` and `status` use. */
  failsafeRule(ip: string): string;
  /** Loads the rules (atomically where the engine allows). Throws on failure. */
  apply(io: Io, desired: Desired): Promise<void>;
  /** A `sh` script that puts the current rules back. */
  snapshot(io: Io): Promise<string>;
  /** Runs a script `snapshot` produced. */
  restore(io: Io, scriptPath: string): Promise<void>;
  bootEnable(io: Io, pvxBin: string): Promise<void>;
  bootDisable(io: Io): Promise<void>;
  bootStatus(io: Pick<Io, "exec">): Promise<BootStatus>;
}
