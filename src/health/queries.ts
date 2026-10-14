// The module's queries. Read only: they never write the store. The page reads `firewall.status` and `firewall.diff` with `useQuery`
// (so a refresh does not land in the history or the audit); `firewall.missingBaseIps` is for other modules.
import type { ModuleQuery, ReadCtx } from "@pvx/sdk";
import { missingBase, load } from "../state.ts";
import { bootUnitEnabled, readDiff, readLiveStatus, readSummary, type DiffView, type EngineProblem, type LiveStatus, type Summary } from "./summary.ts";

export interface StatusView {
  /** The engine of the last apply, else the one the setting names. */
  engine: string;
  applied: Summary["lastApply"] | null;
  /** The lists are the ones the last apply loaded. */
  current: boolean;
  pending: Summary["pending"];
  missingBaseIps: string[];
  /** The boot unit is enabled, from the file systemd links. */
  boot: boolean;
  /** The engine probed now; an `error` when it cannot be driven. */
  live: LiveStatus | EngineProblem;
}

async function statusView(ctx: ReadCtx): Promise<StatusView> {
  const summary = await readSummary(ctx);
  return {
    engine: summary.lastApply?.engine ?? summary.engineSetting,
    applied: summary.lastApply ?? null,
    current: summary.listsMatchLastApply,
    pending: summary.pending,
    missingBaseIps: summary.missingBase.map(([ip]) => ip),
    boot: await bootUnitEnabled(ctx.fs),
    live: await readLiveStatus(ctx),
  };
}

export const queries: Record<string, ModuleQuery> = {
  "firewall.missingBaseIps": function () {
    return missingBase(load(this.store)).map(([ip, comment]) => ({ ip, comment }));
  },
  "firewall.status": function () {
    return statusView(this);
  },
  "firewall.diff": function (): Promise<DiffView | EngineProblem> {
    return readDiff(this);
  },
};
