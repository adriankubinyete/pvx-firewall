import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { renderPage, type TuiHarness } from "@pvx/testing";
import { installStubs, type Stubs } from "./stubs.ts";

const dir = join(import.meta.dir, "..");
let t: TuiHarness | undefined;
let stubs: Stubs;
const ssh = process.env.SSH_CLIENT;
beforeEach(() => {
  stubs = installStubs(["nft", "systemctl", "systemd-run", "who", "asterisk"]);
  process.env.SSH_CLIENT = "203.0.113.7 5555 22";
});
afterEach(() => {
  t?.destroy();
  stubs.restore();
  if (ssh === undefined) delete process.env.SSH_CLIENT;
  else process.env.SSH_CLIENT = ssh;
});

/** Real processes run behind these commands, so wait in time, not in frames. */
const until = async (p: TuiHarness, pred: (f: string) => boolean, ms = 4000): Promise<string> => {
  const end = Date.now() + ms;
  for (;;) {
    await p.flush();
    const f = p.frame();
    if (pred(f)) return f;
    if (Date.now() > end) throw new Error(`tempo esgotado esperando o quadro:\n${f}`);
    await Bun.sleep(25);
  }
};

const open = async (cols = 120, rows = 30) => {
  t = await renderPage(dir, "firewall", { cols, rows });
  await until(t, (f) => f.includes("status:"));
  return t;
};

test("three numbered panels; the status panel runs the module's own `status` command", async () => {
  const p = await open();
  const f = p.frame();
  for (const s of ["[1] status", "[2] IPs 1/13", "[3] portas 1/20", "status: INATIVO", "engine: nftables (auto)", "127.0.0.1"]) expect(f).toContain(s);
  expect(f).toContain("[1] status ●"); // the focus mark follows the panel
});

test("focus: 1/2/3 and arrows move it, the footer follows it, an illegal move nudges", async () => {
  const p = await open();
  expect(p.frame()).not.toContain("adiciona");
  await p.press("2");
  expect(p.frame()).toContain("[2] IPs 1/13 ●");
  for (const k of ["adiciona", "remove", "comenta", "trust-phonevox"]) expect(p.frame()).toContain(k);
  await p.press("ARROW_RIGHT");
  expect(p.frame()).toContain("[3] portas 1/20 ●");
  expect(p.frame()).not.toContain("trust-phonevox");
  await p.press("ARROW_RIGHT");
  expect(p.frame()).toContain("nada aqui");
  await p.press("1");
  await p.press("ARROW_LEFT");
  expect(p.frame()).toContain("nada aqui");
});

test("the list cursor is by id, and ↑ at the top nudges", async () => {
  const p = await open();
  await p.press("2");
  await p.press("ARROW_UP");
  expect(p.frame()).toContain("início da lista");
  await p.press("ARROW_DOWN");
  expect(p.frame()).toContain("[2] IPs 2/13");
});

test("a adiciona: inline fields, the module's own `ip accept`, mark M and the comment", async () => {
  const p = await open();
  await p.press("2");
  await p.press("a");
  expect(p.frame()).toContain("adicionar IP");
  await p.type("203.0.113.9");
  await p.press("TAB");
  await p.type("fulano");
  await p.press("s", { ctrl: true });
  const f = await until(p, (x) => x.includes("[2] IPs") && x.includes("/14"));
  expect(f).toContain("adicionado: 203.0.113.9");
});

test("x removes the selected row; t brings the base IPs back", async () => {
  const p = await open();
  await p.press("2");
  await p.press("x");
  await until(p, (f) => f.includes("removido: 127.0.0.1"));
  expect(p.frame()).toContain("[2] IPs 1/12");
  await p.press("t");
  await until(p, (f) => f.includes("adicionados 1 IP(s) base"));
  expect(p.frame()).toContain("/13");
});

test("c edits the comment of the selected entry through the command", async () => {
  const p = await open();
  await p.press("2");
  await p.press("c");
  expect(p.frame()).toContain("comentar 127.0.0.1");
  await p.type("loop");
  await p.press("s", { ctrl: true });
  await until(p, (f) => f.includes("comentário atualizado: 127.0.0.1"));
  expect(p.frame()).toContain("aceito · LOCALHOSTloop"); // the field starts with the current comment
});

test("A: shows the diff, the host confirms, then the countdown modal; enter confirms", async () => {
  const p = await open();
  await p.press("A", { shift: true });
  const review = await until(p, (f) => f.includes("o que muda"));
  expect(review).toContain("+ ip saddr 203.0.113.7 accept");
  await p.press("RETURN");
  await until(p, (f) => f.includes("confirmar `firewall apply`? s/N")); // the host asks first: apply is destructive
  expect(stubs.calls().some((c) => c.startsWith("nft -f"))).toBe(false);
  await p.press("s");
  const cd = await until(p, (f) => f.includes("ainda tem acesso? enter confirma"));
  expect(cd).toMatch(/reversão automática em \d+s/);
  expect(stubs.calls().some((c) => c.startsWith("systemd-run --on-active=60"))).toBe(true);
  await p.press("RETURN");
  await until(p, (f) => f.includes("apply confirmado"));
  expect(stubs.calls()).toContain("systemctl stop pvx-firewall-revert.timer");
  expect(p.frame()).toContain("status: ATIVO");
});

test("A then n cancels without touching the firewall", async () => {
  const p = await open();
  await p.press("A", { shift: true });
  await until(p, (f) => f.includes("o que muda"));
  await p.press("n");
  expect(p.frame()).toContain("[1] status");
  expect(stubs.calls().some((c) => c.startsWith("nft -f"))).toBe(false);
});

test("80x24 still shows the three panels", async () => {
  const p = await open(80, 24);
  for (const s of ["[1] status", "[2] IPs", "[3] portas"]) expect(p.frame()).toContain(s);
});
