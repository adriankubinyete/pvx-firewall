// What the three engines share: the restore script, the status answers and the way an address is written.
import { normCidr } from "../net.ts";
import type { EngineStatus, Io } from "./types.ts";

/** An address as the lists store it: the canonical CIDR text (`/32` dropped), or the text itself if it is not one. */
export const canonicalAddress = (value: string): string => normCidr(value) ?? value;

/** Runs a script `snapshot` produced. The same `sh` for every engine: each snapshot is a self-contained script. */
export async function restoreFromScript(io: Io, scriptPath: string): Promise<void> {
  await io.shell.must("sh", [scriptPath]);
}

export const unavailable = (reason: string): EngineStatus => ({ available: false, reason, active: false, rules: [] });

/** The engine works; it is `active` when any rule of ours is loaded (`isActive` overrides that). */
export const available = (rules: string[], isActive = rules.length > 0): EngineStatus => ({ available: true, active: isActive, rules });
