import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createLogger, createRegistry, loadModules, logsDir, pvxHome, runCapture } from "@pvx/core";
import { App, createSessionStore, createTabsNav, Tabs, theme, ui } from "@pvx/tui";
import { renderPage, renderTui, type TuiHarness } from "@pvx/testing";
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

test("lists are columns: header row, origin word, `ação` aligned across rows, long comments cut with …", async () => {
  const p = await open();
  const lines = p.frame().split("\n");
  const head = lines.find((l) => l.includes("origem") && l.includes("endereço"))!;
  expect(head).toMatch(/origem\s+endereço\s+ação\s+comentário/);
  expect(lines.some((l) => l.includes("origem") && l.includes("porta"))).toBe(true);
  const short = lines.find((l) => /base\s+127\.0\.0\.1\s+aceitar/.test(l))!;
  const long = lines.find((l) => /base\s+189\.124\.85\.152\/29\s+aceitar/.test(l))!;
  expect(short.indexOf("aceitar")).toBe(long.indexOf("aceitar")); // same x with different address lengths
  expect(long).toContain("…"); // not selected: the comment is cut, not scrolled
  expect(long).not.toContain(" · ");
  expect(lines.find((l) => /base\s+995\/udp\s+bloquear/.test(l))).toBeDefined();
});

test("panel level: 1/2/3 jump, arrows move spatially, the footer shows the level's keys", async () => {
  const p = await open();
  for (const k of ["a adiciona", "e editar", "x remove", "trust-phonevox"]) expect(p.frame()).not.toContain(k);
  expect(p.frame()).toContain("↑↓←→ painel");
  expect(p.frame()).toContain("enter entra");
  await p.press("2");
  expect(p.frame()).toContain("[2] IPs 1/13 ●");
  await p.press("ARROW_RIGHT");
  expect(p.frame()).toContain("[3] portas 1/20 ●");
  await p.press("ARROW_RIGHT");
  expect(p.frame()).toContain("nada aqui");
  await p.press("ARROW_LEFT");
  expect(p.frame()).toContain("[2] IPs 1/13 ●");
  await p.press("ARROW_UP");
  expect(p.frame()).toContain("[1] status ●");
  await p.press("3");
  expect(p.frame()).toContain("[3] portas 1/20 ●");
});

test("stacked layout: ↓ from status focuses IPs, ↓ again portas, ↑ walks back", async () => {
  const p = await open(90, 40);
  expect(p.frame()).toContain("[1] status ●");
  await p.press("ARROW_DOWN");
  expect(p.frame()).toContain("[2] IPs 1/13 ●");
  await p.press("ARROW_DOWN");
  expect(p.frame()).toContain("[3] portas 1/20 ●");
  await p.press("ARROW_UP");
  await p.press("ARROW_UP");
  expect(p.frame()).toContain("[1] status ●");
});

test("↑ on the topmost panel hands focus to the tab bar (a no-op outside tabs: nothing else moves)", async () => {
  const p = await open();
  await p.press("ARROW_UP");
  expect(p.frame()).toContain("[1] status ●");
  expect(p.frame()).not.toContain("nada aqui");
});

test("enter on status nudges; a/e/x/t do nothing at panel level", async () => {
  const p = await open();
  await p.press("RETURN");
  expect(p.frame()).toContain("nada para selecionar");
  await p.press("2");
  for (const k of ["a", "e", "x", "t"]) await p.press(k);
  await p.flush();
  expect(p.frame()).not.toContain("[ salvar ]");
  expect(p.frame()).not.toContain("removido");
  expect(p.frame()).toContain("[2] IPs 1/13 ●");
  expect(stubs.calls().filter((c) => c.startsWith("nft -f"))).toEqual([]);
  await p.press("ARROW_DOWN");
  expect(p.frame()).toContain("[2] IPs 1/13"); // ↓ at panel level moves no row
});

/** Presses ↓ `n` times (inside a list). */
const down = async (p: TuiHarness, n: number) => {
  for (let i = 0; i < n; i++) await p.press("ARROW_DOWN");
};
/** Panel `n`, then inside it. */
const inside = async (p: TuiHarness, n: "2" | "3") => {
  await p.press(n);
  await p.press("RETURN");
};
const nftWrites = () => stubs.calls().filter((c) => c.startsWith("nft -f"));

test("enter goes inside: the cursor shows, ↑↓ move the row, the footer lists the row keys; esc comes back", async () => {
  const p = await open();
  await p.press("2");
  expect(p.frame()).not.toMatch(/» base\s+127\.0\.0\.1/); // no row cursor at panel level
  await p.press("RETURN");
  expect(p.frame()).toMatch(/» base\s+127\.0\.0\.1/);
  for (const k of ["a adiciona", "e editar", "x remove", "↑↓ item"]) expect(p.frame()).toContain(k);
  for (const k of ["c comenta", "trust-phonevox"]) expect(p.frame()).not.toContain(k);
  expect(p.frame()).not.toContain("enter entra");
  await p.press("ARROW_DOWN");
  expect(p.frame()).toContain("[2] IPs 2/13");
  await p.press("ARROW_RIGHT");
  expect(p.frame()).toContain("[2] IPs 2/13 ●"); // ←/→ do not leave a panel from inside
  await p.press("ESCAPE");
  expect(p.frame()).toContain("[2] IPs 2/13 ●");
  expect(p.frame()).toContain("enter entra");
  expect(p.frame()).not.toContain("a adiciona");
  expect(p.frame()).not.toContain("» B"); // the selection hides again
  await p.press("ESCAPE"); // second esc is the host's default (tab bar); the page does not take it
  expect(p.frame()).toContain("[2] IPs 2/13 ●");
});

test("buttons close each list: ↓ reaches them, the count keeps the entries", async () => {
  const p = await open();
  await inside(p, "2");
  await down(p, 12);
  expect(p.frame()).toContain("[2] IPs 13/13");
  await p.press("ARROW_DOWN");
  expect(p.frame()).toContain("+ adicionar IP");
  expect(p.frame()).toContain("[2] IPs 13 ●");
  await p.press("ESCAPE");
  await inside(p, "3");
  await down(p, 20);
  expect(p.frame()).toContain("+ adicionar porta");
});

test("inside portas: a opens the port form, t does nothing", async () => {
  const p = await open();
  await inside(p, "3");
  await p.press("t");
  expect(nftWrites()).toEqual([]);
  await p.press("a");
  for (const s of ["adicionar porta", "porta ou faixa", "em vez de aceitar"]) expect(p.frame()).toContain(s);
});

test("a adiciona: the new form, the module's own `ip accept`, mark M and the comment", async () => {
  const p = await open();
  await inside(p, "2");
  await p.press("a");
  for (const s of ["adicionar IP", "IP ou CIDR", "comentário", "bloquear", "em vez de aceitar", "[ salvar ]", "[ cancelar ]"]) expect(p.frame()).toContain(s);
  expect(p.frame()).not.toContain("[ remover ]"); // adding has nothing to remove
  await p.type("203.0.113.9");
  await p.press("TAB");
  await p.type("fulano");
  await p.press("s", { ctrl: true });
  const f = await until(p, (x) => x.includes("[2] IPs") && x.includes("/14"));
  expect(f).toContain("adicionado: 203.0.113.9");
});

test("+ adicionar IP opens the add form on enter", async () => {
  const p = await open();
  await inside(p, "2");
  await down(p, 13);
  await p.press("RETURN");
  for (const s of ["IP ou CIDR", "[ salvar ]"]) expect(p.frame()).toContain(s);
  expect(p.frame()).not.toContain("[ remover ]");
});

test("+ adicionar porta opens the port form on enter and saves", async () => {
  const p = await open();
  await inside(p, "3");
  await down(p, 20);
  await p.press("RETURN");
  expect(p.frame()).toContain("porta ou faixa");
  await p.type("8080/tcp");
  await p.press("s", { ctrl: true });
  await until(p, (f) => f.includes("adicionado: 8080/tcp"));
  expect(p.frame()).toContain("[3] portas 21");
});

test("an invalid IP shows the error under the field and nothing is submitted", async () => {
  const p = await open();
  await inside(p, "2");
  await p.press("a");
  await p.type("999.1.1.1");
  await p.press("s", { ctrl: true });
  expect(p.frame()).toContain("IP ou CIDR inválido: 999.1.1.1");
  await p.flush();
  expect(p.frame()).toContain("[ salvar ]"); // still in the form
  expect(p.frame()).not.toContain("adicionado");
  await p.press("ESCAPE");
  expect(p.frame()).toContain("[2] IPs 1/13");
});

test("an invalid port shows the error under the field", async () => {
  const p = await open();
  await inside(p, "3");
  await p.press("a");
  await p.type("70000/tcp");
  await p.press("s", { ctrl: true });
  expect(p.frame()).toContain("porta inválida: 70000/tcp");
  expect(p.frame()).toContain("[ salvar ]");
});

test("e opens the edit form; the comment goes through the command", async () => {
  const p = await open();
  await inside(p, "2");
  await p.press("e");
  expect(p.frame()).toContain("editar 127.0.0.1");
  expect(p.frame()).toContain("[ remover ]");
  await p.press("TAB"); // value -> comment
  await p.type("loop");
  await p.press("s", { ctrl: true });
  await until(p, (f) => f.includes("comentário atualizado: 127.0.0.1"));
  expect(p.frame()).toMatch(/aceitar\s+LOCALHOSTl/); // the field starts with the current comment (cut by the column, the marquee scrolls it)
});

test("editing with the comment field emptied clears the comment (IP)", async () => {
  const p = await open();
  await inside(p, "2");
  await p.press("e");
  await p.press("TAB");
  for (let i = 0; i < "LOCALHOST".length; i++) await p.press("BACKSPACE");
  await p.press("s", { ctrl: true });
  await until(p, (f) => f.includes("comentário atualizado: 127.0.0.1"));
  expect(p.frame()).not.toContain("LOCALHOST");
  expect(p.frame()).toMatch(/127\.0\.0\.1\s+aceitar\s+│/);
});

test("editing with a new comment replaces it (IP)", async () => {
  const p = await open();
  await inside(p, "2");
  await p.press("e");
  await p.press("TAB");
  for (let i = 0; i < "LOCALHOST".length; i++) await p.press("BACKSPACE");
  await p.type("loop");
  await p.press("s", { ctrl: true });
  await until(p, (f) => f.includes("comentário atualizado: 127.0.0.1"));
  expect(p.frame()).toMatch(/aceitar\s+loop\s/);
  expect(p.frame()).not.toContain("LOCALHOST");
});

test("editing with the comment field emptied clears the comment (port)", async () => {
  const p = await open();
  await inside(p, "3");
  await p.press("e");
  expect(p.frame()).toContain("editar ");
  await p.press("TAB");
  for (let i = 0; i < "SIP".length; i++) await p.press("BACKSPACE");
  await p.press("s", { ctrl: true });
  await until(p, (f) => f.includes("comentário atualizado: 5060/udp"));
  expect(p.frame()).toMatch(/5060\/udp\s+aceitar\s+│/); // no " · SIP" after the mode
  expect(p.frame()).toMatch(/5060\/tcp\s+aceitar\s+SIP\s/); // the neighbour keeps its comment
});

test("enter on an entry opens the same edit form", async () => {
  const p = await open();
  await inside(p, "2");
  await p.press("ARROW_DOWN");
  await p.press("RETURN");
  expect(p.frame()).toContain("editar 10.0.0.0/8");
  expect(p.frame()).toContain("[ remover ]");
});

test("editing the value replaces the entry", async () => {
  const p = await open();
  await inside(p, "2");
  await p.press("e");
  for (let i = 0; i < 9; i++) await p.press("BACKSPACE");
  await p.type("127.0.0.2");
  await p.press("s", { ctrl: true });
  await until(p, (f) => f.includes("adicionado: 127.0.0.2"));
  expect(p.frame()).toContain("[2] IPs 13/13"); // the selection follows the new row, now the last one
});

test("x removes the selected row", async () => {
  const p = await open();
  await inside(p, "2");
  await p.press("x");
  await until(p, (f) => f.includes("removido: 127.0.0.1"));
  expect(p.frame()).toContain("[2] IPs 1/12");
});

test("the edit form's remover asks, then removes through the same command and returns to the list", async () => {
  const p = await open();
  await inside(p, "2");
  await p.press("e");
  await p.press("ARROW_UP"); // wraps to the last button
  await p.press("RETURN");
  expect(p.frame()).toContain("remover? enter confirma");
  await p.press("RETURN");
  await until(p, (f) => f.includes("removido: 127.0.0.1"));
  expect(p.frame()).toContain("[2] IPs 1/12");
  expect(p.frame()).not.toContain("[ salvar ]");
});

test("e and x do nothing on a button row", async () => {
  const p = await open();
  await inside(p, "2");
  await down(p, 13);
  await p.press("e");
  await p.press("x");
  await p.flush();
  expect(p.frame()).not.toContain("[ salvar ]");
  expect(p.frame()).not.toContain("removido");
  expect(p.frame()).toContain("[2] IPs 13 ●");
});

test("the Phonevox button is hidden while every base IP is in the list", async () => {
  const p = await open();
  await inside(p, "2");
  await down(p, 13);
  expect(p.frame()).toContain("+ adicionar IP");
  expect(p.frame()).not.toContain("confiar nos IPs da Phonevox");
});

test("the Phonevox button shows when a base IP is missing and runs trust-phonevox", async () => {
  const p = await open();
  await inside(p, "2");
  await p.press("x");
  await until(p, (f) => f.includes("removido: 127.0.0.1"));
  await down(p, 13);
  expect(p.frame()).toContain("◆ confiar nos IPs da Phonevox");
  expect(p.frame()).toContain("[2] IPs 12 ●");
  await p.press("RETURN");
  await until(p, (f) => f.includes("adicionados 1 IP(s) base"));
  expect(p.frame()).not.toContain("confiar nos IPs da Phonevox"); // nothing is missing any more
  expect(p.frame()).toContain("[2] IPs 13 ●");
});

test("a click on a button activates it", async () => {
  const p = await open();
  await inside(p, "3");
  await down(p, 20);
  const lines = p.frame().split("\n");
  const y = lines.findIndex((l) => l.includes("+ adicionar porta"));
  expect(y).toBeGreaterThan(-1);
  await p.press("ESCAPE");
  await p.click(lines[y]!.indexOf("+ adicionar porta") + 2, y);
  for (const s of ["porta ou faixa", "[ salvar ]"]) expect(p.frame()).toContain(s);
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

test("in the tab bar, no panel is drawn focused: ↑ on the top panel drops the ● and the accent; ↓ brings it back", async () => {
  const home = mkdtempSync(join(tmpdir(), "pvx-tab-"));
  mkdirSync(join(home, "usermodules"));
  symlinkSync(dir, join(home, "usermodules", "firewall"));
  process.env.PVX_HOME = home;
  process.env.PVX_USERMODULES = join(home, "usermodules");
  const makeLogger = (n: string) => createLogger(logsDir(), n);
  const registry = createRegistry();
  await loadModules(registry, { hostVersion: "0.1.0", makeLogger, ui });
  const store = createSessionStore({
    registry, makeLogger, isRoot: true, historyPath: join(pvxHome(), "tui-history"),
    core: (argv) => runCapture({ env: {}, isRoot: true, registry, makeLogger, profilesDir: join(pvxHome(), "profiles"), version: "0.1.0", theme }, argv),
  });
  const root = { id: "menu", scope: "menu" as const, element: ui.h(Tabs, { store, registry, nav: createTabsNav(), version: "0.1.0" }) };
  t = await renderTui(
    ui.h(App, { root, logger: makeLogger("firewall"), onExit: () => {}, statePath: join(home, "s.json"), palette: { session: store, registry }, pages: { session: store, registry, makeLogger } }) as never,
    { cols: 120, rows: 30 },
  );
  const p = t;
  // The bar has the keys on arrival: walk the tabs to Firewall, then enter the page.
  for (let i = 0; i < 12 && !p.frame().includes("[1] status"); i++) {
    await p.press("TAB");
    await p.flush();
  }
  expect(p.frame()).toContain("[1] status");
  expect(p.frame()).not.toContain("[1] status ●"); // bar focus: nothing is focused yet
  await p.press("ARROW_DOWN");
  await until(p, (f) => f.includes("[1] status ●"));
  await p.press("ARROW_UP");
  await until(p, (f) => f.includes("[1] status") && !f.includes("[1] status ●"));
  await p.press("ARROW_DOWN");
  await until(p, (f) => f.includes("[1] status ●"));
  rmSync(home, { recursive: true, force: true });
});

test("a click on a panel focuses it at panel level (inside a list too); the cursor goes away", async () => {
  const p = await open();
  const at = (needle: string) => {
    const lines = p.frame().split("\n");
    const y = lines.findIndex((l) => l.includes(needle));
    expect(y).toBeGreaterThan(-1);
    return { x: lines[y]!.indexOf(needle) + 1, y };
  };
  const portas = at("[3] portas");
  await p.click(portas.x, portas.y);
  expect(p.frame()).toContain("[3] portas 1/20 ●");
  await p.press("RETURN"); // inside portas: the row cursor shows
  expect(p.frame()).toMatch(/» base\s+5060\/udp/);
  const ips = at("[2] IPs");
  await p.click(ips.x, ips.y); // from inside another list, a click only moves the focus to that panel
  expect(p.frame()).toContain("[2] IPs 1/13 ●");
  expect(p.frame()).not.toContain("[3] portas 1/20 ●");
  expect(p.frame()).not.toContain("»");
  const st = at("engine: nftables");
  await p.click(st.x, st.y);
  expect(p.frame()).toContain("[1] status ●");
});

test("wrap: ↓ from the last button lands on the first entry, ↑ from the first entry on the last button", async () => {
  const p = await open();
  await inside(p, "2");
  await down(p, 13); // the "+ adicionar IP" button, last row
  expect(p.frame()).toContain("[2] IPs 13 ●");
  await p.press("ARROW_DOWN");
  expect(p.frame()).toContain("[2] IPs 1/13");
  expect(p.frame()).toMatch(/» base\s+127\.0\.0\.1/); // the window scrolled back to the top
  await p.press("ARROW_UP");
  expect(p.frame()).toContain("[2] IPs 13 ●");
  expect(p.frame()).toMatch(/» {1,3}\+ adicionar IP/); // and to the bottom, showing the button
  await p.press("ESCAPE");
  await inside(p, "3");
  await p.press("ARROW_UP");
  expect(p.frame()).toMatch(/» {1,3}\+ adicionar porta/);
  await p.press("ARROW_DOWN");
  expect(p.frame()).toContain("[3] portas 1/20");
});

const find = (p: TuiHarness, needle: string) => {
  const lines = p.frame().split("\n");
  const y = lines.findIndex((l) => l.includes(needle));
  expect(y).toBeGreaterThan(-1);
  return { x: lines[y]!.indexOf(needle) + 1, y };
};

test("a click on a row from panel level focuses that list, goes inside and selects the row", async () => {
  const p = await open();
  const row = find(p, "5061/tcp");
  await p.click(row.x, row.y);
  expect(p.frame()).toContain("[3] portas 3/20 ●");
  expect(p.frame()).toMatch(/» base\s+5061\/tcp/);
  expect(p.frame()).toContain("a adiciona"); // inside: the row keys show
  expect(p.frame()).not.toContain("[ salvar ]"); // an entry row only selects
});

test("hover tints a row of a list that is not active and moves the selection inside the active one", async () => {
  const p = await open();
  const row = find(p, "172.16.0.0/12");
  await p.hover(row.x, row.y);
  await p.flush();
  expect(p.frame()).toMatch(/› base\s+172\.16\.0\.0\/12/); // panel level: tint cue only
  expect(p.frame()).toContain("[2] IPs 1/13"); // selection did not move
  await p.press("2");
  await p.press("RETURN");
  const other = find(p, "10.0.0.0/8");
  await p.hover(other.x, other.y);
  await p.flush();
  expect(p.frame()).toMatch(/» base\s+10\.0\.0\.0\/8/); // inside: hover selects
  expect(p.frame()).not.toContain("[2] IPs 1/13");
});
