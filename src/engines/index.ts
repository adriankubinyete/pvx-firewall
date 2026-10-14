import type { ReadCtx, Store } from "@pvx/sdk";
import { STORE_KEY } from "../state.ts";
import { engineUnavailable } from "../texts.ts";
import { firewalld } from "./firewalld.ts";
import { iptables } from "./iptables.ts";
import { nftables } from "./nft.ts";
import type { Engine, EngineId, EngineStatus } from "./types.ts";

type ReadShell = ReadCtx["shell"];

export const ENGINES: Record<EngineId, Engine> = { firewalld, nftables, iptables };
export const SETTINGS = ["auto", "firewalld", "nftables", "iptables"] as const;
export type EngineSetting = (typeof SETTINGS)[number];

export const isEngineSetting = (name: string): name is EngineSetting => (SETTINGS as readonly string[]).includes(name);

/** The engines `auto` tries, in order; `pickEngine` hands them to the host's `strategy.pick`. */
function engineStrategies(shell: ReadShell) {
  return [
    { id: "firewalld", engine: firewalld, available: () => firewalldIsRunning(shell) },
    { id: "nftables", engine: nftables, available: () => shell.ok("nft", ["--version"]) },
    { id: "iptables", engine: iptables, available: () => shell.ok("iptables", ["--version"]) },
  ];
}

/** firewalld owns nft when its service is active, so it wins over a plain `nft`. */
async function firewalldIsRunning(shell: ReadShell): Promise<boolean> {
  const service = await shell.run("systemctl", ["is-active", "firewalld"]);
  return service.stdout.trim() === "active";
}

const NO_ENGINE_MESSAGE = "engine indisponível: nem firewalld ativo, nem nft, nem iptables neste host";

/** What picking an engine needs: the probes (`shell`) and the host's `strategy.pick`. A command and a read-only context both have them. */
export type PickDeps = Pick<ReadCtx, "shell" | "strategy">;

/** `auto`: firewalld when its service is active, else nftables when `nft` exists, else iptables. */
export async function pickEngine(deps: PickDeps, setting: EngineSetting = "auto"): Promise<{ engine: Engine; auto: boolean } | { error: string }> {
  const picked = await deps.strategy.pick(engineStrategies(deps.shell), { setting, none: NO_ENGINE_MESSAGE });
  if ("error" in picked) return picked;
  return { engine: picked.strategy.engine, auto: picked.auto };
}

/** The setting the technician chose with `firewall engine` (`auto` by default). */
export const engineSettingOf = (store: Pick<Store, "get">): EngineSetting => store.get<EngineSetting>(STORE_KEY.engine) ?? "auto";

export const zoneOf = (store: Pick<Store, "get">): string | undefined => store.get<string>(STORE_KEY.zone);

export interface ResolvedEngine {
  engine: Engine;
  /** Picked by detection, not by the setting. */
  auto: boolean;
  status: EngineStatus;
}

/** The engine to drive and its live status, or the user-facing reason it cannot be driven. */
export async function resolveEngine(deps: PickDeps & { store: Pick<Store, "get"> }): Promise<ResolvedEngine | { error: string }> {
  const picked = await pickEngine(deps, engineSettingOf(deps.store));
  if ("error" in picked) return picked;
  const status = await picked.engine.status({ shell: deps.shell, zone: zoneOf(deps.store) });
  if (!status.available) return { error: engineUnavailable(picked.engine.id, status.reason) };
  return { engine: picked.engine, auto: picked.auto, status };
}
