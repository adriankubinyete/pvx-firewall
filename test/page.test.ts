import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { renderPage, type TuiHarness } from "@pvx/testing";
import { SSH_CLIENT_IP, installStubs, type Stubs } from "./stubs.ts";

const moduleDir = join(import.meta.dir, "..");
let page: TuiHarness | undefined;
let stubs: Stubs;

// The commands the page runs go through the host's session store, which reads the real `hostSession` (the harness cannot inject one
// there). The host reads the environment first and remembers the answer, so this is set before anything asks.
process.env.SSH_CLIENT = `${SSH_CLIENT_IP} 5555 22`;

beforeEach(() => {
  stubs = installStubs(["nft", "systemctl", "systemd-run", "asterisk"]);
});
afterEach(() => {
  page?.destroy();
  stubs.restore();
});

/** Real processes run behind these commands, so wait in time, not in frames. */
const until = async (target: TuiHarness, matches: (frame: string) => boolean, timeoutMs = 4000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await target.flush();
    const frame = target.frame();
    if (matches(frame)) return frame;
    if (Date.now() > deadline) throw new Error(`tempo esgotado esperando o quadro:\n${frame}`);
    await Bun.sleep(25);
  }
};
const untilShows = (target: TuiHarness, text: string) => until(target, (frame) => frame.includes(text));

/** The page, once the status query has answered. */
/** `sshClient` null: a console login, no SSH client. */
const open = async (cols = 120, rows = 30, sshClient: string | null = SSH_CLIENT_IP) => {
  page = await renderPage(moduleDir, "firewall", { cols, rows, sshClient: sshClient ?? undefined });
  await untilShows(page, "status:");
  return page;
};

const nftWasLoaded = () => stubs.calls().some((call) => call.startsWith("nft -f"));
const anyCall = (prefix: string) => stubs.calls().some((call) => call.startsWith(prefix));

// ---- layout ----

test("three numbered panels; the status comes from a query, with a spinner while it loads", async () => {
  page = await renderPage(moduleDir, "firewall", { cols: 120, rows: 30, sshClient: SSH_CLIENT_IP });
  expect(page.frame()).toContain("consultando o firewall…");
  const frame = await untilShows(page, "status: INATIVO");
  for (const text of ["[1] status ●", "[2] IPs 1/13", "[3] portas 1/20", "engine: nftables (auto)", "127.0.0.1"]) expect(frame).toContain(text);
  expect(frame).toMatch(/valor\s+ação\s+origem\s+comentário/);
  expect(frame).toContain("+ adicionar…");
  expect(frame).toContain("+ confiar IPs da Phonevox");
  expect(frame).toContain("[ aplicar ]");
});

test("120 columns: the lists sit side by side; 100 and 80: stacked", async () => {
  const wide = await open(120, 30);
  const listsLine = wide.frame().split("\n").find((line) => line.includes("[2] IPs"));
  expect(listsLine).toContain("[3] portas");
  wide.destroy();

  const stacked = await open(100, 30);
  const frame = stacked.frame();
  expect(frame.split("\n").find((line) => line.includes("[2] IPs"))).not.toContain("[3] portas");
  expect(frame).toContain("[3] portas");
  expect(frame).toContain("5060/udp"); // the second list shows rows too
});

test("80x24: the focused list gets the height and the other collapses to its title; nothing is cut", async () => {
  const small = await open(80, 24);
  expect(small.frame()).toContain("[2] IPs 1/13");
  expect(small.frame()).toContain("[3] portas 1/20");
  expect(small.frame()).not.toContain("5060/udp"); // collapsed
  await small.press("3");
  const frame = small.frame();
  expect(frame).toContain("5060/udp");
  expect(frame).toContain("+ adicionar…"); // the action row under the entries is always shown
  expect(frame).not.toContain("127.0.0.1"); // the IPs list collapsed in turn
  expect(frame.split("\n").filter((line) => line.includes("╰")).length).toBeGreaterThanOrEqual(3); // every panel keeps its bottom border
});

// ---- focus: the four levels ----

test("1/2/3 jump, the arrows pick the panel on that side, enter goes inside, esc comes out", async () => {
  const p = await open();
  expect(p.frame()).not.toContain("a adiciona"); // the status panel has no list keys
  await p.press("2");
  expect(p.frame()).toContain("[2] IPs 1/13 ●");
  expect(p.frame()).not.toContain("»"); // focus on the panel: no row selected yet
  for (const key of ["a adiciona", "t trust-phonevox", "A aplicar"]) expect(p.frame()).toContain(key);
  await p.press("ARROW_RIGHT");
  expect(p.frame()).toContain("[3] portas 1/20 ●");
  expect(p.frame()).not.toContain("trust-phonevox");
  await p.press("ARROW_RIGHT");
  expect(p.frame()).toContain("nada aqui"); // nothing to the right
  await p.press("ARROW_LEFT");
  await p.press("RETURN");
  expect(p.frame()).toMatch(/»\s+127\.0\.0\.1/); // inside the IPs list: the first row is selected
  await p.press("ESCAPE");
  expect(p.frame()).not.toContain("»");
  expect(p.frame()).toContain("[2] IPs 1/13 ●"); // esc left the list, not the panel
});

test("enter on the status panel says there is nothing to select", async () => {
  const p = await open();
  await p.press("RETURN");
  expect(p.frame()).toContain("nada para selecionar");
});

test("inside a list the selection wraps at both ends and is by id", async () => {
  const p = await open();
  await p.press("2");
  await p.press("RETURN");
  await p.press("ARROW_UP");
  expect(p.frame()).toMatch(/»\s+\+ confiar IPs da Phonevox/); // from the first row to the last
  await p.press("ARROW_DOWN");
  expect(p.frame()).toMatch(/»\s+127\.0\.0\.1/);
  await p.press("ARROW_DOWN");
  expect(p.frame()).toContain("[2] IPs 2/13");
});

test("stacked panels: ↓ goes to the panel below", async () => {
  const p = await open(100, 30);
  await p.press("ARROW_DOWN");
  expect(p.frame()).toContain("[2] IPs 1/13 ●");
  await p.press("ARROW_DOWN");
  expect(p.frame()).toContain("[3] portas 1/20 ●");
});

// ---- mouse ----

const positionOf = (frame: string, text: string) => {
  const lines = frame.split("\n");
  const y = lines.findIndex((line) => line.includes(text));
  if (y < 0) throw new Error(`"${text}" não está no quadro:\n${frame}`);
  return { x: lines[y]!.indexOf(text), y };
};

test("a click on a panel focuses it; a click on a row goes inside and selects it", async () => {
  const p = await open();
  const title = positionOf(p.frame(), "[3] portas");
  await p.click(title.x + 1, title.y);
  expect(p.frame()).toContain("[3] portas 1/20 ●");
  const row = positionOf(p.frame(), "5061/tcp");
  await p.click(row.x, row.y);
  expect(p.frame()).toContain("[3] portas 3/20 ●");
  expect(p.frame()).toMatch(/»\s+5061\/tcp/);
});

test("hover moves the selection only inside the list that has the focus", async () => {
  const p = await open();
  const row = positionOf(p.frame(), "10.0.0.0/8");
  await p.hover(row.x, row.y);
  expect(p.frame()).toContain("[2] IPs 1/13"); // not focused: only a tint
  await p.press("2");
  await p.press("RETURN");
  const hovered = positionOf(p.frame(), "192.168.0.0/16");
  await p.hover(hovered.x, hovered.y);
  expect(p.frame()).toContain("[2] IPs 4/13");
});

test("the action rows and the aplicar button react to the click", async () => {
  const p = await open();
  const addRow = positionOf(p.frame(), "+ adicionar…");
  await p.click(addRow.x, addRow.y);
  expect(p.frame()).toContain("adicionar IP");
  await p.press("ESCAPE");
  const apply = positionOf(p.frame(), "[ aplicar ]");
  await p.click(apply.x + 2, apply.y);
  await until(p, (frame) => frame.includes("aplicar firewall"));
});

// ---- forms ----

test("a: the add form validates inline, then runs the module's own `ip accept` with the comment", async () => {
  const p = await open();
  await p.press("2");
  await p.press("a");
  expect(p.frame()).toContain("adicionar IP");
  await p.type("300.1.1.1");
  await p.press("s", { ctrl: true });
  expect(p.frame()).toContain("IP/CIDR inválido: 300.1.1.1"); // inline, under the field; nothing ran
  expect(p.frame()).toContain("adicionar IP");
  for (let i = 0; i < "300.1.1.1".length; i++) await p.press("BACKSPACE");
  await p.type("203.0.113.9");
  await p.press("TAB");
  await p.press("TAB");
  await p.type("fulano");
  await p.press("s", { ctrl: true });
  const frame = await until(p, (f) => f.includes("[2] IPs") && f.includes("/14"));
  expect(frame).toContain("adicionado: 203.0.113.9");
});

test("the add form's choice sends the entry to the deny list", async () => {
  const p = await open();
  await p.press("2");
  await p.press("a");
  await p.type("198.51.100.0/24");
  await p.press("TAB");
  await p.press("ARROW_DOWN");
  await p.press(" ");
  await p.press("s", { ctrl: true });
  await untilShows(p, "adicionado: 198.51.100.0/24");
  expect((await untilShows(p, "[2] IPs 1/14"))).toContain("[2] IPs 1/14");
});

test("enter on a row edits its comment through the command", async () => {
  const p = await open();
  await p.press("2");
  await p.press("RETURN");
  await p.press("RETURN");
  expect(p.frame()).toContain("comentar 127.0.0.1");
  await p.type("loop");
  await p.press("s", { ctrl: true });
  await until(p, (f) => f.includes("comentário atualizado: 127.0.0.1"));
  expect(p.frame()).toContain("LOCALHOSTlo"); // the field started with the current comment (the column cuts the rest)
});

test("the form's remover button asks first, then removes through the command", async () => {
  const p = await open();
  await p.press("2");
  await p.press("RETURN");
  await p.press("RETURN");
  for (let i = 0; i < 3; i++) await p.press("TAB"); // comentário -> salvar -> cancelar -> remover
  await p.press("RETURN");
  expect(p.frame()).toContain("remover? enter confirma");
  await p.press("ESCAPE");
  expect(p.frame()).toContain("comentar 127.0.0.1"); // esc took it back to the form
  await p.press("RETURN");
  await p.press("RETURN");
  await until(p, (f) => f.includes("removido: 127.0.0.1"));
  expect(p.frame()).toContain("[2] IPs 1/12");
});

test("t brings the base IPs back; the row does the same", async () => {
  const p = await open();
  await p.press("2");
  await p.press("RETURN");
  await p.press("RETURN");
  for (let i = 0; i < 3; i++) await p.press("TAB");
  await p.press("RETURN");
  await p.press("RETURN");
  await until(p, (f) => f.includes("removido: 127.0.0.1"));
  await p.press("t");
  await until(p, (f) => f.includes("adicionados 1 IP(s) base"));
  expect(p.frame()).toContain("/13");
});

// ---- errors ----

test("an error opens a result screen with the cause and stays until it is closed", async () => {
  const p = await open();
  await p.press("2");
  await p.press("a");
  await p.type("203.0.113.7"); // the session's own IP
  await p.press("TAB");
  await p.press("ARROW_DOWN");
  await p.press(" ");
  await p.press("s", { ctrl: true });
  const frame = await until(p, (f) => f.includes("erro (saiu 1)"));
  expect(frame).toContain("contém o IP da sua sessão");
  await p.flush();
  expect(p.frame()).toContain("erro (saiu 1)"); // it does not go back by itself
  await p.press("RETURN");
  expect(p.frame()).toContain("[2] IPs");
  expect(p.frame()).not.toContain("erro (saiu 1)");
});

// ---- apply ----

test("A: reviews the diff, the host confirms, then the countdown; enter confirms the access", async () => {
  const p = await open();
  await p.press("A", { shift: true });
  const review = await untilShows(p, "aplicar firewall");
  expect(review).toContain("sessão 203.0.113.7 fica liberada (failsafe)");
  await p.press("RETURN"); // safe: enter applies
  await untilShows(p, "confirmar `firewall apply`? s/N"); // the host asks first: apply is destructive
  expect(nftWasLoaded()).toBe(false);
  await p.press("s");
  const countdown = await untilShows(p, "ainda tem acesso?");
  expect(countdown).toMatch(/reversão automática em \d+s/);
  expect(anyCall("systemd-run --on-active=60")).toBe(true);
  await p.press("RETURN");
  await untilShows(p, "apply confirmado");
  expect(stubs.calls()).toContain("systemctl stop pvx-firewall-revert.timer");
  expect((await untilShows(p, "status: ATIVO"))).toContain("status: ATIVO");
  await until(p, (frame) => !frame.includes("precisa aplicar")); // applied and equal: the notice goes
});

test("lists that differ from what is applied show the page notice next to aplicar (UI.md §13)", async () => {
  const p = await open();
  expect(p.frame()).toContain("precisa aplicar: o firewall ainda não foi aplicado");
});

test("A then n cancels without touching the firewall", async () => {
  const p = await open();
  await p.press("A", { shift: true });
  await untilShows(p, "aplicar firewall");
  await p.press("n");
  expect(p.frame()).toContain("[1] status");
  expect(nftWasLoaded()).toBe(false);
});

test("A then esc also cancels", async () => {
  const p = await open();
  await p.press("A", { shift: true });
  await untilShows(p, "aplicar firewall");
  await p.press("ESCAPE");
  expect(p.frame()).toContain("[1] status");
  expect(nftWasLoaded()).toBe(false);
});

// ---- the apply confirmation screen ----

const reviewFrame = async (cols: number, rows: number, sshClient: string | null = null) => {
  const p = await open(cols, rows, sshClient);
  await p.press("A", { shift: true });
  return { p, frame: await untilShows(p, "aplicar firewall") };
};

const SUMMARY_LABELS = ["IPs aceitos", "portas liberadas", "portas bloqueadas", "o resto", "bloqueado", "depois de aplicar: 60s para confirmar", "[ aplicar ]", "[ cancelar ]"];
const SIZES: [number, number][] = [[80, 24], [120, 40]];

test("review with the session IP: the failsafe line, the grouped summary, one set of keys, no raw rules", async () => {
  for (const [cols, rows] of SIZES) {
    const { p, frame } = await reviewFrame(cols, rows, SSH_CLIENT_IP);
    for (const text of ["[✓]", "sessão 203.0.113.7 fica liberada (failsafe)", ...SUMMARY_LABELS]) expect(frame).toContain(text);
    expect(frame).toMatch(/IPs aceitos\s+13\s+127\.0\.0\.1/);
    expect(frame).toMatch(/portas bloqueadas\s+14\s+995\/udp/);
    expect(frame).toMatch(/\[ ver as \d+ regras \]/);
    expect(frame).not.toContain("informar meu IP");
    expect(frame).not.toContain("ip saddr"); // the raw rules wait behind `d`
    expect(frame).not.toContain("removidas"); // nothing to drop on a fresh host
    expect(frame.split("\n").every((line) => line.length <= cols)).toBe(true);
    expect(frame.match(/enter aplicar/g)?.length ?? 0).toBeLessThanOrEqual(1); // the keys are in the footer once
    p.destroy();
  }
});

test("review without the session IP: the warning with its two buttons, and enter does not apply", async () => {
  for (const [cols, rows] of SIZES) {
    const { p, frame } = await reviewFrame(cols, rows);
    for (const text of ["[!]", "Não achei o IP da sua sessão SSH", "sem ele não há failsafe", "[ informar meu IP ]", "[ aplicar sem failsafe ]", ...SUMMARY_LABELS]) expect(frame).toContain(text);
    expect(frame).not.toContain("fica liberada");
    await p.press("RETURN"); // not safe: enter walks to the warning's buttons
    await p.flush();
    expect(p.frame()).toContain("aplicar firewall");
    expect(nftWasLoaded()).toBe(false);
    expect(anyCall("systemd-run")).toBe(false);
    p.destroy();
  }
});

test("d shows the raw rules and esc brings the summary back; the rules are not loaded", async () => {
  const { p } = await reviewFrame(120, 40, SSH_CLIENT_IP);
  await p.press("d");
  const details = await untilShows(p, "regras que mudam");
  expect(details).toContain("+ ip saddr 203.0.113.7 accept");
  expect(details).toContain("+ tcp dport 80 drop");
  await p.press("ESCAPE");
  expect(await untilShows(p, "aplicar firewall")).toContain("IPs aceitos");
  expect(nftWasLoaded()).toBe(false);
});

test("informar meu IP validates, then the apply uses it as the failsafe (--failsafe-ip)", async () => {
  const { p } = await reviewFrame(120, 30);
  const button = positionOf(p.frame(), "[ informar meu IP ]");
  await p.click(button.x + 2, button.y);
  await untilShows(p, "meu IP");
  await p.type("300.1.1.1");
  await p.press("RETURN");
  expect(p.frame()).toContain("IP inválido: 300.1.1.1");
  for (let i = 0; i < "300.1.1.1".length; i++) await p.press("BACKSPACE");
  await p.type("198.51.100.4");
  await p.press("RETURN");
  const summary = await untilShows(p, "IP 198.51.100.4 informado fica liberado (failsafe)");
  expect(summary).not.toContain("Não achei");
  await p.press("RETURN");
  await untilShows(p, "confirmar `firewall apply`? s/N");
  await p.press("s");
  await untilShows(p, "ainda tem acesso?");
  expect(stubs.loaded()).toContain("ip saddr 198.51.100.4 accept");
});

test("aplicar sem failsafe goes through the host's confirmation, then applies with --force", async () => {
  const { p } = await reviewFrame(120, 30);
  const button = positionOf(p.frame(), "[ aplicar sem failsafe ]");
  await p.click(button.x + 2, button.y);
  await untilShows(p, "confirmar `firewall apply`? s/N");
  expect(nftWasLoaded()).toBe(false); // nothing runs before the host's confirmation
  await p.press("s");
  await untilShows(p, "ainda tem acesso?");
  expect(nftWasLoaded()).toBe(true);
});

test("without a failsafe IP, enter focuses the warning's buttons; right moves, enter opens the IP field", async () => {
  const { p } = await reviewFrame(120, 30);
  await p.press("RETURN");
  await p.press("RETURN"); // the first button is `informar meu IP`
  await untilShows(p, "meu IP");
  expect(nftWasLoaded()).toBe(false);
  await p.press("ESCAPE");
  expect(await untilShows(p, "aplicar firewall")).toContain("[ informar meu IP ]");
});
