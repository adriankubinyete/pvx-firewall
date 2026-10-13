// Automatic revert. Before a change is loaded, a job is scheduled outside pvx that restores the saved snapshot after 60 s,
// unless `firewall confirm` removed the marker first. It survives pvx exiting and the SSH session dropping:
// systemd-run owns it, with a detached `sh` as fallback. Both are guarded by the same marker file.
import type { ModuleFs, Store } from "@pvx/sdk";
import { ok, run, sq } from "./exec.ts";
import type { ExecFn } from "./engines/types.ts";

export const ROLLBACK_SECONDS = 60;
export const UNIT = "pvx-firewall-revert";

export const stateDir = () => `${process.env.PVX_HOME || "/etc/pvx"}/modules/firewall/state`;
export const paths = (dir = stateDir()) => ({ marker: `${dir}/rollback.pending`, script: `${dir}/snapshots/restore.sh` });

/** What the job runs: only if still marked, restore, then unmark. */
export const guard = (p: { marker: string; script: string }) => `[ -f ${sq(p.marker)} ] && { sh ${sq(p.script)}; rm -f ${sq(p.marker)}; }; true`;

export type Pending = { state: "none" } | { state: "pending"; left: number } | { state: "reverted" } | { state: "expired" };

/** Derived from the store (`pending.deadline`) and the marker: nothing here writes. */
export async function pendingInfo(fs: Pick<ModuleFs, "exists">, store: { get<T>(k: string): T | undefined }, now = Date.now()): Promise<Pending> {
  const p = store.get<{ deadline: number }>("pending");
  if (!p) return { state: "none" };
  if (!(await fs.exists(paths().marker))) return { state: "reverted" };
  return now > p.deadline + 15_000 ? { state: "expired" } : { state: "pending", left: Math.max(0, Math.ceil((p.deadline - now) / 1000)) };
}

/** Marks and schedules. Returns how it was scheduled. */
export async function schedule(exec: ExecFn, fs: ModuleFs, store: Store, now = Date.now()): Promise<"systemd" | "sh"> {
  const p = paths();
  await fs.write(p.marker, String(now));
  store.set("pending", { at: now, deadline: now + ROLLBACK_SECONDS * 1000 });
  const g = guard(p);
  const s = await run(exec, "systemd-run", [`--on-active=${ROLLBACK_SECONDS}`, `--unit=${UNIT}`, "--collect", "--description=pvx firewall: automatic revert", "sh", "-c", g]);
  if (ok(s)) return "systemd";
  // Fallback: a detached shell with every fd redirected, so ctx.exec does not wait for the sleep.
  await exec("sh", ["-c", `nohup sh -c ${sq(`sleep ${ROLLBACK_SECONDS}; ${g}`)} >/dev/null 2>&1 </dev/null &`]);
  return "sh";
}

/** `confirm`: removing the marker is what disarms both jobs; the timer is stopped as well. */
export async function cancel(exec: ExecFn, fs: ModuleFs): Promise<void> {
  await fs.remove(paths().marker);
  await run(exec, "systemctl", ["stop", `${UNIT}.timer`]);
}
