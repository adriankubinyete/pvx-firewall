import { expect, test } from "bun:test";
import type { ModuleDef, ReadCtx, SlotData } from "@pvx/sdk";
import factory from "../src/index.tsx";
import { paths, stateDir } from "../src/rollback.ts";
import { desiredOf, listsFingerprint, removeEntry, seed } from "../src/state.ts";
import { nftables } from "../src/engines/nft.ts";
import { fakeExec, fakeFs, fakeReadCtx, fakeSdk, fakeSystem, memStore, type Call } from "./fake.ts";

const build = (fs = fakeFs()) => ({ fs, def: factory(fakeSdk(fs)) });
const cap = (def: ModuleDef, id: string) => def.capabilities!.find((c) => c.id === id)!;
// The read-only context the host hands to prove, queries and widgets: `this` for the queries.
const ctx = (store: ReturnType<typeof memStore>, fs = fakeFs(), exec = fakeExec().exec): ReadCtx => fakeReadCtx({ ...fakeSystem(), store, fs, exec });
/** An exec for a host with nftables whose live rules are `rules` (none: the table is gone). */
const nftHost = (rules?: string[]) =>
  fakeExec((c: Call) => (c.cmd === "nft" && c.args[0] === "list" ? (rules ? { stdout: `table ip pvx {\n\tchain input {\n\t\ttype filter hook input priority -10; policy accept;\n${rules.map((r) => `\t\t${r}\n`).join("")}\t}\n}\n` } : { code: 1 }) : { stdout: "nftables v1" })).exec;
const stateFile = () => `${stateDir()}/state.json`;

test("capabilities wire as specified", () => {
  const { def } = build();
  expect(cap(def, "firewall.base-ips")).toMatchObject({ fix: "firewall ip trust-phonevox", affects: ["firewall.active"] });
  expect(cap(def, "firewall.asterisk-ips")).toMatchObject({ fix: "firewall ip trust-asterisk", affects: ["firewall.active"], optIn: true });
  expect(cap(def, "firewall.active").fix).toBe("firewall apply");
});

test("read-only commands are marked; the live-changing ones are destructive", () => {
  const { def } = build();
  const c = def.commands!;
  for (const k of ["status", "check", "ip list", "port list", "boot status"]) expect(c[k]!.readonly).toBe(true);
  for (const k of ["apply", "revert", "boot enable", "boot disable"]) expect(c[k]!.destructive).toBe(true);
  for (const k of ["ip accept", "ip deny", "ip remove", "ip trust-phonevox", "ip trust-asterisk", "port accept", "confirm", "engine"]) expect(c[k]!.readonly).toBeUndefined();
  expect(def.pages!.firewall!.tab).toEqual({ label: "Firewall", order: 30 });
});

test("base-ips: ok when covered, warn with the missing ones", async () => {
  const { def } = build();
  expect((await cap(def, "firewall.base-ips").prove(ctx(memStore()))).level).toBe("ok");
  const st = seed();
  removeEntry(st, ["ipAccept"], "45.140.193.125");
  const p = await cap(def, "firewall.base-ips").prove(ctx(memStore({ state: st })));
  expect(p.level).toBe("warn");
  expect(p.text).toContain("45.140.193.125");
});

test("active: never applied, applied but lists changed, pending, reverted, no boot, ok", async () => {
  const { def, fs } = build();
  const prove = (store: ReturnType<typeof memStore>) => cap(def, "firewall.active").prove(ctx(store, fs));
  expect(await prove(memStore())).toMatchObject({ level: "warn", fix: "firewall apply" });

  const key = listsFingerprint(seed());
  const last = { at: "T", engine: "nftables", key, rules: 30 };
  expect(await prove(memStore({ lastApply: { ...last, key: "other" } }))).toMatchObject({ level: "warn", text: expect.stringContaining("listas mudaram") });
  const live = nftHost(nftables.render(desiredOf(seed())));
  const proveLive = (store: ReturnType<typeof memStore>, exec = live) => cap(def, "firewall.active").prove(ctx(store, fs, exec));
  expect(await proveLive(memStore({ lastApply: last }))).toMatchObject({ level: "warn", fix: "firewall boot enable" });

  fs.files.set("/etc/systemd/system/multi-user.target.wants/pvx-firewall.service", "");
  expect((await proveLive(memStore({ lastApply: last }))).level).toBe("ok");
  // An external flush leaves the record intact: only the live probe sees it.
  expect(await proveLive(memStore({ lastApply: last }), nftHost())).toMatchObject({ level: "error", fix: "firewall apply", text: expect.stringContaining("removidas") });
  expect(await proveLive(memStore({ lastApply: last }), nftHost(["drop"]))).toMatchObject({ level: "warn", text: expect.stringContaining("faltam") });

  const soon = { deadline: Date.now() + 30_000 };
  fs.files.set(paths().marker, "1"); // marker there: the revert is still armed
  expect(await prove(memStore({ lastApply: last, pending: soon }))).toMatchObject({ level: "warn", fix: "firewall confirm" });
  fs.files.delete(paths().marker);
  expect(await prove(memStore({ lastApply: last, pending: soon }))).toMatchObject({ level: "error", text: expect.stringContaining("revertida") });
});

test("asterisk-ips reads what the last review left", async () => {
  const { def } = build();
  const prove = (a?: unknown) => cap(def, "firewall.asterisk-ips").prove(ctx(memStore(a ? { asterisk: a } : {})));
  expect((await prove()).level).toBe("warn");
  expect((await prove({ at: 1, pending: [{ ip: "1.2.3.4", peer: "x" }] })).text).toContain("1.2.3.4");
  expect((await prove({ at: 1, pending: [] })).level).toBe("ok");
});

test("queries firewall.missingBaseIps and firewall.status read the module state", async () => {
  const { def, fs } = build();
  const st = seed();
  removeEntry(st, ["ipAccept"], "127.0.0.1");
  fs.files.set(stateFile(), JSON.stringify({ state: st, engine: "iptables" }));
  const q = (name: string) => def.queries![name]!.call(ctx(memStore(JSON.parse(fs.files.get(stateFile())!)), fs), name);
  expect(await q("firewall.missingBaseIps")).toEqual([{ ip: "127.0.0.1", comment: "LOCALHOST" }]);
  expect(await q("firewall.status")).toMatchObject({ engine: "iptables", applied: null, current: false, missingBaseIps: ["127.0.0.1"], boot: false });
});

test("widgets: chip says engine and rule count with a level; attention lists the missing base IPs with the fix", async () => {
  const { def, fs } = build();
  const read = () => ctx(memStore(JSON.parse(fs.files.get(stateFile()) ?? "{}")), fs);
  const chip = () => def.widgets!.chip!.data(read());
  const att = () => def.widgets!.atencao!.data(read());
  expect(await chip()).toEqual([{ label: "firewall · auto · não aplicado", level: "warn" }]);
  const st = seed();
  fs.files.set(stateFile(), JSON.stringify({ state: st, lastApply: { at: "T", engine: "nftables", key: listsFingerprint(st), rules: 34 } }));
  expect(await chip()).toEqual([{ label: "firewall · nftables · 34 regras", level: "ok", detail: undefined }]);
  expect(await att()).toEqual([]);
  removeEntry(st, ["ipAccept"], "127.0.0.1");
  fs.files.set(stateFile(), JSON.stringify({ state: st }));
  expect(await att()).toEqual([{ level: "warn", title: "firewall: faltam 1 IP(s) base da Phonevox", fix: "firewall ip trust-phonevox" }]);
  const slots: SlotData[] = [await chip(), await att()];
  expect(slots).toHaveLength(2);
});
