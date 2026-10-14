import { beforeEach, expect, test } from "bun:test";
import { applyFlow, detectSession } from "../src/apply.ts";
import { nftables, script } from "../src/engines/nft.ts";
import { ROLLBACK_SECONDS, UNIT, cancel, guard, paths, pendingInfo, schedule } from "../src/rollback.ts";
import { clearApplyState, clearPending, desiredOf, load } from "../src/state.ts";
import { fakeExec, fakeFs, io, line, memStore, shellOf } from "./fake.ts";

const SSH = { SSH_CLIENT: "203.0.113.7 5555 22" };
const p = () => paths();

/** nft with a table already there; the listing echoes the failsafe back once something was loaded. */
const nftHost = (opts: { loaded?: boolean; dropFailsafe?: boolean; systemdRun?: number } = {}) => {
  let loaded = false;
  return fakeExec((c) => {
    if (c.cmd === "nft" && c.args[0] === "-f") return void (loaded = true);
    if (c.cmd === "nft" && c.args[0] === "list") return loaded && !opts.dropFailsafe ? { stdout: "table ip pvx {\n chain input {\n type filter hook input priority -10; policy accept;\n ip saddr 203.0.113.7 accept\n drop\n }\n}" } : { code: 1 };
    if (c.cmd === "systemd-run") return { code: opts.systemdRun ?? 0 };
  });
};

beforeEach(() => {
  process.env.PVX_HOME = "/tmp/pvx-test-home";
});

test("detectSession: SSH_CLIENT first, then who -m", async () => {
  expect(await detectSession(fakeExec().exec, SSH)).toBe("203.0.113.7");
  const who = fakeExec(() => ({ stdout: "root pts/0 2026-10-13 (198.51.100.4)\n" }));
  expect(await detectSession(who.exec, {})).toBe("198.51.100.4");
  expect(who.calls.map(line)).toEqual(["who -m"]);
});

test("no session IP and no --force: aborts before touching anything", async () => {
  const { exec, calls } = fakeExec();
  const r = await applyFlow(nftables, io(exec), memStore(), { env: {} });
  expect(r.ok).toBe(false);
  expect(calls.map((c) => c.cmd)).toEqual(["who"]); // only the lookup
});

test("failsafe: the SSH client IP is in the loaded rules, first", async () => {
  const { exec, calls } = nftHost();
  const store = memStore();
  const r = await applyFlow(nftables, io(exec), store, { env: SSH });
  expect(r).toMatchObject({ ok: true, failsafe: "203.0.113.7" });
  const load_ = calls.find((c) => c.cmd === "nft" && c.args[0] === "-f")!;
  expect(load_.stdin).toBe(script(desiredOf(load(store), "203.0.113.7")));
  expect(load_.stdin).toContain("type filter hook input priority -10; policy accept;\n    ip saddr 203.0.113.7 accept\n");
});

test("--force without a session applies with no failsafe", async () => {
  const { exec, calls } = nftHost();
  const r = await applyFlow(nftables, io(exec), memStore(), { force: true, noRollback: true, env: {} });
  expect(r).toMatchObject({ ok: true, failsafe: undefined });
  expect(calls.find((c) => c.args[0] === "-f")!.stdin).not.toContain("203.0.113.7");
});

test("order: snapshot, schedule the revert, then load", async () => {
  const { exec, calls } = nftHost();
  const fs = fakeFs();
  await applyFlow(nftables, io(exec, fs), memStore(), { env: SSH });
  const order = calls.map((c) => `${c.cmd}:${c.args[0]}`);
  expect(order.indexOf("nft:list")).toBeLessThan(order.indexOf("systemd-run:--on-active=60"));
  expect(order.indexOf("systemd-run:--on-active=60")).toBeLessThan(order.indexOf("nft:-f"));
  expect(fs.files.get(p().script)).toContain("nft delete table ip pvx"); // there was no table before
  expect(fs.files.has(p().marker)).toBe(true);
});

test("rollback scheduling: systemd-run with a guarded restore of the saved snapshot", async () => {
  const { exec, calls } = fakeExec();
  const fs = fakeFs();
  const store = memStore();
  expect(await schedule(shellOf(exec), fs, store, 1_000_000)).toBe("systemd");
  expect(calls.map(line)).toEqual([`systemd-run --on-active=${ROLLBACK_SECONDS} --unit=${UNIT} --collect --description=pvx firewall: automatic revert sh -c ${guard(p())}`]);
  expect(guard(p())).toBe(`[ -f '${p().marker}' ] && { sh '${p().script}'; rm -f '${p().marker}'; }; true`);
  expect(store.data.pending).toEqual({ at: 1_000_000, deadline: 1_060_000 });
});

test("rollback fallback: when systemd-run fails, a detached nohup sh sleeps 60 then runs the same guard", async () => {
  const { exec, calls } = fakeExec((c) => (c.cmd === "systemd-run" ? { code: 1 } : undefined));
  expect(await schedule(shellOf(exec), fakeFs(), memStore())).toBe("sh");
  const fb = calls[1]!;
  expect(fb.cmd).toBe("sh");
  expect(fb.args[0]).toBe("-c");
  expect(fb.args[1]).toStartWith("nohup sh -c 'sleep 60; ");
  expect(fb.args[1]).toEndWith(" >/dev/null 2>&1 </dev/null &");
  expect(fb.args[1]).toContain("rollback.pending");
});

test("confirm: removing the marker disarms both jobs and the timer is stopped", async () => {
  const { exec, calls } = fakeExec();
  const fs = fakeFs();
  const store = memStore();
  await schedule(shellOf(exec), fs, store, Date.now());
  expect((await pendingInfo(fs, store)).state).toBe("pending");
  await cancel(shellOf(exec), fs);
  expect(fs.files.has(p().marker)).toBe(false);
  expect(calls.map(line).at(-1)).toBe(`systemctl stop ${UNIT}.timer`);
  store.delete("pending");
  expect((await pendingInfo(fs, store)).state).toBe("none");
});

test("pendingInfo: pending counts down, a missing marker means the revert ran, a stale marker is expired", async () => {
  const fs = fakeFs();
  const store = memStore({ pending: { at: 0, deadline: 60_000 } });
  expect((await pendingInfo(fs, store, 10_000)).state).toBe("reverted"); // no marker
  fs.files.set(p().marker, "1");
  expect(await pendingInfo(fs, store, 10_000)).toEqual({ state: "pending", left: 50 });
  expect((await pendingInfo(fs, store, 90_000)).state).toBe("expired");
});

test("a failed load restores the snapshot, cancels the revert and reports", async () => {
  const fs = fakeFs();
  const { exec, calls } = fakeExec((c) => (c.cmd === "nft" && c.args[0] === "-f" ? { code: 1, lines: ["syntax error"] } : c.cmd === "nft" ? { code: 1 } : undefined));
  const store = memStore();
  const r = await applyFlow(nftables, io(exec, fs), store, { env: SSH });
  expect(r).toMatchObject({ ok: false });
  expect((r as { error: string }).error).toContain("syntax error");
  expect(calls.some((c) => c.cmd === "sh" && c.args[0] === p().script)).toBe(true);
  expect(fs.files.has(p().marker)).toBe(false);
  expect(store.data.pending).toBeUndefined();
  expect(store.data.lastApply).toBeUndefined();
});

test("a failsafe that did not load is rolled back at once", async () => {
  const { exec, calls } = nftHost({ dropFailsafe: true });
  const r = await applyFlow(nftables, io(exec), memStore(), { env: SSH });
  expect(r.ok).toBe(false);
  expect((r as { error: string }).error).toContain("203.0.113.7");
  expect(calls.some((c) => c.cmd === "sh" && c.args[0] === p().script)).toBe(true);
});

test("a second apply while one is pending keeps the older snapshot", async () => {
  const fs = fakeFs();
  const store = memStore();
  await applyFlow(nftables, io(nftHost().exec, fs), store, { env: SSH });
  fs.files.set(p().script, "OLDER");
  await applyFlow(nftables, io(nftHost().exec, fs), store, { env: SSH });
  expect(fs.files.get(p().script)).toBe("OLDER");
});

test("success records the apply and a pending deadline; --no-rollback records none", async () => {
  const s1 = memStore();
  await applyFlow(nftables, io(nftHost().exec), s1, { env: SSH, now: 5_000 });
  expect(s1.data.pending).toEqual({ at: 5000, deadline: 65_000 });
  expect(s1.data.lastApply).toMatchObject({ engine: "nftables", failsafe: "203.0.113.7", rollback: true, rules: 2 });
  const s2 = memStore();
  await applyFlow(nftables, io(nftHost().exec), s2, { env: SSH, noRollback: true });
  expect(s2.data.pending).toBeUndefined();
});

// Three callers forget the apply state, and they differ on purpose: only a revert (or a confirm that finds the revert already done)
// makes `lastApply` describe rules that are gone.
test("clearPending keeps lastApply; clearApplyState forgets both", () => {
  const record = { pending: { at: 1, deadline: 2 }, lastApply: { at: "T" } };
  const kept = memStore(record);
  clearPending(kept);
  expect(kept.data).toEqual({ lastApply: { at: "T" } });
  const forgotten = memStore(record);
  clearApplyState(forgotten);
  expect(forgotten.data).toEqual({});
});

test("when the restore itself fails, the error says so and the revert is still cancelled", async () => {
  const fs = fakeFs();
  const { exec, calls } = fakeExec((c) => (c.cmd === "nft" && c.args[0] === "-f" ? { code: 1, lines: ["syntax error"] } : c.cmd === "sh" && c.args[0] === p().script ? { code: 1, lines: ["disk full"] } : c.cmd === "nft" ? { code: 1 } : undefined));
  const r = await applyFlow(nftables, io(exec, fs), memStore(), { env: SSH });
  expect(r).toMatchObject({ ok: false });
  expect((r as { error: string }).error).toContain("syntax error");
  expect((r as { error: string }).error).toContain(`a restauração também falhou: sh ${p().script} saiu com código 1: disk full`);
  expect(calls.map(line)).toContain(`systemctl stop ${UNIT}.timer`);
});
