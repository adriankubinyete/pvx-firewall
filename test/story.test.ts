import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSession } from "@pvx/testing";
import { SSH_CLIENT_IP, installStubs, withSshSession, type Stubs } from "./stubs.ts";

const dir = join(import.meta.dir, "..");

withSshSession();

let stubs: Stubs;
const setup = (programs: string[]) => {
  stubs?.restore();
  stubs = installStubs(programs);
};
beforeEach(() => setup(["nft", "systemctl", "systemd-run", "who", "asterisk"]));
afterEach(() => stubs.restore());

test("status with no engine on the host: a clean error, exit 1, nothing run", async () => {
  setup([]);
  const s = await runSession(dir);
  const r = await s.run("firewall status");
  expect(r.exit).toBe(1);
  expect(r.text).toContain("engine indisponível");
  expect(stubs.calls()).toEqual([]);
});

test("ip accept validates, dedupes, and keeps the 13 seeded base IPs (regression: the Python module lost them)", async () => {
  const s = await runSession(dir);
  expect((await s.run("firewall ip accept 300.1.1.1")).exit).toBe(1);
  expect((await s.run("firewall ip accept 203.0.113.9,203.0.113.10 --comment fulano")).ok).toBe(true);
  expect((await s.run("firewall ip accept 203.0.113.9")).text).toContain("já estava");
  const t = (await s.run("firewall ip list")).text;
  expect(t).toContain("IPs aceitos (15)");
  expect(t).toContain("fulano");
  expect(t).toContain("189.124.85.75");
  expect(t).toContain("[manual]");
});

test("ip deny refuses the current SSH IP and any range that holds it", async () => {
  const s = await runSession(dir);
  for (const v of [SSH_CLIENT_IP, "203.0.113.0/24", "0.0.0.0/0"]) {
    const r = await s.run(`firewall ip deny ${v}`);
    expect(r.exit).toBe(1);
    expect(r.text).toContain("IP da sua sessão");
  }
  expect((await s.run("firewall ip deny 198.51.100.0/24 --comment scanner")).ok).toBe(true);
  expect((await s.run("firewall ip list")).text).toContain("IPs bloqueados (1)");
});

test("ip deny without SSH_CLIENT falls back to who -m", async () => {
  delete process.env.SSH_CLIENT;
  const s = await runSession(dir);
  expect((await s.run("firewall ip deny 198.51.100.0/24")).ok).toBe(true);
  expect(stubs.calls()).toContain("who -m");
});

test("remove, trust-phonevox puts the base IPs back", async () => {
  const s = await runSession(dir);
  expect((await s.run("firewall ip remove 186.233.122.92")).ok).toBe(true);
  expect((await s.run("firewall ip remove 186.233.122.92")).text).toContain("não estava");
  expect((await s.run("firewall ip trust-phonevox")).text).toContain("186.233.122.92");
  expect((await s.run("firewall ip trust-phonevox")).text).toContain("já estão cobertos");
});

test("ports: validation, comment, remove from either list", async () => {
  const s = await runSession(dir);
  expect((await s.run("firewall port accept 99999")).exit).toBe(1);
  expect((await s.run("firewall port accept 8080/tcp --comment painel")).ok).toBe(true);
  expect((await s.run("firewall port list")).text).toContain("8080/tcp");
  expect((await s.run("firewall port remove 8080/tcp")).ok).toBe(true);
  expect((await s.run("firewall port list")).text).not.toContain("8080/tcp");
});

test("apply is destructive: without --yes it is refused (exit 2) and nothing runs", async () => {
  const s = await runSession(dir);
  const r = await s.run("firewall apply");
  expect(r.exit).toBe(2);
  expect(stubs.calls().filter((c) => c.startsWith("nft -f"))).toEqual([]);
});

test("apply: failsafe first, revert scheduled before the load, confirm disarms; status says ATIVO", async () => {
  const s = await runSession(dir);
  const r = await s.run("firewall apply", { confirmed: true });
  expect(r.exit).toBe(0);
  expect(r.text).toContain("failsafe 203.0.113.7");
  expect(r.text).toContain("firewall confirm");
  const calls = stubs.calls();
  const sched = calls.findIndex((c) => c.startsWith("systemd-run --on-active=60"));
  const load = calls.findIndex((c) => c === "nft -f -");
  expect(sched).toBeGreaterThan(-1);
  expect(sched).toBeLessThan(load);
  expect(stubs.loaded()).toContain("ip saddr 203.0.113.7 accept\n    ct state established,related accept");
  expect((await s.run("firewall status")).text).toMatch(/status: ATIVO.*regra/);
  expect((await s.run("firewall status")).text).toContain("reversão: pendente");
  expect((await s.run("firewall check")).text).toContain("as regras vivas batem");

  const c = await s.run("firewall confirm");
  expect(c.text).toContain("confirmado");
  expect(stubs.calls().at(-1)).toBe("systemctl stop pvx-firewall-revert.timer");
  expect((await s.run("firewall status")).text).toContain("reversão: nenhuma");
  expect((await s.run("firewall confirm")).text).toContain("nada pendente");
});

test("apply without a session IP aborts; --force goes ahead with no revert", async () => {
  delete process.env.SSH_CLIENT;
  const s = await runSession(dir);
  const r = await s.run("firewall apply", { confirmed: true });
  expect(r.exit).toBe(1);
  expect(r.text).toContain("--force");
  expect(stubs.calls().some((c) => c.startsWith("nft -f"))).toBe(false);
  expect((await s.run("firewall apply --force --no-rollback", { confirmed: true })).ok).toBe(true);
  expect(stubs.calls().some((c) => c.startsWith("systemd-run"))).toBe(false);
});

test("check shows what an apply would add and remove", async () => {
  const s = await runSession(dir);
  const t = (await s.run("firewall check")).text;
  expect(t).toContain("+ ip saddr 203.0.113.7 accept");
  expect(t).toContain("+ drop");
});

test("trust-asterisk reviews, never writes on its own (not even with --yes), writes only with --accept", async () => {
  writeFileSync(join(stubs.dir, "asterisk.sip show peers"), "1000/1000   189.10.20.30   D  Yes  Yes   5060  OK (1 ms)\n1001/1001   192.168.0.5   D  Yes  Yes   5060  OK\n");
  const s = await runSession(dir);
  const review = await s.run("firewall ip trust-asterisk", { confirmed: true });
  expect(review.text).toContain("189.10.20.30");
  expect(review.text).toContain("1000");
  expect(review.text).not.toContain("192.168.0.5 ");
  expect(review.text).toContain("nada foi gravado");
  expect((await s.run("firewall ip list")).text).not.toContain("189.10.20.30");
  const ok = await s.run("firewall ip trust-asterisk --accept 189.10.20.30");
  expect(ok.text).toContain("189.10.20.30 (1000)");
  expect((await s.run("firewall ip list")).text).toContain("asterisk: 1000");
  expect((await s.run("firewall ip trust-asterisk --accept 8.8.8.8")).text).toContain("não é um candidato");
});

test("engine: set, show, reject unknown", async () => {
  const s = await runSession(dir);
  expect((await s.run("firewall engine bogus")).exit).toBe(1);
  expect((await s.run("firewall engine iptables")).text).toContain("engine: iptables -> iptables");
  expect((await s.run("firewall engine")).text).toContain("iptables");
  expect((await s.run("firewall engine auto")).text).toContain("auto -> nftables");
});

test("boot: dry-run prints the unit without writing; status reads systemctl", async () => {
  const s = await runSession(dir);
  const d = await s.run("firewall boot enable --dry-run", { confirmed: true });
  expect(d.text).toContain("ExecStart=/usr/local/bin/pvx firewall apply --yes --force --no-rollback");
  expect(stubs.calls().some((c) => c.startsWith("systemctl enable"))).toBe(false);
  expect((await s.run("firewall boot status")).text).toContain("desabilitado");
});
