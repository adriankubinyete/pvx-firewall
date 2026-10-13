// nftables: one table of our own (`ip pvx`), IPv4 only, replaced in a single transaction.
// Other tables (docker, fail2ban...) are never touched.
import { expandPort, normCidr } from "../net.ts";
import { fail, ok, run } from "../exec.ts";
import { makeBoot } from "../boot.ts";
import type { Desired, Engine, EngineStatus, Io } from "./types.ts";

const ip = (v: string) => normCidr(v) ?? v;

export const rules = (d: Desired): string[] => [
  ...(d.failsafe ? [`ip saddr ${ip(d.failsafe)} accept`] : []),
  "ct state established,related accept",
  'iifname "lo" accept',
  "ip protocol icmp accept",
  ...d.ipDeny.map((v) => `ip saddr ${ip(v)} drop`),
  ...d.ipAccept.map((v) => `ip saddr ${ip(v)} accept`),
  ...d.portDeny.flatMap((p) => expandPort(p).map((x) => `${x.proto} dport ${x.range} drop`)),
  ...d.portAccept.flatMap((p) => expandPort(p).map((x) => `${x.proto} dport ${x.range} accept`)),
  "drop",
];

/** The transaction: `add` + `delete` makes the replace work whether or not the table exists. */
export const script = (d: Desired): string =>
  ["add table ip pvx", "delete table ip pvx", "table ip pvx {", "  chain input {", "    type filter hook input priority -10; policy accept;", ...rules(d).map((r) => `    ${r}`), "  }", "}", ""].join("\n");

/** Rules inside `chain input` of an `nft list table` output. */
export const parseListing = (out: string): string[] => {
  const lines = out.split("\n").map((l) => l.trim());
  const start = lines.findIndex((l) => l.startsWith("chain input"));
  if (start < 0) return [];
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l === "}") break;
    if (l && !l.startsWith("type ")) body.push(l);
  }
  return body;
};

export const nftables: Engine = {
  id: "nftables",
  ...makeBoot("nftables"),
  render: rules,
  async status(io: Pick<Io, "exec" | "zone">): Promise<EngineStatus> {
    const v = await run(io.exec, "nft", ["--version"]);
    if (!ok(v)) return { available: false, reason: "nft não encontrado", active: false, rules: [] };
    const l = await run(io.exec, "nft", ["list", "table", "ip", "pvx"]);
    const rs = ok(l) ? parseListing(l.stdout) : [];
    return { available: true, active: rs.length > 0, rules: rs };
  },
  async apply(io, d) {
    const r = await run(io.exec, "nft", ["-f", "-"], { stdin: script(d) });
    if (!ok(r)) throw fail("nft -f", r);
  },
  async snapshot(io) {
    const l = await run(io.exec, "nft", ["list", "table", "ip", "pvx"]);
    if (!ok(l)) return "#!/bin/sh\nnft delete table ip pvx 2>/dev/null || true\n"; // there was no table: undo means removing ours
    return `#!/bin/sh\nnft -f - <<'PVX_EOF'\nadd table ip pvx\ndelete table ip pvx\n${l.stdout.trim()}\nPVX_EOF\n`;
  },
  async restore(io, path) {
    const r = await run(io.exec, "sh", [path]);
    if (!ok(r)) throw fail("restore", r);
  },
};
