import { run } from "../exec.ts";
import { firewalld } from "./firewalld.ts";
import { iptables } from "./iptables.ts";
import { nftables } from "./nft.ts";
import type { Engine, EngineId, ExecFn } from "./types.ts";

export const ENGINES: Record<EngineId, Engine> = { firewalld, nftables, iptables };
export const SETTINGS = ["auto", "firewalld", "nftables", "iptables"] as const;
export type EngineSetting = (typeof SETTINGS)[number];

/** `auto`: firewalld when its service is active (it owns nft), else nftables when `nft` exists, else iptables. */
export async function pickEngine(exec: ExecFn, setting: EngineSetting = "auto"): Promise<{ engine: Engine; auto: boolean } | { error: string }> {
  if (setting !== "auto") return { engine: ENGINES[setting], auto: false };
  if ((await run(exec, "systemctl", ["is-active", "firewalld"])).stdout.trim() === "active") return { engine: firewalld, auto: true };
  if ((await run(exec, "nft", ["--version"])).code === 0) return { engine: nftables, auto: true };
  if ((await run(exec, "iptables", ["--version"])).code === 0) return { engine: iptables, auto: true };
  return { error: "engine indisponível: nem firewalld ativo, nem nft, nem iptables neste host" };
}
