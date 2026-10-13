import { expect, test } from "bun:test";
import type { ModuleDef, Sdk, SlotData } from "@pvx/sdk";
import factory from "../src/index.tsx";
import { paths, stateDir } from "../src/rollback.ts";
import { removeEntry, seed } from "../src/state.ts";
import { fakeFs, memStore } from "./fake.ts";

const build = (fs = fakeFs()) => ({ fs, def: (factory as (s: Sdk) => ModuleDef)({ version: 1, ui: {} as Sdk["ui"], fs, log: { debug() {}, info() {}, warn() {}, error() {} } }) });
const cap = (def: ModuleDef, id: string) => def.capabilities!.find((c) => c.id === id)!;
const ctx = (store: ReturnType<typeof memStore>) => ({ store, log: { debug() {}, info() {}, warn() {}, error() {} }, query: () => undefined }) as never;
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
  const prove = (store: ReturnType<typeof memStore>) => cap(def, "firewall.active").prove(ctx(store));
  expect(await prove(memStore())).toMatchObject({ level: "warn", fix: "firewall apply" });

  const { keyOf } = await import("../src/state.ts");
  const key = keyOf(seed());
  const last = { at: "T", engine: "nftables", key, rules: 30 };
  expect(await prove(memStore({ lastApply: { ...last, key: "other" } }))).toMatchObject({ level: "warn", text: expect.stringContaining("listas mudaram") });
  expect(await prove(memStore({ lastApply: last }))).toMatchObject({ level: "warn", fix: "firewall boot enable" });

  fs.files.set("/etc/systemd/system/multi-user.target.wants/pvx-firewall.service", "");
  expect((await prove(memStore({ lastApply: last }))).level).toBe("ok");

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
  expect(await def.queries!["firewall.missingBaseIps"]!("firewall.missingBaseIps")).toEqual([{ ip: "127.0.0.1", comment: "LOCALHOST" }]);
  expect(await def.queries!["firewall.status"]!("firewall.status")).toMatchObject({ engine: "iptables", applied: null, current: false, missingBaseIps: ["127.0.0.1"], boot: false });
});

test("widgets: chip says engine and rule count with a level; attention lists the missing base IPs with the fix", async () => {
  const { def, fs } = build();
  const chip = () => def.widgets!.chip!.data() as Promise<{ label: string; level: string; detail?: string }[]>;
  const att = () => def.widgets!.atencao!.data() as Promise<{ level: string; title: string; fix?: string }[]>;
  expect(await chip()).toEqual([{ label: "firewall · auto · não aplicado", level: "warn" }]);
  const { keyOf } = await import("../src/state.ts");
  const st = seed();
  fs.files.set(stateFile(), JSON.stringify({ state: st, lastApply: { at: "T", engine: "nftables", key: keyOf(st), rules: 34 } }));
  expect(await chip()).toEqual([{ label: "firewall · nftables · 34 regras", level: "ok", detail: undefined }]);
  expect(await att()).toEqual([]);
  removeEntry(st, ["ipAccept"], "127.0.0.1");
  fs.files.set(stateFile(), JSON.stringify({ state: st }));
  expect(await att()).toEqual([{ level: "warn", title: "firewall: faltam 1 IP(s) base da Phonevox", fix: "firewall ip trust-phonevox" }]);
  const slots: SlotData[] = [await chip(), await att()] as never;
  expect(slots).toHaveLength(2);
});
