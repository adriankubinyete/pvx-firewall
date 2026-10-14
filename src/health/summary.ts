// What the module can tell without changing anything: the record of the last apply (`readSummary`, no live probe), the
// live state of the engine (`readLiveStatus`) and what an apply would change (`readDiff`).
// The capabilities, the queries, the widgets, the commands `status` and `check` and the page all read through here.
import type { ReadCtx } from "@pvx/sdk";
import { engineSettingOf, resolveEngine, type EngineSetting } from "../engines/index.ts";
import { diffRules } from "../engines/rules.ts";
import type { BootStatus, EngineId } from "../engines/types.ts";
import { UNIT_NAME } from "../boot.ts";
import { ipv4Of } from "../net.ts";
import { pendingInfo, type Pending } from "../rollback.ts";
import { STORE_KEY, desiredOf, listsFingerprint, load, missingBase, type FwState, type LastApply } from "../state.ts";

/** What a read needs: probes through `shell`, the engine choice through `strategy`, files through `fs`, the record through `store`, the SSH client through `session`. A command context has all of it too. */
export type ReadDeps = Pick<ReadCtx, "shell" | "strategy" | "fs" | "store" | "session">;

/** The user-facing reason the engine cannot be driven. */
export interface EngineProblem {
  error: string;
}

export const isEngineProblem = (value: object): value is EngineProblem => "error" in value;

export interface Summary {
  lists: FwState;
  lastApply?: LastApply;
  pending: Pending;
  /** The lists are the ones the last apply loaded. */
  listsMatchLastApply: boolean;
  engineSetting: EngineSetting;
  missingBase: (readonly [value: string, comment: string])[];
}

/** What the capabilities, the queries and the widgets share: the store and the files, never the live engine (that one is probed by `firewall.active` and the status query only). */
export async function readSummary({ store, fs }: Pick<ReadDeps, "store" | "fs">): Promise<Summary> {
  const lists = load(store);
  const lastApply = store.get<LastApply>(STORE_KEY.lastApply);
  return {
    lists,
    lastApply,
    pending: await pendingInfo(fs, store),
    listsMatchLastApply: lastApply !== undefined && lastApply.key === listsFingerprint(lists),
    engineSetting: engineSettingOf(store),
    missingBase: missingBase(lists),
  };
}

/** Is the boot unit enabled? Read from the `wants` link systemd creates: a file check, no process. */
export const bootUnitEnabled = (fs: Pick<ReadDeps["fs"], "exists">): Promise<boolean> =>
  fs.exists(`/etc/systemd/system/multi-user.target.wants/${UNIT_NAME}`).catch(() => false);

export interface LiveStatus {
  engine: EngineId;
  /** Picked by detection, not by the setting. */
  auto: boolean;
  /** Rules of ours are loaded. */
  active: boolean;
  loadedRules: number;
  wantedRules: number;
  boot: BootStatus;
  /** The SSH client IP, when it is known. */
  session?: string;
  pending: Pending;
  lastApply?: LastApply;
}

/** The live state of the engine against the lists (`firewall status`, and the page's status panel). */
export async function readLiveStatus(deps: ReadDeps): Promise<LiveStatus | EngineProblem> {
  const resolved = await resolveEngine(deps);
  if (isEngineProblem(resolved)) return resolved;
  const { engine, auto, status } = resolved;
  const lastApply = deps.store.get<LastApply>(STORE_KEY.lastApply);
  const wanted = engine.render(desiredOf(load(deps.store), lastApply?.failsafe));
  return {
    engine: engine.id,
    auto,
    active: status.active,
    loadedRules: status.rules.length,
    wantedRules: wanted.length,
    boot: await engine.bootStatus(deps),
    session: ipv4Of(deps.session.sshClient),
    pending: await pendingInfo(deps.fs, deps.store),
    lastApply,
  };
}

export interface DiffView {
  /** Rules an apply would load that are not loaded now. */
  added: string[];
  /** Rules loaded now that an apply would drop. */
  removed: string[];
  /** The failsafe IP: the one given, else the SSH client. Without it an apply needs `--failsafe-ip` or `--force`. */
  session?: string;
  /** Base IPs the lists do not cover. */
  missingBaseIps: string[];
}

/** What an apply would change: the loaded rules against the ones the lists (and the failsafe) ask for. `informedIp`: the IP the technician gave for the failsafe. */
export async function readDiff(deps: Pick<ReadDeps, "shell" | "strategy" | "store" | "session">, informedIp?: string): Promise<DiffView | EngineProblem> {
  const resolved = await resolveEngine(deps);
  if (isEngineProblem(resolved)) return resolved;
  const lists = load(deps.store);
  const session = informedIp ?? ipv4Of(deps.session.sshClient);
  const { added, removed } = diffRules(resolved.status.rules, resolved.engine.render(desiredOf(lists, session)));
  return { added, removed, session, missingBaseIps: missingBase(lists).map(([value]) => value) };
}
