/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// The Firewall tab: [1] status, [2] IPs, [3] portas. Only `sdk.ui`: no React import. Every change is one of the module's
// own commands (useCommand), so it lands in the scrollback, the history and the audit.
import type { CommandRun, Sdk, Tone } from "@pvx/sdk";
import { load, type Entry, type ListName } from "./state.ts";

interface Row {
  id: string;
  list: ListName;
  entry: Entry;
}
type Mode = { k: "main" } | { k: "form"; kind: "ip" | "port"; edit?: Row } | { k: "review"; lines: { text: string; tone: Tone }[] } | { k: "busy"; text: string } | { k: "countdown" };

const CHROME = 6;
const WIDE = 100;
const MARK: Record<string, string> = { base: "B", asterisk: "A", manual: "M" };
const toneOf = (kind: string): Tone => (kind === "success" ? "ok" : kind === "warning" ? "warn" : kind === "error" ? "error" : kind === "info" ? "info" : "text");

/** The first thing worth saying about a command run. */
const headline = (r: CommandRun): { text: string; tone: Tone } => {
  const l = r.lines.find((x) => x.kind === "error") ?? r.lines.find((x) => x.kind === "success" || x.kind === "warning") ?? r.lines[0];
  return { text: l?.text ?? (r.exit === 0 ? "ok" : `saiu ${r.exit}`), tone: r.exit === 0 ? toneOf(l?.kind ?? "success") : "error" };
};

export function page(sdk: Sdk) {
  const { h, Fragment, Panel, Row: Side, Text, List, Fields, useState, useEffect, useMemo, useStore, useCommand, useKey, useNudge, useTheme, useViewport } = sdk.ui;

  function Key({ keys, label, run, help }: { keys: string; label: string; run: () => void; help?: boolean }) {
    useKey(keys, label, run, help ? { help: true } : undefined);
    return null;
  }

  function Lines({ lines, max }: { lines: { text: string; tone?: Tone }[]; max: number }) {
    const room = Math.max(1, max);
    const shown = lines.length > room ? [...lines.slice(0, room - 1), { text: `… +${lines.length - room + 1} mais`, tone: "dim" as Tone }] : lines;
    return <>{shown.map((l, i) => <Text key={i} tone={l.tone}>{l.text}</Text>)}</>;
  }

  /** `cap` rows around the selected one. */
  const windowed = (rows: Row[], sel: string | undefined, cap: number) => {
    const i = Math.max(0, rows.findIndex((r) => r.id === sel));
    const start = Math.max(0, Math.min(i - Math.floor(cap / 2), rows.length - cap));
    return rows.slice(start, start + cap);
  };

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

  function Form({ kind, edit, onSubmit, onCancel }: { kind: "ip" | "port"; edit?: Row; onSubmit: (v: Record<string, string | boolean>) => void; onCancel: () => void }) {
    const fields = edit
      ? [{ id: "comment", label: "comentário", kind: "line" as const }]
      : [
          { id: "value", label: kind === "ip" ? "IP ou CIDR" : "porta (5060/udp, 10000-20000/tcp)", kind: "line" as const },
          { id: "comment", label: "comentário", kind: "line" as const },
          { id: "deny", label: "bloquear em vez de aceitar", kind: "toggle" as const },
        ];
    return (
      <Panel>
        <Panel title={edit ? `comentar ${edit.entry.value}` : kind === "ip" ? "adicionar IP" : "adicionar porta"} tone="accent">
          <Fields fields={fields} initial={edit ? { comment: edit.entry.comment } : undefined} onSubmit={onSubmit} onCancel={onCancel} />
        </Panel>
      </Panel>
    );
  }

  function Firewall() {
    const store = useStore();
    const nudge = useNudge();
    const { cols, rows } = useViewport();
    const { g } = useTheme();
    const [mode, setMode] = useState<Mode>({ k: "main" });
    const [focus, setFocus] = useState<1 | 2 | 3>(1);
    const [ver, setVer] = useState(0);
    const [sel, setSel] = useState<{ ip?: string; port?: string }>({});
    const [note, setNote] = useState<{ text: string; tone: Tone } | null>(null);
    const [status, setStatus] = useState<{ text: string; tone: Tone }[] | null>(null);
    const [now, setNow] = useState(Date.now());

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
    const ipRows: Row[] = [...st.ipAccept.map((e) => ({ id: `ipAccept:${e.value}`, list: "ipAccept" as ListName, entry: e })), ...st.ipDeny.map((e) => ({ id: `ipDeny:${e.value}`, list: "ipDeny" as ListName, entry: e }))];
    const portRows: Row[] = [...st.portAccept.map((e) => ({ id: `portAccept:${e.value}`, list: "portAccept" as ListName, entry: e })), ...st.portDeny.map((e) => ({ id: `portDeny:${e.value}`, list: "portDeny" as ListName, entry: e }))];
    const cur = (rs: Row[], id?: string) => rs.find((r) => r.id === id) ?? rs[0];

    const after = (r: CommandRun) => {
      setNote(headline(r));
      setVer((v) => v + 1);
      void refreshStatus();
    };
    const byList = { ipAccept: cIpA, ipDeny: cIpD, portAccept: cPortA, portDeny: cPortD };
    const remover = { ipAccept: cIpR, ipDeny: cIpR, portAccept: cPortR, portDeny: cPortR };

    const submit = async (kind: "ip" | "port", edit: Row | undefined, v: Record<string, string | boolean>) => {
      const comment = String(v.comment ?? "").trim();
      const args = (value: string) => [value, ...(comment ? ["--comment", comment] : [])];
      if (edit) {
        setMode({ k: "main" });
        return after(await byList[edit.list].run({ args: args(edit.entry.value) }));
      }
      const value = String(v.value ?? "").trim();
      if (!value) return nudge("informe o valor");
      setMode({ k: "main" });
      const list: ListName = kind === "ip" ? (v.deny ? "ipDeny" : "ipAccept") : v.deny ? "portDeny" : "portAccept";
      after(await byList[list].run({ args: args(value) }));
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

    const body = Math.max(4, rows - CHROME - 1);
    const wide = cols >= WIDE;
    const listCap = Math.max(2, wide ? body - 8 - 2 : Math.floor((body - 8) / 2) - 2);

    if (mode.k === "form")
      return <Form kind={mode.kind} edit={mode.edit} onSubmit={(v) => void submit(mode.kind, mode.edit, v)} onCancel={() => setMode({ k: "main" })} />;
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

    const movement = (rs: Row[], key: "ip" | "port", dir: 1 | -1) => {
      const c = cur(rs, sel[key]);
      if (!c) return nudge("nada aqui");
      const i = rs.indexOf(c) + dir;
      if (i < 0) return nudge("início da lista");
      if (i >= rs.length) return nudge("fim da lista");
      setSel({ ...sel, [key]: rs[i]!.id });
    };
    const listPanel = (n: 2 | 3, title: string, rs: Row[], key: "ip" | "port") => {
      const c = cur(rs, sel[key]);
      const items = windowed(rs, c?.id, listCap).map((r) => ({
        id: r.id,
        label: r.entry.value,
        detail: `${r.list.endsWith("Deny") ? "bloqueado" : "aceito"}${r.entry.comment ? ` · ${r.entry.comment}` : ""}`,
        tone: (r.list.endsWith("Deny") ? "error" : undefined) as Tone | undefined,
        mark: { text: MARK[r.entry.source] ?? "?", tone: (r.entry.source === "base" ? "dim" : r.entry.source === "asterisk" ? "info" : "accent") as Tone },
      }));
      return (
        <Panel key={n} title={`[${n}] ${title} ${rs.length ? `${rs.indexOf(c!) + 1}/${rs.length}` : "0"}${focus === n ? ` ${g.active}` : ""}`} tone={focus === n ? "accent" : undefined} grow={wide}>
          {rs.length ? <List items={items} selected={c?.id} /> : <Text tone="dim">vazio</Text>}
        </Panel>
      );
    };

    const statusLines = [
      ...(status ?? [{ text: "consultando o firewall…", tone: "dim" as Tone }]),
      ...(pending && left > 0 ? [{ text: `reversão automática em ${left}s (firewall confirm)`, tone: "warn" as Tone }] : []),
    ];
    const lists = [listPanel(2, "IPs", ipRows, "ip"), listPanel(3, "portas", portRows, "port")];
    const edit = (rs: Row[], key: "ip" | "port") => {
      const c = cur(rs, sel[key]);
      return c ? setMode({ k: "form", kind: key, edit: c }) : nudge("nada aqui");
    };
    const rm = async (rs: Row[], key: "ip" | "port") => {
      const c = cur(rs, sel[key]);
      if (!c) return nudge("nada aqui");
      after(await remover[c.list].run({ args: [c.entry.value] }));
    };

    return (
      <Panel>
        <Key keys="←" label="painel" run={() => (focus === 1 ? nudge("nada aqui") : setFocus((focus - 1) as 1 | 2 | 3))} />
        <Key keys="→" label="painel" run={() => (focus === 3 ? nudge("nada aqui") : setFocus((focus + 1) as 1 | 2 | 3))} help />
        <Key keys="1" label="status" run={() => setFocus(1)} help />
        <Key keys="2" label="IPs" run={() => setFocus(2)} help />
        <Key keys="3" label="portas" run={() => setFocus(3)} help />
        <Key keys="r" label="atualiza" run={() => void refreshStatus()} />
        <Key keys="A" label="aplica" run={() => void review()} />
        {focus !== 1 ? (
          <>
            <Key keys="↑" label="sobe" run={() => movement(focus === 2 ? ipRows : portRows, focus === 2 ? "ip" : "port", -1)} help />
            <Key keys="↓" label="desce" run={() => movement(focus === 2 ? ipRows : portRows, focus === 2 ? "ip" : "port", 1)} help />
            <Key keys="a" label="adiciona" run={() => setMode({ k: "form", kind: focus === 2 ? "ip" : "port" })} />
            <Key keys="x" label="remove" run={() => void rm(focus === 2 ? ipRows : portRows, focus === 2 ? "ip" : "port")} />
            <Key keys="c" label="comenta" run={() => edit(focus === 2 ? ipRows : portRows, focus === 2 ? "ip" : "port")} />
          </>
        ) : null}
        {focus === 2 ? <Key keys="t" label="trust-phonevox" run={async () => after(await cTrust.run())} /> : null}
        <Panel title={`[1] status${focus === 1 ? ` ${g.active}` : ""}`} tone={focus === 1 ? "accent" : undefined}>
          <Lines lines={statusLines} max={6} />
        </Panel>
        {note ? <Text tone={note.tone}>{note.text}</Text> : <Text tone="dim"> </Text>}
        {wide ? <Side>{lists}</Side> : lists}
      </Panel>
    );
  }

  return () => <Firewall />;
}
