import { expect, test } from "bun:test";
import { BOOT_ARGS, DEFAULT_BIN, UNIT_NAME, UNIT_PATH, unitText } from "../src/boot.ts";
import { ENGINES } from "../src/engines/index.ts";
import factory from "../src/index.tsx";
import { fakeExec, fakeFs, fakeSdk, io, line } from "./fake.ts";

test("unit content", () => {
  expect(unitText("/usr/local/bin/pvx", "nftables")).toBe(`[Unit]
Description=pvx firewall: reapply the saved lists
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/pvx firewall apply --yes --force --no-rollback

[Install]
WantedBy=multi-user.target
`);
  expect(unitText("/x/pvx", "firewalld")).toContain("After=network-online.target firewalld.service");
});

// Regression: the Python unit ran `pvx firewall sync`, a command that did not exist, so the boot service always failed.
test("ExecStart names a command and flags that the module really has", () => {
  const def = factory(fakeSdk());
  const [module, ...rest] = BOOT_ARGS;
  expect(module).toBe("firewall");
  const key = Object.keys(def.commands ?? {}).filter((k) => rest.join(" ").startsWith(k)).sort((a, b) => b.length - a.length)[0];
  expect(key).toBe("apply");
  const cmd = def.commands![key!]!;
  const flags = rest.slice(key!.split(" ").length).filter((a) => a.startsWith("--")).map((a) => a.slice(2));
  const known = ["yes", ...(cmd.args ?? []).map((a) => a.name)];
  for (const f of flags) expect(known).toContain(f);
  expect(cmd.destructive).toBe(true); // --yes is what lets the unit run it without a TTY
  expect(unitText(DEFAULT_BIN, "iptables")).not.toContain("sync");
});

test("the manifest declares every command the module registers", async () => {
  const manifest = JSON.parse(await Bun.file(`${import.meta.dir}/../pvx-module.json`).text());
  const def = factory(fakeSdk());
  expect(Object.keys(def.commands!).sort()).toEqual([...manifest.contributes.commands].sort());
  expect(Object.keys(def.pages!)).toEqual(manifest.contributes.pages);
  expect(Object.keys(def.widgets!).sort()).toEqual([...manifest.contributes.widgets].sort());
  expect(def.capabilities!.map((c) => c.id).sort()).toEqual([...manifest.contributes.capabilities].sort());
});

test("the manifest allowlist is exact: `who` is gone, the session comes from ctx.session", async () => {
  const manifest = JSON.parse(await Bun.file(`${import.meta.dir}/../pvx-module.json`).text());
  expect(manifest.permissions.exec).toEqual(["firewall-cmd", "nft", "iptables", "iptables-save", "iptables-restore", "systemctl", "systemd-run", "asterisk", "sh"]);
});

test("boot enable writes the unit, reloads, enables", async () => {
  const fs = fakeFs();
  const { exec, calls } = fakeExec();
  await ENGINES.nftables.bootEnable(io(exec, fs), "/opt/pvx");
  expect(fs.files.get(UNIT_PATH)).toBe(unitText("/opt/pvx", "nftables"));
  expect(calls.map(line)).toEqual(["systemctl daemon-reload", `systemctl enable ${UNIT_NAME}`]);
});

test("boot disable disables, removes the unit, reloads; status reads is-enabled", async () => {
  const fs = fakeFs();
  fs.files.set(UNIT_PATH, "x");
  const { exec, calls } = fakeExec();
  await ENGINES.iptables.bootDisable(io(exec, fs));
  expect(fs.files.has(UNIT_PATH)).toBe(false);
  expect(calls.map(line)).toEqual([`systemctl disable ${UNIT_NAME}`, "systemctl daemon-reload"]);
  expect(await ENGINES.iptables.bootStatus(io(fakeExec(() => ({ stdout: "enabled\n" })).exec))).toBe("enabled");
  expect(await ENGINES.iptables.bootStatus(io(fakeExec(() => ({ code: 1, stdout: "disabled\n" })).exec))).toBe("disabled");
});

test("a failing systemctl enable surfaces as a StepError", async () => {
  const { exec } = fakeExec((c) => (c.args[0] === "enable" ? { code: 1, lines: ["boom"] } : undefined));
  await expect(ENGINES.nftables.bootEnable(io(exec), "/x")).rejects.toMatchObject({ name: "StepError", code: 1, output: ["boom"] });
});
