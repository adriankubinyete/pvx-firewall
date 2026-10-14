// iptables: one chain of our own (PVX_INPUT) jumped to from INPUT, refilled in a single iptables-restore --noflush.
// The rest of INPUT (fail2ban, docker...) is left alone.
import { ok } from "../exec.ts";
import { makeBoot } from "../boot.ts";
import { available, canonicalAddress, restoreFromScript, unavailable } from "./common.ts";
import { renderRules, type RuleFormat } from "./rules.ts";
import type { Desired, Engine, EngineStatus, ProbeIo } from "./types.ts";

export const CHAIN = "PVX_INPUT";
const APPEND = `-A ${CHAIN}`;

/** `iptables-save` always writes a source as `a.b.c.d/len`. */
const source = (value: string): string => {
  const address = canonicalAddress(value);
  return address.includes("/") ? address : `${address}/32`;
};

/** iptables writes a port range with a colon. */
const dport = ({ proto, range }: { proto: string; range: string }) => `-p ${proto} -m ${proto} --dport ${range.replace("-", ":")}`;

/** Canonical `iptables-save` form, one rule per line. */
const FORMAT: RuleFormat = {
  failsafe: (ip) => `${APPEND} -s ${source(ip)} -j ACCEPT`,
  baseline: [`${APPEND} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`, `${APPEND} -i lo -j ACCEPT`, `${APPEND} -p icmp -j ACCEPT`],
  ipDeny: (ip) => `${APPEND} -s ${source(ip)} -j DROP`,
  ipAccept: (ip) => `${APPEND} -s ${source(ip)} -j ACCEPT`,
  portDeny: (match) => `${APPEND} ${dport(match)} -j DROP`,
  portAccept: (match) => `${APPEND} ${dport(match)} -j ACCEPT`,
  closing: [`${APPEND} -j DROP`],
};

export const rules = (desired: Desired): string[] => renderRules(desired, FORMAT);

/** The `iptables-restore --noflush` input. `-F` empties the chain inside the same transaction. */
export const script = (desired: Desired): string => ["*filter", `:${CHAIN} - [0:0]`, `-F ${CHAIN}`, ...rules(desired), "COMMIT", ""].join("\n");

export const parseListing = (output: string): string[] => output.split("\n").map((line) => line.trim()).filter((line) => line.startsWith(`${APPEND} `));

export const iptables: Engine = {
  id: "iptables",
  ...makeBoot("iptables"),
  render: rules,
  failsafeRule: FORMAT.failsafe,
  restore: restoreFromScript,
  async status(io: ProbeIo): Promise<EngineStatus> {
    const version = await io.shell.run("iptables", ["--version"]);
    if (!ok(version)) return unavailable("iptables não encontrado");
    const saved = await io.shell.run("iptables-save", ["-t", "filter"]);
    if (!ok(saved)) return unavailable("iptables-save falhou");
    const ourRules = parseListing(saved.stdout);
    const jumpsToOurChain = saved.stdout.includes(`-A INPUT -j ${CHAIN}`);
    return available(ourRules, ourRules.length > 0 && jumpsToOurChain);
  },
  async apply(io, desired) {
    await io.shell.run("iptables", ["-N", CHAIN]); // exists already: fine
    const alreadyJumps = await io.shell.ok("iptables", ["-C", "INPUT", "-j", CHAIN]);
    if (!alreadyJumps) await io.shell.must("iptables", ["-I", "INPUT", "1", "-j", CHAIN]);
    await io.shell.must("iptables-restore", ["--noflush"], { stdin: script(desired) });
  },
  async snapshot(io) {
    const saved = await io.shell.must("iptables-save", ["-t", "filter"]);
    return `#!/bin/sh\niptables-restore <<'PVX_EOF'\n${saved.stdout.trim()}\nPVX_EOF\n`;
  },
};
