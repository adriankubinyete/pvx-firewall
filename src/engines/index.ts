import type { Store } from "@pvx/sdk";
import { run } from "../exec.ts";
import { STORE_KEY } from "../state.ts";
import { engineUnavailable } from "../texts.ts";
import { firewalld } from "./firewalld.ts";
import { iptables } from "./iptables.ts";
import { nftables } from "./nft.ts";
import type { Engine, EngineId, EngineStatus, ExecFn } from "./types.ts";

export const ENGINES: Record<EngineId, Engine> = { firewalld, nftables, iptables };
export const SETTINGS = ["auto", "firewalld", "nftables", "iptables"] as const;
export type EngineSetting = (typeof SETTINGS)[number];

export const isEngineSetting = (name: string): name is EngineSetting => (SETTINGS as readonly string[]).includes(name);

/** `auto`: firewalld when its service is active (it owns nft), else nftables when `nft` exists, else iptables. */
export async function pickEngine(exec: ExecFn, setting: EngineSetting = "auto"): Promise<{ engine: Engine; auto: boolean } | { error: string }> {
  if (setting !== "auto") return { engine: ENGINES[setting], auto: false };
  if ((await run(exec, "systemctl", ["is-active", "firewalld"])).stdout.trim() === "active") return { engine: firewalld, auto: true };
  if ((await run(exec, "nft", ["--version"])).code === 0) return { engine: nftables, auto: true };
  if ((await run(exec, "iptables", ["--version"])).code === 0) return { engine: iptables, auto: true };
  return { error: "engine indisponível: nem firewalld ativo, nem nft, nem iptables neste host" };
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
export async function resolveEngine(exec: ExecFn, store: Pick<Store, "get">): Promise<ResolvedEngine | { error: string }> {
  const picked = await pickEngine(exec, engineSettingOf(store));
  if ("error" in picked) return picked;
  const status = await picked.engine.status({ exec, zone: zoneOf(store) });
  if (!status.available) return { error: engineUnavailable(picked.engine.id, status.reason) };
  return { engine: picked.engine, auto: picked.auto, status };
}
