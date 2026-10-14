/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// The Firewall tab: [1] status, [2] IPs, [3] portas. Only `sdk.ui`: no React import. Every change is one of the module's
// own commands (useCommand), so it lands in the scrollback, the history and the audit.
import type { CommandRun, ListColumn, Sdk, Tone } from "@pvx/sdk";
import { load, missingBase, norm, type Entry, type ListName } from "./state.ts";

interface Row {
  id: string;
  kind: "entry";
  list: ListName;
  entry: Entry;
}
/** A selectable row that acts instead of editing. */
interface Btn {
  id: string;
  kind: "btn";
  act: "add" | "trust";
  label: string;
}
type Pick = Row | Btn;
type PanelId = "status" | "ips" | "portas";
type Mode = { k: "main" } | { k: "form"; kind: "ip" | "port"; edit?: Row } | { k: "review"; lines: { text: string; tone: Tone }[] } | { k: "busy"; text: string } | { k: "countdown" };

const CHROME = 6;
const WIDE = 100;
// Where an entry came from: the module's base list, the Asterisk config, or added by hand.
const ORIGIN: Record<string, string> = { base: "base", asterisk: "asterisk", manual: "manual" };
// Fixed widths for the short columns; the comment grows and takes the shrink, so a narrow panel only cuts the comment.
const columnsOf = (value: string): ListColumn[] => [
  { id: "origin", title: "origem", width: 8 },
  { id: "value", title: value, width: value === "endereço" ? 18 : 16 },
  { id: "action", title: "ação", width: 8 },
  { id: "comment", title: "comentário", grow: 1 },
];
const IP_COLUMNS = columnsOf("endereço");
const PORT_COLUMNS = columnsOf("porta");
const toneOf = (kind: string): Tone => (kind === "success" ? "ok" : kind === "warning" ? "warn" : kind === "error" ? "error" : kind === "info" ? "info" : "text");

/** The first thing worth saying about a command run. */
const headline = (r: CommandRun): { text: string; tone: Tone } => {
  const l = r.lines.find((x) => x.kind === "error") ?? r.lines.find((x) => x.kind === "success" || x.kind === "warning") ?? r.lines[0];
  return { text: l?.text ?? (r.exit === 0 ? "ok" : `saiu ${r.exit}`), tone: r.exit === 0 ? toneOf(l?.kind ?? "success") : "error" };
};

export function page(sdk: Sdk) {
  const { h, Fragment, Panel, Row: Side, Text, List, Fields, useState, useEffect, useMemo, useRef, useStore, useCommand, useKey, useBack, useNudge, usePanels, useTheme, useViewport, usePageFocused } = sdk.ui;

  function Key({ keys, label, run, help }: { keys: string; label: string; run: () => void; help?: boolean }) {
    useKey(keys, label, run, help ? { help: true } : undefined);
    return null;
  }

  function Lines({ lines, max }: { lines: { text: string; tone?: Tone }[]; max: number }) {
    const room = Math.max(1, max);
    const shown = lines.length > room ? [...lines.slice(0, room - 1), { text: `… +${lines.length - room + 1} mais`, tone: "dim" as Tone }] : lines;
    return <>{shown.map((l, i) => <Text key={i} tone={l.tone}>{l.text}</Text>)}</>;
  }

  /** The first row of a `cap`-row window that keeps `i` visible, moving only when the selection leaves it (so hovering a row never shifts the rows under the mouse). */
  const windowStart = (prev: number, i: number, cap: number, total: number) => Math.max(0, Math.min(i < prev ? i : i >= prev + cap ? i - cap + 1 : prev, total - cap));

  function Countdown({ deadline, onConfirm, onClose }: { deadline: number; onConfirm: () => void; onClose: () => void }) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
      const t = setInterval(() => setNow(Date.now()), 500);
      return () => clearInterval(t);
    }, []);
    const left = Math.max(0, Math.ceil((deadline - now) / 1000));
    useKey("enter", left > 0 ? "confirma" : "fecha", left > 0 ? onConfirm : onClose);
    return (
      <Panel>
        <Panel title="aplicado" tone={left > 0 ? "warn" : "error"}>
          <Text tone="warn" bold>{left > 0 ? "ainda tem acesso? enter confirma" : "tempo esgotado: as regras anteriores estão voltando"}</Text>
          <Text tone={left > 0 ? "text" : "error"}>{left > 0 ? `reversão automática em ${left}s` : "enter fecha e atualiza o status"}</Text>
        </Panel>
      </Panel>
    );
  }

  function Form({ kind, edit, onSubmit, onCancel, onDelete }: { kind: "ip" | "port"; edit?: Row; onSubmit: (v: Record<string, string | boolean>) => void; onCancel: () => void; onDelete: (r: Row) => void }) {
    const ip = kind === "ip";
    const fields = [
      { id: "value", label: ip ? "IP ou CIDR" : "porta ou faixa", kind: "line" as const },
      { id: "comment", label: "comentário", kind: "line" as const },
      { id: "deny", label: "bloquear", kind: "toggle" as const, text: "em vez de aceitar" },
    ];
    // The commands' own parsers, so a bad value is caught before submit.
    const validate = (v: Record<string, string | boolean>) => {
      const toks = String(v.value ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      if (!toks.length) return { value: ip ? "informe o IP ou CIDR" : "informe a porta ou faixa" };
      if (edit && toks.length > 1) return { value: "edite um valor por vez" };
      const bad = toks.find((t) => !norm(ip ? "ipAccept" : "portAccept", t));
      if (bad) return { value: ip ? `IP ou CIDR inválido: ${bad}` : `porta inválida: ${bad}` };
    };
    const initial = edit ? { value: edit.entry.value, comment: edit.entry.comment, deny: edit.list.endsWith("Deny") } : undefined;
    return (
      <Panel>
        <Panel title={edit ? `editar ${edit.entry.value}` : ip ? "adicionar IP" : "adicionar porta"} tone="accent">
          {ip ? null : <Text tone="dim">5060/udp · 10000-20000/tcp · 80 vale tcp e udp</Text>}
          <Fields fields={fields} initial={initial} validate={validate} onSubmit={onSubmit} onCancel={onCancel} onDelete={edit ? () => onDelete(edit) : undefined} />
        </Panel>
      </Panel>
    );
  }

  function Firewall() {
    const store = useStore();
    const nudge = useNudge();
    const { cols, rows } = useViewport();
    // False while the tab bar owns the keys: no panel is drawn focused then (accent, ●, row cursor, marquee).
    const focused = usePageFocused();
    const { c: c0, g } = useTheme();
    const [mode, setMode] = useState<Mode>({ k: "main" });
    const nav = usePanels();
    const [at, setAt] = useState<{ panel: PanelId; inside: boolean }>({ panel: "status", inside: false });
    const [ver, setVer] = useState(0);
    const [sel, setSel] = useState<{ ip?: string; port?: string }>({});
    const [note, setNote] = useState<{ text: string; tone: Tone } | null>(null);
    const [status, setStatus] = useState<{ text: string; tone: Tone }[] | null>(null);
    const [now, setNow] = useState(Date.now());
    // A mouse down bubbles from a button row to its panel: the button marks the hit so the panel's onPress does not undo it.
    const rowHit = useRef(0);
    const top = useRef({ ip: 0, port: 0 });
    const [overBtn, setOverBtn] = useState<string | undefined>(undefined);
    const clickPanel = (panel: PanelId) => () => {
      if (Date.now() - rowHit.current < 100) return void (rowHit.current = 0);
      setAt({ panel, inside: false });
    };

    const cStatus = useCommand("firewall status");
    const cCheck = useCommand("firewall check");
    const cApply = useCommand("firewall apply");
    const cConfirm = useCommand("firewall confirm");
    const cTrust = useCommand("firewall ip trust-phonevox");
    const cIpA = useCommand("firewall ip accept");
    const cIpD = useCommand("firewall ip deny");
    const cIpR = useCommand("firewall ip remove");
    const cPortA = useCommand("firewall port accept");
    const cPortD = useCommand("firewall port deny");
    const cPortR = useCommand("firewall port remove");

    const refreshStatus = async () => {
      const r = await cStatus.run();
      setStatus(r.lines.map((l) => ({ text: l.text, tone: toneOf(l.kind) })));
    };
    useEffect(() => {
      void refreshStatus();
    }, []);

    const pending = store.get<{ deadline: number }>("pending");
    const left = pending ? Math.ceil((pending.deadline - now) / 1000) : 0;
    useEffect(() => {
      if (!pending) return;
      const t = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(t);
    }, [pending?.deadline]);

    const st = useMemo(() => load(store), [ver]);
    const rowOf = (list: ListName) => (e: Entry): Row => ({ id: `${list}:${e.value}`, kind: "entry", list, entry: e });
    const miss = missingBase(st).length > 0;
    // Entries first, then the button rows at the end of the list.
    const ipRows: Pick[] = [
      ...st.ipAccept.map(rowOf("ipAccept")),
      ...st.ipDeny.map(rowOf("ipDeny")),
      { id: "btn:add", kind: "btn", act: "add", label: "+ adicionar IP" },
      ...(miss ? [{ id: "btn:trust", kind: "btn", act: "trust", label: "◆ confiar nos IPs da Phonevox" } as Btn] : []),
    ];
    const portRows: Pick[] = [...st.portAccept.map(rowOf("portAccept")), ...st.portDeny.map(rowOf("portDeny")), { id: "btn:add", kind: "btn", act: "add", label: "+ adicionar porta" }];
    const cur = (rs: Pick[], id?: string) => rs.find((r) => r.id === id) ?? rs[0];

    const after = (r: CommandRun) => {
      setNote(headline(r));
      setVer((v) => v + 1);
      void refreshStatus();
    };
    const byList = { ipAccept: cIpA, ipDeny: cIpD, portAccept: cPortA, portDeny: cPortD };
    const remover = { ipAccept: cIpR, ipDeny: cIpR, portAccept: cPortR, portDeny: cPortR };

    const submit = async (kind: "ip" | "port", edit: Row | undefined, v: Record<string, string | boolean>) => {
      const comment = String(v.comment ?? "").trim();
      // Editing commits the comment as submitted: --replace-comment makes an empty one clear it.
      const args = (value: string, c = comment, replace = false) => [value, ...(c ? ["--comment", c] : []), ...(replace ? ["--replace-comment"] : [])];
      const value = String(v.value ?? "").trim();
      const list: ListName = kind === "ip" ? (v.deny ? "ipDeny" : "ipAccept") : v.deny ? "portDeny" : "portAccept";
      setMode({ k: "main" });
      if (!edit) return after(await byList[list].run({ args: args(value) }));
      const next = norm(list, value) ?? value;
      const key = kind === "ip" ? "ip" : "port";
      if (next === edit.entry.value && list === edit.list) return after(await byList[list].run({ args: args(next, comment, true) }));
      // A new value or list is a remove plus an add; if the add fails the old entry comes back.
      await remover[edit.list].run({ args: [edit.entry.value] });
      const r = await byList[list].run({ args: args(next, comment, true) });
      if (r.exit !== 0 || r.lines.some((l) => l.kind === "error")) await byList[edit.list].run({ args: args(edit.entry.value, edit.entry.comment) });
      else setSel((s) => ({ ...s, [key]: `${list}:${next}` }));
      after(r);
    };

    const review = async () => {
      setMode({ k: "busy", text: "comparando as regras vivas com as listas…" });
      const r = await cCheck.run();
      if (r.exit !== 0) {
        setMode({ k: "main" });
        return setNote(headline(r));
      }
      setMode({ k: "review", lines: r.lines.map((l) => ({ text: l.text, tone: l.text.startsWith("+") ? "ok" : l.text.startsWith("-") ? "error" : toneOf(l.kind) })) });
    };
    const apply = async () => {
      setMode({ k: "busy", text: "aplicando…" });
      const r = await cApply.run(); // destructive: the host asks first
      void refreshStatus();
      setVer((v) => v + 1);
      if (r.exit === 0 && store.get("pending")) return setMode({ k: "countdown" });
      setMode({ k: "main" });
      setNote(headline(r));
    };

    useBack(mode.k === "main" && at.inside ? () => setAt({ panel: at.panel, inside: false }) : undefined);

    const body = Math.max(4, rows - CHROME - 1);
    const wide = cols >= WIDE;
    // One row less than before: the column header takes a line.
    const listCap = Math.max(2, (wide ? body - 8 - 2 : Math.floor((body - 8) / 2) - 2) - 1);

    if (mode.k === "form")
      return <Form kind={mode.kind} edit={mode.edit} onSubmit={(v) => void submit(mode.kind, mode.edit, v)} onCancel={() => setMode({ k: "main" })} onDelete={(r) => { setMode({ k: "main" }); void rm(r); }} />;
    if (mode.k === "busy")
      return <Panel><Text tone="dim">{mode.text}</Text></Panel>;
    if (mode.k === "countdown")
      return (
        <Countdown
          deadline={pending?.deadline ?? 0}
          onConfirm={async () => {
            setMode({ k: "main" });
            after(await cConfirm.run());
          }}
          onClose={() => {
            setMode({ k: "main" });
            after({ exit: 0, lines: [{ kind: "info", text: "reversão automática concluída" }] });
          }}
        />
      );
    if (mode.k === "review")
      return (
        <Panel>
          <Key keys="enter" label="aplica" run={() => void apply()} />
          <Key keys="n" label="cancela" run={() => setMode({ k: "main" })} />
          <Panel title="o que muda" tone="accent">
            <Lines lines={mode.lines} max={body - 4} />
            <Text tone="info">enter aplica (o host confirma e há 60s para confirmar o acesso) · n cancela</Text>
          </Panel>
        </Panel>
      );

    /** The only remove path: `x` and the edit form's [ remover ] both come here. */
    async function rm(r: Row) {
      const rs = r.list.startsWith("ip") ? ipRows : portRows;
      const key = r.list.startsWith("ip") ? "ip" : "port";
      const i = rs.findIndex((x) => x.id === r.id);
      const near = rs[i + 1] ?? rs[i - 1];
      if (near) setSel((s) => ({ ...s, [key]: near.id }));
      after(await remover[r.list].run({ args: [r.entry.value] }));
    }
    const act = async (c: Pick, key: "ip" | "port") => {
      if (c.kind === "entry") return setMode({ k: "form", kind: key, edit: c });
      if (c.act === "add") return setMode({ k: "form", kind: key });
      setSel((s) => ({ ...s, ip: "btn:add" }));
      after(await cTrust.run());
    };
    const movement = (rs: Pick[], key: "ip" | "port", dir: 1 | -1) => {
      const c = cur(rs, sel[key]);
      if (!c) return nudge("nada aqui");
      setSel({ ...sel, [key]: rs[nav.wrap(rs.indexOf(c), dir, rs.length)]!.id }); // ↓ on the last row goes to the first, ↑ on the first to the last
    };
    const listPanel = (n: 2 | 3, id: PanelId, title: string, rs: Pick[], key: "ip" | "port") => {
      const c = cur(rs, sel[key]);
      const here = focused && at.panel === id;
      const start = windowStart(top.current[key], Math.max(0, rs.indexOf(c!)), listCap, rs.length);
      top.current[key] = start;
      const shown = rs.slice(start, start + listCap);
      const entries = rs.filter((r) => r.kind === "entry");
      const items = shown.flatMap((r) => {
        if (r.kind === "btn") return [];
        const deny = r.list.endsWith("Deny");
        return [{
          id: r.id,
          cells: {
            origin: { text: ORIGIN[r.entry.source] ?? "?", tone: "dim" as Tone },
            value: { text: r.entry.value, tone: deny ? ("error" as Tone) : undefined },
            action: { text: deny ? "bloquear" : "aceitar", tone: (deny ? "error" : "accent") as Tone },
            comment: r.entry.comment ?? "",
          },
        }];
      });
      const btns = shown.flatMap((r) => (r.kind === "btn" ? [r] : []));
      const on = here && at.inside;
      const count = !entries.length ? "0" : c?.kind === "entry" ? `${entries.indexOf(c) + 1}/${entries.length}` : `${entries.length}`;
      // Click: focus the panel, go inside, select the row (and press it, for a button). Hover: moves the selection only in the active list, else it just tints.
      const go = (rid: string) => { rowHit.current = Date.now(); setAt({ panel: id, inside: true }); setSel((s) => ({ ...s, [key]: rid })); };
      const hover = (rid: string) => on && setSel((s) => (s[key] === rid ? s : { ...s, [key]: rid }));
      const button = (b: Btn) => {
        const hot = on && c?.id === b.id;
        const tint = !hot && overBtn === `${id}:${b.id}`;
        return h("box", {
          key: b.id, flexShrink: 0, backgroundColor: hot ? c0.selected : tint ? c0.panel : undefined,
          onMouseOver: () => { setOverBtn(`${id}:${b.id}`); hover(b.id); },
          onMouseOut: () => setOverBtn((o) => (o === `${id}:${b.id}` ? undefined : o)),
          onMouseDown: () => { go(b.id); void act(b, key); },
        }, h("text", { wrapMode: "none" }, h("span", { fg: hot ? c0.accent : c0.dim }, hot ? `${g.cursor} ` : tint ? `${g.query} ` : "  "), h("span", { fg: c0.accent }, `  ${b.label}`)));
      };
      return (
        <Panel key={n} title={`[${n}] ${title} ${count}${here ? ` ${g.active}` : ""}`} tone={here ? "accent" : undefined} grow={wide} panelRef={nav.ref(id)} onPress={clickPanel(id)}>
          {items.length ? <List items={items} columns={key === "ip" ? IP_COLUMNS : PORT_COLUMNS} selected={on && c?.kind === "entry" ? c.id : undefined} onPress={(rid) => go(rid)} onHover={(rid) => rid && hover(rid)} /> : entries.length ? null : <Text tone="dim">vazio</Text>}
          {btns.map(button)}
        </Panel>
      );
    };

    const statusLines = [
      ...(status ?? [{ text: "consultando o firewall…", tone: "dim" as Tone }]),
      ...(pending && left > 0 ? [{ text: `reversão automática em ${left}s (firewall confirm)`, tone: "warn" as Tone }] : []),
    ];
    const lists = [listPanel(2, "ips", "IPs", ipRows, "ip"), listPanel(3, "portas", "portas", portRows, "port")];
    const rowsOf = (id: string) => (id === "ips" ? ipRows : id === "portas" ? portRows : []);
    const listKey = at.panel === "ips" ? "ip" : "port";
    // Same two-level rule as Início: the host's `step` says what an arrow or enter does at this level.
    const press = (key: "left" | "right" | "up" | "down" | "enter") => {
      const st = nav.step(at, key, (id) => rowsOf(id).length);
      if (!st) return;
      if (st.bar) return nav.toBar();
      if (st.nudge) return nudge(st.nudge);
      if (st.move) return movement(rowsOf(at.panel), listKey, st.move);
      if (!st.act) setAt({ panel: st.panel as PanelId, inside: st.inside });
    };
    const jump = (panel: PanelId) => setAt({ panel, inside: false });
    const row = cur(rowsOf(at.panel), sel[listKey]);
    // `e` and `x` only mean something on an entry; a button row ignores them.
    const onEntry = (fn: (r: Row) => void) => () => void (row?.kind === "entry" && fn(row));

    return (
      <Panel>
        <Key keys="r" label="atualiza" run={() => void refreshStatus()} />
        <Key keys="A" label="aplica" run={() => void review()} />
        {at.inside ? (
          <>
            {/* Footer-only label: it matches no key, the real arrows below are in `?`. */}
            <Key keys="↑↓" label="item" run={() => {}} />
            <Key keys="↑" label="sobe" run={() => press("up")} help />
            <Key keys="↓" label="desce" run={() => press("down")} help />
            <Key keys="a" label="adiciona" run={() => setMode({ k: "form", kind: listKey })} />
            <Key keys="e" label="editar" run={onEntry((r) => setMode({ k: "form", kind: listKey, edit: r }))} />
            <Key keys="enter" label="ativa" run={() => row && void act(row, listKey)} help />
            <Key keys="x" label="remove" run={onEntry((r) => void rm(r))} />
          </>
        ) : (
          <>
            <Key keys="↑↓←→" label="painel" run={() => {}} />
            <Key keys="←" label="painel" run={() => press("left")} help />
            <Key keys="→" label="painel" run={() => press("right")} help />
            <Key keys="↑" label="painel" run={() => press("up")} help />
            <Key keys="↓" label="painel" run={() => press("down")} help />
            <Key keys="enter" label="entra" run={() => press("enter")} />
            <Key keys="1" label="status" run={() => jump("status")} help />
            <Key keys="2" label="IPs" run={() => jump("ips")} help />
            <Key keys="3" label="portas" run={() => jump("portas")} help />
          </>
        )}
        <Panel title={`[1] status${focused && at.panel === "status" ? ` ${g.active}` : ""}`} tone={focused && at.panel === "status" ? "accent" : undefined} panelRef={nav.ref("status")} onPress={clickPanel("status")}>
          <Lines lines={statusLines} max={6} />
        </Panel>
        {note ? <Text tone={note.tone}>{note.text}</Text> : <Text tone="dim"> </Text>}
        {wide ? <Side>{lists}</Side> : lists}
      </Panel>
    );
  }

  return () => <Firewall />;
}
