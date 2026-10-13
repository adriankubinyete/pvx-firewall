// firewalld: rich rules with priorities in one zone. firewalld owns nft, so nothing is written to nft beside it.
// The rules that are ours are told apart by their priority (a set no one else uses).
import { expandPort, normCidr } from "../net.ts";
import { fail, ok, run, sq } from "../exec.ts";
import { makeBoot } from "../boot.ts";
import type { Desired, Engine, EngineStatus, Io } from "./types.ts";

export const DEFAULT_ZONE = "pvxfw";
const P = { failsafe: -2000, icmp: -1500, deny: -1000, trusted: -500, portDeny: 100, portAccept: 200 };
const OWNED = new RegExp(`priority="(${Object.values(P).join("|")})"`);
const OWNED_SH = `priority="(${Object.values(P).join("|")})"`;

const ip = (v: string) => normCidr(v) ?? v;

export const rules = (d: Desired): string[] => [
  ...(d.failsafe ? [`rule priority="${P.failsafe}" family="ipv4" source address="${ip(d.failsafe)}" accept`] : []),
  `rule priority="${P.icmp}" family="ipv4" protocol value="icmp" accept`,
  ...d.ipDeny.map((v) => `rule priority="${P.deny}" family="ipv4" source address="${ip(v)}" drop`),
  ...d.ipAccept.map((v) => `rule priority="${P.trusted}" family="ipv4" source address="${ip(v)}" accept`),
  ...d.portDeny.flatMap((p) => expandPort(p).map((x) => `rule priority="${P.portDeny}" port port="${x.range}" protocol="${x.proto}" drop`)),
  ...d.portAccept.flatMap((p) => expandPort(p).map((x) => `rule priority="${P.portAccept}" port port="${x.range}" protocol="${x.proto}" accept`)),
];

const fc = (io: Io, args: string[]) => run(io.exec, "firewall-cmd", args);
const zoneOf = (io: Io) => io.zone ?? DEFAULT_ZONE;
const need = async (io: Io, args: string[]) => {
  const r = await fc(io, args);
  if (!ok(r)) throw fail(`firewall-cmd ${args.join(" ")}`, r);
  return r;
};
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

const listOwned = async (io: Io) => {
  const r = await fc(io, ["--permanent", `--zone=${zoneOf(io)}`, "--list-rich-rules"]);
  return ok(r) ? lines(r.stdout).filter((l) => OWNED.test(l)) : [];
};

export const firewalld: Engine = {
  id: "firewalld",
  ...makeBoot("firewalld"),
  render: rules,
  async status(io: Io): Promise<EngineStatus> {
    const a = await run(io.exec, "systemctl", ["is-active", "firewalld"]);
    if (a.stdout.trim() !== "active") return { available: false, reason: "firewalld não está ativo", active: false, rules: [] };
    const v = await fc(io, ["--version"]);
    if (!ok(v)) return { available: false, reason: "firewall-cmd não encontrado", active: false, rules: [] };
    const rs = await listOwned(io);
    return { available: true, active: rs.length > 0, rules: rs };
  },
  async apply(io, d) {
    const z = zoneOf(io);
    if (z === DEFAULT_ZONE) {
      // Our own zone: created if missing, drop by default, and the default zone.
      const zones = await need(io, ["--permanent", "--get-zones"]);
      if (!zones.stdout.split(/\s+/).includes(z)) {
        await need(io, ["--permanent", `--new-zone=${z}`]);
        await need(io, ["--reload"]);
      }
      await need(io, ["--permanent", `--zone=${z}`, "--set-target=DROP"]);
      await need(io, [`--set-default-zone=${z}`]);
    }
    const want = rules(d);
    const add = (r: string) => need(io, ["--permanent", `--zone=${z}`, `--add-rich-rule=${r}`]);
    // The failsafe goes in before anything is removed.
    if (d.failsafe) await add(want[0]!);
    const cur = await listOwned(io);
    for (const r of cur) if (!want.includes(r)) await need(io, ["--permanent", `--zone=${z}`, `--remove-rich-rule=${r}`]);
    for (const r of want) if (!cur.includes(r) && !(d.failsafe && r === want[0])) await add(r);
    await need(io, ["--reload"]);
  },
  async snapshot(io) {
    const z = zoneOf(io);
    const cur = await listOwned(io);
    const def = await fc(io, ["--get-default-zone"]);
    return [
      "#!/bin/sh",
      `firewall-cmd --permanent --zone=${sq(z)} --list-rich-rules | grep -E ${sq(OWNED_SH)} | while IFS= read -r r; do firewall-cmd --permanent --zone=${sq(z)} --remove-rich-rule="$r"; done`,
      ...cur.map((r) => `firewall-cmd --permanent --zone=${sq(z)} --add-rich-rule=${sq(r)}`),
      ...(z === DEFAULT_ZONE && ok(def) && def.stdout.trim() ? [`firewall-cmd --set-default-zone=${sq(def.stdout.trim())}`] : []),
      "firewall-cmd --reload",
      "",
    ].join("\n");
  },
  async restore(io, path) {
    const r = await run(io.exec, "sh", [path]);
    if (!ok(r)) throw fail("restore", r);
  },
};
