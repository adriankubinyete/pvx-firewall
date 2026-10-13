import { expect, test } from "bun:test";
import { contains, normCidr, normPort, parseCidr, parsePort, sessionIp } from "../src/net.ts";
import { BASE_IPS, addEntry, deniedBy, keyOf, load, missingBase, removeEntry, seed } from "../src/state.ts";
import { memStore } from "./fake.ts";

test("cidr validation and normalisation", () => {
  expect(normCidr("10.0.0.5")).toBe("10.0.0.5");
  expect(normCidr("10.0.0.5/32")).toBe("10.0.0.5");
  expect(normCidr("10.0.0.0/8")).toBe("10.0.0.0/8");
  for (const bad of ["", "256.1.1.1", "1.2.3", "10.0.0.5/24", "1.2.3.4/33", "::1", "a.b.c.d"]) expect(parseCidr(bad)).toBeUndefined();
  expect(contains(parseCidr("10.0.0.0/8")!, parseCidr("10.1.2.3")!)).toBe(true);
  expect(contains(parseCidr("10.1.2.3")!, parseCidr("10.0.0.0/8")!)).toBe(false);
});

test("port specs", () => {
  expect(normPort("5060/UDP")).toBe("5060/udp");
  expect(normPort("10000-20000/tcp")).toBe("10000-20000/tcp");
  expect(normPort("80")).toBe("80");
  expect(normPort("22-22")).toBe("22");
  for (const bad of ["0", "70000", "20-10", "80/icmp", "x", "80/"]) expect(parsePort(bad)).toBeUndefined();
});

test("session ip: SSH_CLIENT, then SSH_CONNECTION, then who -m", () => {
  expect(sessionIp({ SSH_CLIENT: "203.0.113.7 5555 22" })).toBe("203.0.113.7");
  expect(sessionIp({ SSH_CONNECTION: "203.0.113.8 5555 10.0.0.1 22" })).toBe("203.0.113.8");
  expect(sessionIp({}, "root   pts/0   2026-10-13 10:00 (203.0.113.9)\n")).toBe("203.0.113.9");
  expect(sessionIp({ SSH_CLIENT: "garbage" }, "root pts/0 (localhost)")).toBeUndefined();
  expect(sessionIp({})).toBeUndefined();
});

test("the seed has the 13 base IPs and the default ports, all marked base", () => {
  const s = seed("t");
  expect(BASE_IPS).toHaveLength(13);
  expect(s.ipAccept).toHaveLength(13);
  expect(s.portAccept).toHaveLength(6);
  expect(s.portDeny).toHaveLength(14);
  expect([...s.ipAccept, ...s.portDeny].every((e) => e.source === "base")).toBe(true);
});

test("a read of an empty store is the seed and writes nothing", () => {
  const store = memStore();
  expect(load(store).ipAccept).toHaveLength(13);
  expect(store.data).toEqual({});
});

test("base IP diff: covered by a wider network counts as present", () => {
  const st = seed();
  expect(missingBase(st)).toEqual([]);
  removeEntry(st, ["ipAccept"], "186.233.122.92");
  removeEntry(st, ["ipAccept"], "189.124.85.152/29");
  expect(missingBase(st).map(([v]) => v)).toEqual(["189.124.85.152/29", "186.233.122.92"]);
  addEntry(st, "ipAccept", "186.233.0.0/16", "", "manual", "t");
  expect(missingBase(st).map(([v]) => v)).toEqual(["189.124.85.152/29"]); // /16 covers .122.92, not the other /29
});

test("addEntry: add, comment update, unchanged", () => {
  const st = seed();
  expect(addEntry(st, "ipAccept", "203.0.113.9", "fulano", "manual", "ana", "T")).toBe("added");
  expect(st.ipAccept.at(-1)).toEqual({ value: "203.0.113.9", comment: "fulano", source: "manual", addedBy: "ana", at: "T" });
  expect(addEntry(st, "ipAccept", "203.0.113.9", "beltrano", "manual", "ana")).toBe("updated");
  expect(addEntry(st, "ipAccept", "203.0.113.9", "", "manual", "ana")).toBe("unchanged");
  expect(st.ipAccept.filter((e) => e.value === "203.0.113.9")).toHaveLength(1);
});

test("deniedBy and keyOf", () => {
  const st = seed();
  addEntry(st, "ipDeny", "198.51.100.0/24", "", "manual", "t");
  expect(deniedBy(st, "198.51.100.7")).toBe("198.51.100.0/24");
  expect(deniedBy(st, "203.0.113.7")).toBeUndefined();
  const k = keyOf(st);
  addEntry(st, "ipAccept", "203.0.113.9", "", "manual", "t");
  expect(keyOf(st)).not.toBe(k);
});
