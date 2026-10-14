// firewalld: rich rules with priorities in one zone. firewalld owns nft, so nothing is written to nft beside it.
// The rules that are ours are told apart by their priority (a set no one else uses).
import { ok, shellQuote } from "../exec.ts";
import { makeBoot } from "../boot.ts";
import { available, canonicalAddress, restoreFromScript, unavailable } from "./common.ts";
import { renderRules, type RuleFormat } from "./rules.ts";
import type { Desired, Engine, EngineStatus, Io, ProbeIo } from "./types.ts";

export const DEFAULT_ZONE = "pvxfw";

/** A lower priority runs first. The failsafe and the icmp rule come before every list, and the ports after them. */
const PRIORITY = { failsafe: -2000, icmp: -1500, deny: -1000, trusted: -500, portDeny: 100, portAccept: 200 };
const OWNED_PRIORITIES = Object.values(PRIORITY).join("|");
/** A rich rule with one of our priorities: the way to tell our rules from anyone else's. */
const OWNED_RULE = new RegExp(`priority="(${OWNED_PRIORITIES})"`);
const OWNED_RULE_FOR_SH = `priority="(${OWNED_PRIORITIES})"`;

const sourceRule = (priority: number, ip: string, verdict: "accept" | "drop") =>
  `rule priority="${priority}" family="ipv4" source address="${canonicalAddress(ip)}" ${verdict}`;
const portRule = (priority: number, { proto, range }: { proto: string; range: string }, verdict: "accept" | "drop") =>
  `rule priority="${priority}" port port="${range}" protocol="${proto}" ${verdict}`;

// No established or loopback rules and no closing drop: the zone's DROP target and firewalld's own handling cover them.
const FORMAT: RuleFormat = {
  failsafe: (ip) => sourceRule(PRIORITY.failsafe, ip, "accept"),
  baseline: [`rule priority="${PRIORITY.icmp}" family="ipv4" protocol value="icmp" accept`],
  ipDeny: (ip) => sourceRule(PRIORITY.deny, ip, "drop"),
  ipAccept: (ip) => sourceRule(PRIORITY.trusted, ip, "accept"),
  portDeny: (match) => portRule(PRIORITY.portDeny, match, "drop"),
  portAccept: (match) => portRule(PRIORITY.portAccept, match, "accept"),
  closing: [],
};

export const rules = (desired: Desired): string[] => renderRules(desired, FORMAT);

const zoneOf = (io: ProbeIo) => io.zone ?? DEFAULT_ZONE;
const firewallCmd = (io: ProbeIo, args: string[]) => io.shell.run("firewall-cmd", args);
const mustFirewallCmd = (io: Io, args: string[]) => io.shell.must("firewall-cmd", args);
const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);

/** The rich rules of the zone that carry one of our priorities. */
async function listOwned(io: ProbeIo): Promise<string[]> {
  const listing = await firewallCmd(io, ["--permanent", `--zone=${zoneOf(io)}`, "--list-rich-rules"]);
  return ok(listing) ? lines(listing.stdout).filter((rule) => OWNED_RULE.test(rule)) : [];
}

/** Our own zone: created if missing, drop by default, and the default zone. */
async function prepareOwnZone(io: Io, zone: string): Promise<void> {
  const zones = await mustFirewallCmd(io, ["--permanent", "--get-zones"]);
  if (!zones.stdout.split(/\s+/).includes(zone)) {
    await mustFirewallCmd(io, ["--permanent", `--new-zone=${zone}`]);
    await mustFirewallCmd(io, ["--reload"]);
  }
  await mustFirewallCmd(io, ["--permanent", `--zone=${zone}`, "--set-target=DROP"]);
  await mustFirewallCmd(io, [`--set-default-zone=${zone}`]);
}

export const firewalld: Engine = {
  id: "firewalld",
  ...makeBoot("firewalld"),
  render: rules,
  failsafeRule: FORMAT.failsafe,
  restore: restoreFromScript,
  async status(io: ProbeIo): Promise<EngineStatus> {
    const service = await io.shell.run("systemctl", ["is-active", "firewalld"]);
    if (service.stdout.trim() !== "active") return unavailable("firewalld não está ativo");
    const version = await firewallCmd(io, ["--version"]);
    if (!ok(version)) return unavailable("firewall-cmd não encontrado");
    return available(await listOwned(io));
  },
  async apply(io, desired) {
    const zone = zoneOf(io);
    if (zone === DEFAULT_ZONE) await prepareOwnZone(io, zone);
    const wanted = rules(desired);
    const addRule = (rule: string) => mustFirewallCmd(io, ["--permanent", `--zone=${zone}`, `--add-rich-rule=${rule}`]);
    const removeRule = (rule: string) => mustFirewallCmd(io, ["--permanent", `--zone=${zone}`, `--remove-rich-rule=${rule}`]);

    // The failsafe goes in before anything is removed.
    const failsafe = desired.failsafe ? FORMAT.failsafe(desired.failsafe) : undefined;
    if (failsafe) await addRule(failsafe);
    const loaded = await listOwned(io);
    for (const rule of loaded) if (!wanted.includes(rule)) await removeRule(rule);
    for (const rule of wanted) if (!loaded.includes(rule) && rule !== failsafe) await addRule(rule);
    await mustFirewallCmd(io, ["--reload"]);
  },
  async snapshot(io) {
    const zone = zoneOf(io);
    const owned = await listOwned(io);
    const defaultZone = await firewallCmd(io, ["--get-default-zone"]);
    const restoresDefaultZone = zone === DEFAULT_ZONE && ok(defaultZone) && defaultZone.stdout.trim() !== "";
    return [
      "#!/bin/sh",
      `firewall-cmd --permanent --zone=${shellQuote(zone)} --list-rich-rules | grep -E ${shellQuote(OWNED_RULE_FOR_SH)} | while IFS= read -r rule; do firewall-cmd --permanent --zone=${shellQuote(zone)} --remove-rich-rule="$rule"; done`,
      ...owned.map((rule) => `firewall-cmd --permanent --zone=${shellQuote(zone)} --add-rich-rule=${shellQuote(rule)}`),
      ...(restoresDefaultZone ? [`firewall-cmd --set-default-zone=${shellQuote(defaultZone.stdout.trim())}`] : []),
      "firewall-cmd --reload",
      "",
    ].join("\n");
  },
};
