// The apply flow: snapshot, failsafe, scheduled revert, load, verify. Everything goes through the injected `exec` and `fs`.
import type { ModuleFs, Store } from "@pvx/sdk";
import type { Engine, ExecFn, Io } from "./engines/types.ts";
import { run } from "./exec.ts";
import { sessionIp } from "./net.ts";
import { cancel, pendingInfo, paths, schedule, ROLLBACK_SECONDS } from "./rollback.ts";
import { actor, desiredOf, keyOf, load } from "./state.ts";

/** The SSH client: `SSH_CLIENT`, else `who -m`. Undefined when neither says (console, serial). */
export async function detectSession(exec: ExecFn, env: Record<string, string | undefined> = process.env): Promise<string | undefined> {
  const fromEnv = sessionIp(env);
  if (fromEnv) return fromEnv;
  return sessionIp({}, (await run(exec, "who", ["-m"])).stdout);
}

export interface ApplyOpts {
  force?: boolean;
  noRollback?: boolean;
  env?: Record<string, string | undefined>;
  now?: number;
}
export type ApplyResult = { ok: true; failsafe?: string; rules: number; scheduled?: "systemd" | "sh" } | { ok: false; error: string };

export async function applyFlow(engine: Engine, io: Io, store: Store, o: ApplyOpts = {}): Promise<ApplyResult> {
  const now = o.now ?? Date.now();
  const failsafe = await detectSession(io.exec, o.env);
  if (!failsafe && !o.force) return { ok: false, error: "não achei o IP da sessão SSH (SSH_CLIENT, who -m): sem o failsafe a aplicação pode derrubar o acesso. Use --force para aplicar assim mesmo" };

  const st = load(store);
  const d = desiredOf(st, failsafe);
  const p = paths();

  // The snapshot is of the state BEFORE the first unconfirmed apply: a second apply while one is pending keeps the older one.
  const pend = await pendingInfo(io.fs, store, now);
  if (pend.state !== "pending") await io.fs.write(p.script, await engine.snapshot(io));

  let scheduled: "systemd" | "sh" | undefined;
  if (!o.noRollback) scheduled = await schedule(io.exec, io.fs, store, now);

  const undo = async (why: string): Promise<ApplyResult> => {
    let extra = "";
    try {
      await engine.restore(io, p.script);
    } catch (e) {
      extra = `; a restauração também falhou: ${(e as Error).message}`;
    }
    if (scheduled) await cancel(io.exec, io.fs);
    store.delete("pending");
    return { ok: false, error: `${why}; regras anteriores restauradas${extra}` };
  };

  try {
    await engine.apply(io, d);
  } catch (e) {
    return undo((e as Error).message);
  }
  // Verified, not assumed: the failsafe rule must be loaded.
  const after = await engine.status(io);
  const rule = engine.render({ ipAccept: [], ipDeny: [], portAccept: [], portDeny: [], failsafe })[0]!;
  if (failsafe && !after.rules.includes(rule)) {
    return undo(`o IP da sessão (${failsafe}) não apareceu entre as regras carregadas`);
  }
  store.set("lastApply", { at: new Date(now).toISOString(), by: actor(o.env ?? process.env), engine: engine.id, key: keyOf(st), rules: after.rules.length, failsafe, rollback: scheduled !== undefined });
  return { ok: true, failsafe, rules: after.rules.length, scheduled };
}

export const ROLLBACK_MS = ROLLBACK_SECONDS * 1000;
