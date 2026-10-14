// Automatic revert. Before a change is loaded, a job is scheduled outside pvx that restores the saved snapshot after 60 s,
// unless `firewall confirm` removed the marker first. It survives pvx exiting and the SSH session dropping:
// systemd-run owns it, with a detached `sh` as fallback. Both are guarded by the same marker file.
import type { ModuleFs, Shell, Store } from "@pvx/sdk";
import { shellQuote } from "./exec.ts";
import { STORE_KEY, type PendingRevert } from "./state.ts";

export const ROLLBACK_SECONDS = 60;
export const ROLLBACK_MS = ROLLBACK_SECONDS * 1000;
/** How late the revert may be before `pendingInfo` says "expired": the job did not fire. */
const EXPIRED_GRACE_MS = 15_000;
export const UNIT = "pvx-firewall-revert";

export const stateDir = () => `${process.env.PVX_HOME || "/etc/pvx"}/modules/firewall/state`;

export interface RollbackFiles {
  /** Exists while a revert is armed; removing it disarms the job. */
  marker: string;
  /** The `sh` script `engine.snapshot` wrote. */
  script: string;
}
export const paths = (dir = stateDir()): RollbackFiles => ({ marker: `${dir}/rollback.pending`, script: `${dir}/snapshots/restore.sh` });

/** What the job runs: only if still marked, restore, then unmark. */
export const guard = (files: RollbackFiles) =>
  `[ -f ${shellQuote(files.marker)} ] && { sh ${shellQuote(files.script)}; rm -f ${shellQuote(files.marker)}; }; true`;

export type Pending = { state: "none" } | { state: "pending"; left: number } | { state: "reverted" } | { state: "expired" };

/** Derived from the store (`pending.deadline`) and the marker: nothing here writes. */
export async function pendingInfo(fs: Pick<ModuleFs, "exists">, store: Pick<Store, "get">, now = Date.now()): Promise<Pending> {
  const pending = store.get<PendingRevert>(STORE_KEY.pending);
  if (!pending) return { state: "none" };
  if (!(await fs.exists(paths().marker))) return { state: "reverted" };
  if (now > pending.deadline + EXPIRED_GRACE_MS) return { state: "expired" };
  return { state: "pending", left: Math.max(0, Math.ceil((pending.deadline - now) / 1000)) };
}

/** How the revert is told in `firewall status`. */
export function describePending(pending: Pending): string {
  switch (pending.state) {
    case "none":
      return "nenhuma";
    case "pending":
      return `pendente, ${pending.left}s`;
    case "reverted":
      return "ocorreu (regras anteriores voltaram)";
    case "expired":
      return "atrasada (o job não disparou)";
  }
}

export type ScheduledBy = "systemd" | "sh";

/** Marks and schedules. Returns how it was scheduled. */
export async function schedule(shell: Shell, fs: ModuleFs, store: Store, now = Date.now()): Promise<ScheduledBy> {
  const files = paths();
  await fs.write(files.marker, String(now));
  store.set(STORE_KEY.pending, { at: now, deadline: now + ROLLBACK_MS } satisfies PendingRevert);
  const revertCommand = guard(files);
  const viaSystemd = await shell.ok("systemd-run", [`--on-active=${ROLLBACK_SECONDS}`, `--unit=${UNIT}`, "--collect", "--description=pvx firewall: automatic revert", "sh", "-c", revertCommand]);
  if (viaSystemd) return "systemd";
  // Fallback: a detached shell with every fd redirected, so ctx.exec does not wait for the sleep.
  await shell.run("sh", ["-c", `nohup sh -c ${shellQuote(`sleep ${ROLLBACK_SECONDS}; ${revertCommand}`)} >/dev/null 2>&1 </dev/null &`]);
  return "sh";
}

/** `confirm`: removing the marker is what disarms both jobs; the timer is stopped as well. */
export async function cancel(shell: Shell, fs: ModuleFs): Promise<void> {
  await fs.remove(paths().marker);
  await shell.run("systemctl", ["stop", `${UNIT}.timer`]);
}
