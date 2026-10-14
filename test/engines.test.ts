import { expect, test } from "bun:test";
import { firewalld, rules as fdRules } from "../src/engines/firewalld.ts";
import { iptables, script as ipScript } from "../src/engines/iptables.ts";
import { nftables, script as nftScript } from "../src/engines/nft.ts";
import { ENGINES, pickEngine } from "../src/engines/index.ts";
import { renderRules, type RuleFormat } from "../src/engines/rules.ts";
import { fakeExec, fakeFs, io, line, sample } from "./fake.ts";

test("nftables: golden transaction", () => {
  expect(nftScript(sample)).toBe(`add table ip pvx
delete table ip pvx
table ip pvx {
  chain input {
    type filter hook input priority -10; policy accept;
    ip saddr 203.0.113.7 accept
    ct state established,related accept
    iifname "lo" accept
    ip protocol icmp accept
    ip saddr 198.51.100.0/24 drop
    ip saddr 127.0.0.1 accept
    ip saddr 10.0.0.0/8 accept
    ip saddr 203.0.113.9 accept
    tcp dport 80 drop
    tcp dport 20-23 drop
    udp dport 20-23 drop
    udp dport 5060 accept
    udp dport 10000-20000 accept
    drop
  }
}
`);
});

test("iptables: golden iptables-restore input", () => {
  expect(ipScript(sample)).toBe(`*filter
:PVX_INPUT - [0:0]
-F PVX_INPUT
-A PVX_INPUT -s 203.0.113.7/32 -j ACCEPT
-A PVX_INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A PVX_INPUT -i lo -j ACCEPT
-A PVX_INPUT -p icmp -j ACCEPT
-A PVX_INPUT -s 198.51.100.0/24 -j DROP
-A PVX_INPUT -s 127.0.0.1/32 -j ACCEPT
-A PVX_INPUT -s 10.0.0.0/8 -j ACCEPT
-A PVX_INPUT -s 203.0.113.9/32 -j ACCEPT
-A PVX_INPUT -p tcp -m tcp --dport 80 -j DROP
-A PVX_INPUT -p tcp -m tcp --dport 20:23 -j DROP
-A PVX_INPUT -p udp -m udp --dport 20:23 -j DROP
-A PVX_INPUT -p udp -m udp --dport 5060 -j ACCEPT
-A PVX_INPUT -p udp -m udp --dport 10000:20000 -j ACCEPT
-A PVX_INPUT -j DROP
COMMIT
`);
});

test("firewalld: golden rich rules (failsafe first, deny before accept, ports last)", () => {
  expect(fdRules(sample)).toEqual([
    'rule priority="-2000" family="ipv4" source address="203.0.113.7" accept',
    'rule priority="-1500" family="ipv4" protocol value="icmp" accept',
    'rule priority="-1000" family="ipv4" source address="198.51.100.0/24" drop',
    'rule priority="-500" family="ipv4" source address="127.0.0.1" accept',
    'rule priority="-500" family="ipv4" source address="10.0.0.0/8" accept',
    'rule priority="-500" family="ipv4" source address="203.0.113.9" accept',
    'rule priority="100" port port="80" protocol="tcp" drop',
    'rule priority="100" port port="20-23" protocol="tcp" drop',
    'rule priority="100" port port="20-23" protocol="udp" drop',
    'rule priority="200" port port="5060" protocol="udp" accept',
    'rule priority="200" port port="10000-20000" protocol="udp" accept',
  ]);
});

test("nftables apply: one nft -f - with the table text; nothing else", async () => {
  const { exec, calls } = fakeExec();
  await nftables.apply(io(exec), sample);
  expect(calls).toHaveLength(1);
  expect(line(calls[0]!)).toBe("nft -f -");
  expect(calls[0]!.stdin).toBe(nftScript(sample));
});

test("nftables apply: a failure throws with nft's message", async () => {
  const { exec } = fakeExec(() => ({ code: 1, stderr: "syntax error" }));
  await expect(nftables.apply(io(exec), sample)).rejects.toThrow("syntax error");
});

test("nftables snapshot: existing table is restored, absent table is deleted", async () => {
  const had = fakeExec((c) => (c.args[0] === "list" ? { stdout: "table ip pvx {\n  chain input {\n  }\n}\n" } : undefined));
  const s1 = await nftables.snapshot(io(had.exec));
  expect(s1).toContain("delete table ip pvx\ntable ip pvx {");
  const none = fakeExec((c) => (c.args[0] === "list" ? { code: 1 } : undefined));
  expect(await nftables.snapshot(io(none.exec))).toBe("#!/bin/sh\nnft delete table ip pvx 2>/dev/null || true\n");
});

test("nftables status reads the rules out of `nft list table`", async () => {
  const listing = `table ip pvx {\n\tchain input {\n\t\ttype filter hook input priority -10; policy accept;\n\t\tip saddr 203.0.113.7 accept\n\t\tdrop\n\t}\n}\n`;
  const { exec } = fakeExec((c) => (c.args[0] === "list" ? { stdout: listing } : { stdout: "nftables v1" }));
  expect(await nftables.status(io(exec))).toEqual({ available: true, active: true, rules: ["ip saddr 203.0.113.7 accept", "drop"] });
});

test("iptables apply: own chain, jump only when missing, one atomic restore --noflush", async () => {
  const { exec, calls } = fakeExec((c) => (c.args[0] === "-C" ? { code: 1 } : undefined));
  await iptables.apply(io(exec), sample);
  expect(calls.map(line)).toEqual(["iptables -N PVX_INPUT", "iptables -C INPUT -j PVX_INPUT", "iptables -I INPUT 1 -j PVX_INPUT", "iptables-restore --noflush"]);
  expect(calls[3]!.stdin).toBe(ipScript(sample));
});

test("iptables apply: the jump already there is not inserted again", async () => {
  const { exec, calls } = fakeExec();
  await iptables.apply(io(exec), sample);
  expect(calls.map(line)).not.toContain("iptables -I INPUT 1 -j PVX_INPUT");
});

test("iptables never flushes INPUT or deletes foreign rules", async () => {
  const { exec, calls } = fakeExec();
  await iptables.apply(io(exec), sample);
  const all = calls.map((c) => line(c) + (c.stdin ?? "")).join("\n");
  expect(all).not.toMatch(/-F INPUT|-D INPUT|iptables -F|-P INPUT/);
});

test("iptables snapshot is a restore script of the filter table", async () => {
  const { exec } = fakeExec(() => ({ stdout: "*filter\n:INPUT ACCEPT [0:0]\nCOMMIT\n" }));
  expect(await iptables.snapshot(io(exec))).toBe("#!/bin/sh\niptables-restore <<'PVX_EOF'\n*filter\n:INPUT ACCEPT [0:0]\nCOMMIT\nPVX_EOF\n");
});

test("firewalld apply: own zone, failsafe added first, only the diff is touched, one reload", async () => {
  const stale = 'rule priority="-500" family="ipv4" source address="9.9.9.9" accept';
  const foreign = 'rule family="ipv4" source address="8.8.8.8" accept'; // no pvx priority: someone else's
  const { exec, calls } = fakeExec((c) => {
    if (c.args.includes("--get-zones")) return { stdout: "public pvxfw" };
    if (c.args.includes("--list-rich-rules")) return { stdout: `${stale}\n${foreign}\n${fdRules(sample)[1]}\n` };
  });
  await firewalld.apply(io(exec), sample);
  const l = calls.map(line);
  expect(l.slice(0, 3)).toEqual(["firewall-cmd --permanent --get-zones", "firewall-cmd --permanent --zone=pvxfw --set-target=DROP", "firewall-cmd --set-default-zone=pvxfw"]);
  expect(l[3]).toBe(`firewall-cmd --permanent --zone=pvxfw --add-rich-rule=${fdRules(sample)[0]}`); // failsafe before any removal
  const removes = l.filter((x) => x.includes("--remove-rich-rule"));
  expect(removes).toEqual([`firewall-cmd --permanent --zone=pvxfw --remove-rich-rule=${stale}`]); // the foreign rule survives
  expect(l.filter((x) => x.includes("--add-rich-rule"))).toHaveLength(fdRules(sample).length - 1); // every rule but the one already loaded, the failsafe once
  expect(l.filter((x) => x === "firewall-cmd --reload")).toHaveLength(1);
});

test("firewalld creates the zone when missing", async () => {
  const { exec, calls } = fakeExec((c) => (c.args.includes("--get-zones") ? { stdout: "public" } : undefined));
  await firewalld.apply(io(exec), sample);
  expect(calls.map(line).slice(0, 3)).toEqual(["firewall-cmd --permanent --get-zones", "firewall-cmd --permanent --new-zone=pvxfw", "firewall-cmd --reload"]);
});

test("firewalld on a foreign zone does not touch the target or the default zone", async () => {
  const { exec, calls } = fakeExec();
  await firewalld.apply(io(exec, fakeFs(), "public"), sample);
  expect(calls.map(line).join("\n")).not.toMatch(/set-target|set-default-zone|new-zone/);
});

test("firewalld snapshot: removes our rules, re-adds the saved ones, restores the default zone", async () => {
  const saved = fdRules(sample)[1]!;
  const { exec } = fakeExec((c) => (c.args.includes("--list-rich-rules") ? { stdout: `${saved}\n` } : c.args.includes("--get-default-zone") ? { stdout: "public\n" } : undefined));
  const s = await firewalld.snapshot(io(exec));
  expect(s).toContain(`--add-rich-rule='${saved}'`);
  expect(s).toContain("--set-default-zone='public'");
  expect(s).toContain("--remove-rich-rule=");
  expect(s.trim().endsWith("firewall-cmd --reload")).toBe(true);
});

test("firewalld status: unavailable when the service is not active", async () => {
  const { exec } = fakeExec(() => ({ stdout: "inactive" }));
  expect((await firewalld.status(io(exec))).available).toBe(false);
});

test("auto picks firewalld when active, else nftables when nft exists, else iptables, else an error", async () => {
  const pick = async (have: string[], fw = false) => {
    const { exec } = fakeExec((c) => (c.cmd === "systemctl" ? { stdout: fw ? "active" : "inactive" } : have.includes(c.cmd) ? undefined : { code: 127 }));
    const r = await pickEngine(exec, "auto");
    return "engine" in r ? r.engine.id : "error";
  };
  expect(await pick(["nft", "iptables"], true)).toBe("firewalld"); // firewalld owns nft: never write nft beside it
  expect(await pick(["nft", "iptables"])).toBe("nftables");
  expect(await pick(["iptables"])).toBe("iptables");
  expect(await pick([])).toBe("error");
});

test("an explicit engine setting wins over detection", async () => {
  const { exec } = fakeExec((c) => (c.cmd === "systemctl" ? { stdout: "active" } : undefined));
  const r = await pickEngine(exec, "iptables");
  expect("engine" in r && r.engine.id).toBe("iptables");
});

// The order of the rules is the safety contract; it lives in rules.ts, so one fake format is enough to pin it for all three engines.
test("rule order: failsafe, baseline, denied IPs, accepted IPs, denied ports, accepted ports, closing", () => {
  const format: RuleFormat = {
    failsafe: (ip) => `failsafe ${ip}`,
    baseline: ["baseline"],
    ipDeny: (ip) => `ip-deny ${ip}`,
    ipAccept: (ip) => `ip-accept ${ip}`,
    portDeny: ({ proto, range }) => `port-deny ${proto} ${range}`,
    portAccept: ({ proto, range }) => `port-accept ${proto} ${range}`,
    closing: ["closing"],
  };
  const rules = renderRules({ ipAccept: ["1.1.1.1"], ipDeny: ["2.2.2.2"], portAccept: ["53/udp"], portDeny: ["80/tcp"], failsafe: "9.9.9.9" }, format);
  expect(rules).toEqual(["failsafe 9.9.9.9", "baseline", "ip-deny 2.2.2.2", "ip-accept 1.1.1.1", "port-deny tcp 80", "port-accept udp 53", "closing"]);
  expect(renderRules({ ipAccept: [], ipDeny: [], portAccept: [], portDeny: [] }, format)).toEqual(["baseline", "closing"]); // no session, no failsafe
});

test("failsafeRule is the first rendered rule of every engine, and none is rendered without a session", () => {
  const empty = { ipAccept: [], ipDeny: [], portAccept: [], portDeny: [] };
  for (const engine of Object.values(ENGINES)) {
    expect(engine.render({ ...empty, failsafe: "203.0.113.7" })[0]).toBe(engine.failsafeRule("203.0.113.7"));
    expect(engine.render(empty)).not.toContain(engine.failsafeRule("203.0.113.7"));
  }
});
