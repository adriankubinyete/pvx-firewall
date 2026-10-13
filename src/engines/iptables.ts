// iptables: one chain of our own (PVX_INPUT) jumped to from INPUT, refilled in a single iptables-restore --noflush.
// The rest of INPUT (fail2ban, docker...) is left alone.
import { expandPort, normCidr } from "../net.ts";
import { fail, ok, run } from "../exec.ts";
import { makeBoot } from "../boot.ts";
import type { Desired, Engine, EngineStatus, Io } from "./types.ts";

export const CHAIN = "PVX_INPUT";
const src = (v: string) => `${normCidr(v) ?? v}${(normCidr(v) ?? v).includes("/") ? "" : "/32"}`;
const A = `-A ${CHAIN}`;

/** Canonical `iptables-save` form, one rule per line. */
export const rules = (d: Desired): string[] => [
  ...(d.failsafe ? [`${A} -s ${src(d.failsafe)} -j ACCEPT`] : []),
  `${A} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
  `${A} -i lo -j ACCEPT`,
  `${A} -p icmp -j ACCEPT`,
  ...d.ipDeny.map((v) => `${A} -s ${src(v)} -j DROP`),
  ...d.ipAccept.map((v) => `${A} -s ${src(v)} -j ACCEPT`),
  ...d.portDeny.flatMap((p) => expandPort(p).map((x) => `${A} -p ${x.proto} -m ${x.proto} --dport ${x.range.replace("-", ":")} -j DROP`)),
  ...d.portAccept.flatMap((p) => expandPort(p).map((x) => `${A} -p ${x.proto} -m ${x.proto} --dport ${x.range.replace("-", ":")} -j ACCEPT`)),
  `${A} -j DROP`,
];

/** The `iptables-restore --noflush` input. `-F` empties the chain inside the same transaction. */
export const script = (d: Desired): string => ["*filter", `:${CHAIN} - [0:0]`, `-F ${CHAIN}`, ...rules(d), "COMMIT", ""].join("\n");

export const parseListing = (out: string): string[] => out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith(`${A} `));

export const iptables: Engine = {
  id: "iptables",
  ...makeBoot("iptables"),
  render: rules,
  async status(io: Pick<Io, "exec" | "zone">): Promise<EngineStatus> {
    const v = await run(io.exec, "iptables", ["--version"]);
    if (!ok(v)) return { available: false, reason: "iptables não encontrado", active: false, rules: [] };
    const s = await run(io.exec, "iptables-save", ["-t", "filter"]);
    if (!ok(s)) return { available: false, reason: "iptables-save falhou", active: false, rules: [] };
    const rs = parseListing(s.stdout);
    return { available: true, active: rs.length > 0 && s.stdout.includes(`-A INPUT -j ${CHAIN}`), rules: rs };
  },
  async apply(io, d) {
    await run(io.exec, "iptables", ["-N", CHAIN]); // exists already: fine
    const c = await run(io.exec, "iptables", ["-C", "INPUT", "-j", CHAIN]);
    if (!ok(c)) {
      const i = await run(io.exec, "iptables", ["-I", "INPUT", "1", "-j", CHAIN]);
      if (!ok(i)) throw fail("iptables -I INPUT", i);
    }
    const r = await run(io.exec, "iptables-restore", ["--noflush"], { stdin: script(d) });
    if (!ok(r)) throw fail("iptables-restore", r);
  },
  async snapshot(io) {
    const s = await run(io.exec, "iptables-save", ["-t", "filter"]);
    if (!ok(s)) throw fail("iptables-save", s);
    return `#!/bin/sh\niptables-restore <<'PVX_EOF'\n${s.stdout.trim()}\nPVX_EOF\n`;
  },
  async restore(io, path) {
    const r = await run(io.exec, "sh", [path]);
    if (!ok(r)) throw fail("restore", r);
  },
};
