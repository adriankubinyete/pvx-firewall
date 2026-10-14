// The apply flow: snapshot, failsafe, scheduled revert, load, verify. Everything goes through the injected `exec` and `fs`.
// The safety order is the contract: know the failsafe IP, snapshot (only if nothing is pending), schedule the revert,
// load, verify the failsafe rule is really loaded, and only then record.
import type { Store } from "@pvx/sdk";
import type { Engine, Io } from "./engines/types.ts";
import { cancel, paths, pendingInfo, schedule, type ScheduledBy } from "./rollback.ts";
import { STORE_KEY, actor, clearPending, desiredOf, listsFingerprint, load, type FwState, type LastApply } from "./state.ts";

type Env = Record<string, string | undefined>;

export interface ApplyOptions {
  /** The IP the failsafe rule keeps open: the one the technician gave, else the SSH client of the session. Without one, an apply needs `force`. */
  failsafe?: string;
  /** `sdk.errors.describeFailure`: how a failed step is told to the technician. */
  describeFailure: (error: unknown) => string;
  force?: boolean;
  noRollback?: boolean;
  env?: Env;
  now?: number;
}
export type ApplyResult = { ok: true; failsafe?: string; rules: number; scheduled?: ScheduledBy } | { ok: false; error: string };

const NO_SESSION_MESSAGE =
  "não achei o IP da sua sessão SSH: sem o failsafe a aplicação pode derrubar o acesso. Use --failsafe-ip <ip> para informar o seu IP, ou --force para aplicar assim mesmo";

export async function applyFlow(engine: Engine, io: Io, store: Store, options: ApplyOptions): Promise<ApplyResult> {
  const now = options.now ?? Date.now();
  const { failsafe, describeFailure } = options;
  if (!failsafe && !options.force) return { ok: false, error: NO_SESSION_MESSAGE };

  const lists = load(store);
  await snapshotUnlessPending(engine, io, store, now);
  const scheduled = options.noRollback ? undefined : await schedule(io.shell, io.fs, store, now);
  const undo = (why: string) => undoApply(engine, io, store, scheduled !== undefined, why, describeFailure);

  try {
    await engine.apply(io, desiredOf(lists, failsafe));
  } catch (error) {
    return undo(describeFailure(error));
  }

  const loaded = await engine.status(io);
  if (failsafe && !loaded.rules.includes(engine.failsafeRule(failsafe))) {
    return undo(`o IP da sessão (${failsafe}) não apareceu entre as regras carregadas`);
  }
  recordApply(store, { engine, lists, failsafe, rules: loaded.rules.length, scheduled, now, env: options.env });
  return { ok: true, failsafe, rules: loaded.rules.length, scheduled };
}

/** The snapshot is of the state BEFORE the first unconfirmed apply: a second apply while one is pending keeps the older one. */
async function snapshotUnlessPending(engine: Engine, io: Io, store: Store, now: number): Promise<void> {
  const pending = await pendingInfo(io.fs, store, now);
  if (pending.state === "pending") return;
  await io.fs.write(paths().script, await engine.snapshot(io));
}

/**
 * A load that failed or did not keep the failsafe: put the snapshot back, disarm the revert, forget the deadline.
 * `lastApply` stays as it was: this apply never recorded one.
 */
async function undoApply(engine: Engine, io: Io, store: Store, wasScheduled: boolean, why: string, describeFailure: ApplyOptions["describeFailure"]): Promise<ApplyResult> {
  let restoreFailure = "";
  try {
    await engine.restore(io, paths().script);
  } catch (error) {
    restoreFailure = `; a restauração também falhou: ${describeFailure(error)}`;
  }
  if (wasScheduled) await cancel(io.shell, io.fs);
  clearPending(store);
  return { ok: false, error: `${why}; regras anteriores restauradas${restoreFailure}` };
}

interface Applied {
  engine: Engine;
  /** The lists that were loaded. */
  lists: FwState;
  failsafe?: string;
  rules: number;
  scheduled?: ScheduledBy;
  now: number;
  env?: Env;
}

function recordApply(store: Store, applied: Applied): void {
  const record: LastApply = {
    at: new Date(applied.now).toISOString(),
    by: actor(applied.env ?? process.env),
    engine: applied.engine.id,
    key: listsFingerprint(applied.lists),
    rules: applied.rules,
    failsafe: applied.failsafe,
    rollback: applied.scheduled !== undefined,
  };
  store.set(STORE_KEY.lastApply, record);
}
