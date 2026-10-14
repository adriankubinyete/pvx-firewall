// nftables: one table of our own (`ip pvx`), IPv4 only, replaced in a single transaction.
// Other tables (docker, fail2ban...) are never touched.
import { ok, run, runOrFail } from "../exec.ts";
import { makeBoot } from "../boot.ts";
import { available, canonicalAddress, restoreFromScript, unavailable } from "./common.ts";
import { renderRules, type RuleFormat } from "./rules.ts";
import type { Desired, Engine, EngineStatus, ProbeIo } from "./types.ts";

const FORMAT: RuleFormat = {
  failsafe: (ip) => `ip saddr ${canonicalAddress(ip)} accept`,
  baseline: ["ct state established,related accept", 'iifname "lo" accept', "ip protocol icmp accept"],
  ipDeny: (ip) => `ip saddr ${canonicalAddress(ip)} drop`,
  ipAccept: (ip) => `ip saddr ${canonicalAddress(ip)} accept`,
  portDeny: ({ proto, range }) => `${proto} dport ${range} drop`,
  portAccept: ({ proto, range }) => `${proto} dport ${range} accept`,
  closing: ["drop"],
};

export const rules = (desired: Desired): string[] => renderRules(desired, FORMAT);

/** The transaction: `add` + `delete` makes the replace work whether or not the table exists. */
export const script = (desired: Desired): string =>
  [
    "add table ip pvx",
    "delete table ip pvx",
    "table ip pvx {",
    "  chain input {",
    "    type filter hook input priority -10; policy accept;",
    ...rules(desired).map((rule) => `    ${rule}`),
    "  }",
    "}",
    "",
  ].join("\n");

/** Rules inside `chain input` of an `nft list table` output. */
export const parseListing = (output: string): string[] => {
  const lines = output.split("\n").map((line) => line.trim());
  const chainStart = lines.findIndex((line) => line.startsWith("chain input"));
  if (chainStart < 0) return [];
  const chainRules: string[] = [];
  for (const line of lines.slice(chainStart + 1)) {
    if (line === "}") break;
    if (line && !line.startsWith("type ")) chainRules.push(line);
  }
  return chainRules;
};

const listOurTable = (exec: ProbeIo["exec"]) => run(exec, "nft", ["list", "table", "ip", "pvx"]);

export const nftables: Engine = {
  id: "nftables",
  ...makeBoot("nftables"),
  render: rules,
  failsafeRule: FORMAT.failsafe,
  restore: restoreFromScript,
  async status(io: ProbeIo): Promise<EngineStatus> {
    const version = await run(io.exec, "nft", ["--version"]);
    if (!ok(version)) return unavailable("nft não encontrado");
    const listing = await listOurTable(io.exec);
    return available(ok(listing) ? parseListing(listing.stdout) : []);
  },
  async apply(io, desired) {
    await runOrFail(io.exec, "nft", ["-f", "-"], "nft -f", { stdin: script(desired) });
  },
  async snapshot(io) {
    const listing = await listOurTable(io.exec);
    // There was no table: undoing means removing ours.
    if (!ok(listing)) return "#!/bin/sh\nnft delete table ip pvx 2>/dev/null || true\n";
    return `#!/bin/sh\nnft -f - <<'PVX_EOF'\nadd table ip pvx\ndelete table ip pvx\n${listing.stdout.trim()}\nPVX_EOF\n`;
  },
};
