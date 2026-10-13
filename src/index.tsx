// pvx module `firewall`. The factory only builds the object: every effect happens inside run(), prove() or a query.
// All process execution goes through ctx.exec, so the trust review has nothing to warn about.
import type { CommandCtx, CommandDef, ModuleFactory, Proof, ReadCtx } from "@pvx/sdk";
import { networkInterfaces } from "node:os";
import { applyFlow, detectSession } from "./apply.ts";
import { collect, filterCandidates } from "./asterisk.ts";
import { BOOT_ARGS, DEFAULT_BIN, UNIT_NAME, unitText } from "./boot.ts";
import { ENGINES, SETTINGS, pickEngine, type EngineSetting } from "./engines/index.ts";
import type { Engine, Io } from "./engines/types.ts";
import { coveredBy } from "./net.ts";
import { page } from "./page.tsx";
import { ROLLBACK_SECONDS, cancel, pendingInfo, paths, stateDir } from "./rollback.ts";
import { actor, addEntry, deniedBy, desiredOf, isIp, keyOf, load, missingBase, norm, removeEntry, type FwState, type ListName } from "./state.ts";

const str = (ctx: CommandCtx, name: string) => (typeof ctx.args[name] === "string" ? (ctx.args[name] as string) : undefined);
const flag = (ctx: CommandCtx, name: string) => ctx.args[name] === true;
const ioOf = (ctx: CommandCtx): Io => ({ exec: ctx.exec, fs: ctx.fs, zone: ctx.store.get<string>("zone") });

/** The engine to drive, or an error line already printed. */
async function engineOf(ctx: CommandCtx): Promise<{ engine: Engine; io: Io; auto: boolean; status: Awaited<ReturnType<Engine["status"]>> } | undefined> {
  const io = ioOf(ctx);
  const picked = await pickEngine(ctx.exec, ctx.store.get<EngineSetting>("engine") ?? "auto");
  if ("error" in picked) return void ctx.out.error(picked.error);
  const status = await picked.engine.status(io);
  if (!status.available) return void ctx.out.error(`engine indisponível: ${picked.engine.id} (${status.reason ?? "?"})`);
  return { engine: picked.engine, io, auto: picked.auto, status };
}

/** Line diff of loaded rules against wanted ones. */
export const diffRules = (cur: string[], want: string[]) => ({
  added: want.filter((r) => !cur.includes(r)),
  removed: cur.filter((r) => !want.includes(r)),
});

const NEEDS_APPLY = "a lista mudou, mas só vale depois de `firewall apply`";

const listCmd = (lists: [ListName, string][]): CommandDef => ({
  help: "Lista as entradas",
  readonly: true,
  run(ctx) {
    const st = load(ctx.store);
    for (const [l, label] of lists) {
      ctx.out.info(`${label} (${st[l].length})`);
      for (const e of st[l]) ctx.out.plain(`  ${e.value.padEnd(20)} [${e.source}] ${e.comment}`);
    }
  },
});

const addCmd = (list: ListName, help: string): CommandDef => ({
  help,
  args: [
    { name: "value", help: isIp(list) ? "IP ou CIDR, separados por vírgula" : "porta (5060/udp, 10000-20000/tcp, 80 = tcp e udp), separadas por vírgula", kind: "positional", required: true },
    { name: "comment", help: "Comentário", kind: "option" },
  ],
  async run(ctx) {
    const st = load(ctx.store);
    const session = list === "ipDeny" ? await detectSession(ctx.exec) : undefined;
    const opposite: ListName = list === "ipAccept" ? "ipDeny" : list === "ipDeny" ? "ipAccept" : list === "portAccept" ? "portDeny" : "portAccept";
    let changed = false;
    for (const raw of (str(ctx, "value") ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const v = norm(list, raw);
      if (!v) {
        ctx.out.error(`${isIp(list) ? "IP/CIDR" : "porta"} inválido: ${raw}`);
        continue;
      }
      if (session && coveredBy(session, [v])) {
        ctx.out.error(`recusado: ${v} contém o IP da sua sessão (${session})`);
        continue;
      }
      const r = addEntry(st, list, v, str(ctx, "comment") ?? "", "manual", actor());
      if (r !== "unchanged") changed = true;
      ctx.out.success(r === "added" ? `adicionado: ${v}` : r === "updated" ? `comentário atualizado: ${v}` : `já estava na lista: ${v}`);
      if (st[opposite].some((e) => e.value === v)) ctx.out.warning(`${v} também está na lista oposta (${opposite}); o bloqueio vence`);
    }
    if (changed) {
      ctx.store.set("state", st);
      ctx.out.info(NEEDS_APPLY);
    }
  },
});

const removeCmd = (a: ListName, b: ListName): CommandDef => ({
  help: "Remove das duas listas (aceitar e bloquear)",
  args: [{ name: "value", help: "Valor a remover", kind: "positional", required: true }],
  run(ctx) {
    const st = load(ctx.store);
    const raw = str(ctx, "value") ?? "";
    const v = norm(a, raw) ?? raw;
    const hit = removeEntry(st, [a, b], v);
    if (!hit.length) return ctx.out.warning(`${v} não estava em nenhuma lista`);
    ctx.store.set("state", st);
    ctx.out.success(`removido: ${v}`);
    ctx.out.info(NEEDS_APPLY);
  },
});

/** Public IPv4s of this host, to keep them out of the Asterisk candidates. */
const ownIps = (): string[] =>
  Object.values(networkInterfaces()).flatMap((l) => (l ?? []).filter((i) => i.family === "IPv4").map((i) => i.address));

export const factory: ModuleFactory = (sdk) => {
  const bootOn = (fs: ReadCtx["fs"]) => fs.exists(`/etc/systemd/system/multi-user.target.wants/${UNIT_NAME}`).catch(() => false);

  /** What the capabilities, the queries and the widgets share: the store and the files, never the live engine (that one is probed by `firewall.active` only). */
  const summary = async ({ store, fs }: Pick<ReadCtx, "store" | "fs">) => {
    const st: FwState = load(store);
    const last = store.get<{ at: string; engine: string; key: string; rules: number; failsafe?: string }>("lastApply");
    const pend = await pendingInfo(fs, store);
    return { st, last, pend, current: !!last && last.key === keyOf(st), engineSetting: store.get<string>("engine") ?? "auto", missing: missingBase(st) };
  };

  const proveActive = async (ctx: ReadCtx): Promise<Proof> => {
    const { store, fs } = ctx;
    const s = await summary(ctx);
    if (s.pend.state === "pending") return { level: "warn", text: `aplicação aguardando confirmação (${s.pend.left}s)`, fix: "firewall confirm" };
    if (s.pend.state === "reverted") return { level: "error", text: "a última aplicação foi revertida automaticamente", fix: "firewall apply" };
    if (!s.last) return { level: "warn", text: "o firewall nunca foi aplicado por este módulo", fix: "firewall apply" };
    if (!s.current) return { level: "warn", text: "as listas mudaram desde o último apply", fix: "firewall apply" };
    // The record says "applied"; only the engine knows whether the rules are still loaded (an external flush leaves the record intact).
    const picked = await pickEngine(ctx.exec, store.get<EngineSetting>("engine") ?? "auto");
    if ("error" in picked) return { level: "error", text: picked.error };
    const live = await picked.engine.status({ exec: ctx.exec, zone: store.get<string>("zone") });
    if (!live.available) return { level: "error", text: `engine indisponível: ${picked.engine.id} (${live.reason ?? "?"})` };
    if (!live.active) return { level: "error", text: `${picked.engine.id}: nenhuma regra do pvx carregada (as regras foram removidas fora do módulo)`, fix: "firewall apply", evidence: `registro do último apply: ${s.last.rules} regras em ${s.last.at}` };
    const gone = diffRules(live.rules, picked.engine.render(desiredOf(s.st, s.last.failsafe))).added.length;
    if (gone) return { level: "warn", text: `${picked.engine.id}: faltam ${gone} regra(s) das listas nas regras vivas`, fix: "firewall apply", evidence: "`firewall check` mostra a diferença" };
    if (!(await bootOn(fs))) return { level: "warn", text: `aplicado (${s.last.engine}, ${s.last.rules} regras), mas sem start-on-boot`, fix: "firewall boot enable" };
    return { level: "ok", text: `${s.last.engine}: ${s.last.rules} regras aplicadas em ${s.last.at}; start-on-boot habilitado`, evidence: "regras vivas conferidas com as listas" };
  };

  return {
    commands: {
      status: {
        help: "Mostra o estado vivo do firewall",
        readonly: true,
        async run(ctx) {
          const e = await engineOf(ctx);
          if (!e) return;
          const st = load(ctx.store);
          const last = ctx.store.get<{ at: string; by: string; failsafe?: string }>("lastApply");
          const want = e.engine.render(desiredOf(st, last?.failsafe));
          const n = e.status.rules.length;
          const line = `status: ${e.status.active ? "ATIVO" : "INATIVO"}  ${n}/${want.length} regra(s)`;
          e.status.active ? ctx.out.success(line) : ctx.out.warning(line);
          ctx.out.plain(`engine: ${e.engine.id}${e.auto ? " (auto)" : ""}`);
          ctx.out.plain(`boot: ${(await e.engine.bootStatus(e.io)) === "enabled" ? "habilitado" : "desabilitado"}`);
          ctx.out.plain(`sessão: ${(await detectSession(ctx.exec)) ?? "desconhecida"}`);
          const p = await pendingInfo(ctx.fs, ctx.store);
          ctx.out.plain(`reversão: ${p.state === "pending" ? `pendente, ${p.left}s` : p.state === "reverted" ? "ocorreu (regras anteriores voltaram)" : p.state === "expired" ? "atrasada (o job não disparou)" : "nenhuma"}`);
          ctx.out.plain(`último apply: ${last ? `${last.at} por ${last.by}` : "nunca"}`);
        },
      },
      check: {
        help: "Compara as regras vivas com as listas (o que um apply mudaria)",
        readonly: true,
        async run(ctx) {
          const e = await engineOf(ctx);
          if (!e) return;
          const st = load(ctx.store);
          const session = await detectSession(ctx.exec);
          const d = diffRules(e.status.rules, e.engine.render(desiredOf(st, session)));
          const miss = missingBase(st);
          if (miss.length) ctx.out.warning(`faltam ${miss.length} IP(s) base da Phonevox: ${miss.map(([v]) => v).join(", ")} (firewall ip trust-phonevox)`);
          if (!session) ctx.out.warning("IP da sessão desconhecido: o apply exigirá --force");
          if (!d.added.length && !d.removed.length) return ctx.out.success("as regras vivas batem com as listas");
          ctx.out.warning(`um apply adicionaria ${d.added.length} e removeria ${d.removed.length} regra(s)`);
          for (const r of d.removed) ctx.out.plain(`- ${r}`);
          for (const r of d.added) ctx.out.plain(`+ ${r}`);
        },
      },
      apply: {
        help: `Aplica as listas; reverte sozinho em ${ROLLBACK_SECONDS}s se você não rodar firewall confirm`,
        destructive: true,
        args: [
          { name: "force", help: "Aplica mesmo sem IP de sessão (sem failsafe)", kind: "flag" },
          { name: "no-rollback", help: "Não agenda a reversão automática", kind: "flag" },
        ],
        async run(ctx) {
          const e = await engineOf(ctx);
          if (!e) return;
          const r = await applyFlow(e.engine, e.io, ctx.store, { force: flag(ctx, "force"), noRollback: flag(ctx, "no-rollback") });
          if (!r.ok) return ctx.out.error(r.error);
          ctx.out.success(`aplicado (${e.engine.id}): ${r.rules} regras${r.failsafe ? `, failsafe ${r.failsafe}` : ", sem failsafe"}`);
          if (r.scheduled) ctx.out.warning(`reversão automática em ${ROLLBACK_SECONDS}s (${r.scheduled}); ainda tem acesso? rode: firewall confirm`);
        },
      },
      confirm: {
        help: "Confirma o último apply e cancela a reversão automática",
        async run(ctx) {
          const p = await pendingInfo(ctx.fs, ctx.store);
          if (p.state === "none") return ctx.out.success("nada pendente");
          if (p.state === "reverted") {
            ctx.store.delete("pending");
            ctx.store.delete("lastApply");
            return ctx.out.warning("a reversão automática já aconteceu: as regras anteriores voltaram");
          }
          await cancel(ctx.exec, ctx.fs);
          ctx.store.delete("pending");
          ctx.out.success("apply confirmado; reversão cancelada");
        },
      },
      revert: {
        help: "Volta às regras de antes do último apply",
        destructive: true,
        async run(ctx) {
          const e = await engineOf(ctx);
          if (!e) return;
          if (!(await ctx.fs.exists(paths().script))) return ctx.out.error("não há snapshot guardado");
          await e.engine.restore(e.io, paths().script);
          await cancel(ctx.exec, ctx.fs);
          ctx.store.delete("pending");
          ctx.store.delete("lastApply");
          ctx.out.success("regras anteriores restauradas");
        },
      },
      engine: {
        help: "Mostra ou define o engine (auto, firewalld, nftables, iptables)",
        args: [
          { name: "name", help: "Engine", kind: "positional", values: [...SETTINGS] },
          { name: "zone", help: "Zona do firewalld (padrão pvxfw)", kind: "option" },
        ],
        async run(ctx) {
          const name = str(ctx, "name");
          if (name && !(SETTINGS as readonly string[]).includes(name)) return ctx.out.error(`engine inválido: ${name} (use ${SETTINGS.join(", ")})`);
          if (name) ctx.store.set("engine", name);
          if (str(ctx, "zone")) ctx.store.set("zone", str(ctx, "zone"));
          const set = ctx.store.get<EngineSetting>("engine") ?? "auto";
          const picked = await pickEngine(ctx.exec, set);
          ctx.out.success(`engine: ${set}${"engine" in picked ? ` -> ${picked.engine.id}` : ` (${picked.error})`}`);
        },
      },
      "ip list": listCmd([["ipAccept", "IPs aceitos"], ["ipDeny", "IPs bloqueados"]]),
      "ip accept": addCmd("ipAccept", "Aceita IPs (confia neles)"),
      "ip deny": addCmd("ipDeny", "Bloqueia IPs (recusa o IP da sua sessão)"),
      "ip remove": removeCmd("ipAccept", "ipDeny"),
      "ip trust-phonevox": {
        help: "Adiciona os IPs base da Phonevox que faltam",
        run(ctx) {
          const st = load(ctx.store);
          const miss = missingBase(st);
          if (!miss.length) return ctx.out.success("todos os IPs base já estão cobertos");
          for (const [v, c] of miss) addEntry(st, "ipAccept", v, c, "base", actor());
          ctx.store.set("state", st);
          ctx.out.success(`adicionados ${miss.length} IP(s) base: ${miss.map(([v]) => v).join(", ")}`);
          ctx.out.info(NEEDS_APPLY);
        },
      },
      "ip trust-asterisk": {
        help: "Revisa os IPs públicos dos peers do Asterisk; só grava com --accept",
        args: [{ name: "accept", help: "`all` ou IPs separados por vírgula, depois de revisar a lista", kind: "option" }],
        async run(ctx) {
          const { peers, asterisk } = await collect(ctx.exec);
          if (!asterisk) {
            ctx.store.set("asterisk", { at: Date.now(), pending: [] });
            return ctx.out.warning("asterisk não encontrado neste host: nada a revisar");
          }
          const st = load(ctx.store);
          const { candidates, skipped } = filterCandidates(peers, ownIps(), st.ipAccept.map((e) => e.value));
          const accept = str(ctx, "accept");
          const chosen = !accept ? [] : accept === "all" ? candidates : candidates.filter((c) => accept.split(",").map((s) => s.trim()).includes(c.ip));
          if (accept && accept !== "all") for (const ip of accept.split(",").map((s) => s.trim())) if (!candidates.some((c) => c.ip === ip)) ctx.out.error(`${ip} não é um candidato desta revisão`);
          for (const c of chosen) addEntry(st, "ipAccept", c.ip, `asterisk: ${c.peer}`, "asterisk", actor());
          if (chosen.length) ctx.store.set("state", st);
          ctx.store.set("asterisk", { at: Date.now(), pending: candidates.filter((c) => !chosen.includes(c)) });
          if (!candidates.length) return ctx.out.success(`nenhum IP público novo no Asterisk (${skipped.length} ignorado(s): privados, do host ou já confiáveis)`);
          if (chosen.length) {
            ctx.out.success(`confiando em ${chosen.length} IP(s): ${chosen.map((c) => `${c.ip} (${c.peer})`).join(", ")}`);
            return ctx.out.info(NEEDS_APPLY);
          }
          ctx.out.warning(`${candidates.length} candidato(s); nada foi gravado. Um trunk de provedor também aparece aqui: confira cada um.`);
          for (const c of candidates) ctx.out.plain(`  ${c.ip.padEnd(16)} ${c.peer}`);
          ctx.out.info("para confiar: firewall ip trust-asterisk --accept all   (ou --accept ip1,ip2)");
        },
      },
      "port list": listCmd([["portAccept", "Portas liberadas"], ["portDeny", "Portas bloqueadas"]]),
      "port accept": addCmd("portAccept", "Libera portas"),
      "port deny": addCmd("portDeny", "Bloqueia portas (vence a liberação da mesma porta)"),
      "port remove": removeCmd("portAccept", "portDeny"),
      "boot enable": {
        help: "Instala e habilita a unit systemd que reaplica as listas no boot",
        destructive: true,
        args: [
          { name: "dry-run", help: "Só mostra a unit", kind: "flag" },
          { name: "pvx-bin", help: `Caminho do pvx (padrão ${DEFAULT_BIN})`, kind: "option" },
        ],
        async run(ctx) {
          const bin = str(ctx, "pvx-bin") ?? DEFAULT_BIN;
          const picked = await pickEngine(ctx.exec, ctx.store.get<EngineSetting>("engine") ?? "auto");
          const engine = "engine" in picked ? picked.engine : ENGINES.nftables;
          if (flag(ctx, "dry-run")) return unitText(bin, engine.id).split("\n").forEach((l) => ctx.out.plain(l));
          await engine.bootEnable(ioOf(ctx), bin);
          ctx.out.success(`start-on-boot habilitado (${UNIT_NAME}: ${bin} ${BOOT_ARGS.join(" ")})`);
        },
      },
      "boot disable": {
        help: "Desabilita e remove a unit de boot",
        destructive: true,
        async run(ctx) {
          await ENGINES.nftables.bootDisable(ioOf(ctx));
          ctx.out.success("start-on-boot desabilitado");
        },
      },
      "boot status": {
        help: "Diz se a unit de boot está habilitada",
        readonly: true,
        async run(ctx) {
          const s = await ENGINES.nftables.bootStatus(ioOf(ctx));
          s === "enabled" ? ctx.out.success("start-on-boot habilitado") : ctx.out.warning("start-on-boot desabilitado");
        },
      },
    },
    capabilities: [
      {
        id: "firewall.active",
        title: "Firewall aplicado",
        goal: "Regras aplicadas e start-on-boot habilitado",
        fix: "firewall apply",
        prove: proveActive,
      },
      {
        id: "firewall.base-ips",
        title: "IPs base da Phonevox",
        goal: "Todos os IPs base estão aceitos",
        fix: "firewall ip trust-phonevox",
        affects: ["firewall.active"],
        prove: ({ store }) => {
          const miss = missingBase(load(store));
          return miss.length ? { level: "warn", text: `faltam ${miss.length}: ${miss.map(([v]) => v).join(", ")}` } : { level: "ok", text: "todos cobertos" };
        },
      },
      {
        id: "firewall.asterisk-ips",
        title: "IPs do Asterisk",
        goal: "Os peers públicos do Asterisk foram revisados",
        fix: "firewall ip trust-asterisk",
        affects: ["firewall.active"],
        optIn: true,
        // Reads what the last `trust-asterisk` review left; asking the live Asterisk is not a probe this module runs here.
        prove: ({ store }) => {
          const a = store.get<{ pending: { ip: string; peer: string }[] }>("asterisk");
          if (!a) return { level: "warn", text: "ainda não revisado" };
          return a.pending.length ? { level: "warn", text: `${a.pending.length} peer(s) públicos sem revisão: ${a.pending.map((p) => p.ip).join(", ")}` } : { level: "ok", text: "nada pendente na última revisão" };
        },
      },
    ],
    queries: {
      "firewall.missingBaseIps": function () {
        return missingBase(load(this.store)).map(([ip, comment]) => ({ ip, comment }));
      },
      "firewall.status": async function () {
        const s = await summary(this);
        return { engine: s.last?.engine ?? s.engineSetting, applied: s.last ?? null, current: s.current, pending: s.pend, missingBaseIps: s.missing.map(([ip]) => ip), boot: await bootOn(this.fs) };
      },
    },
    widgets: {
      chip: {
        slot: "home.chips",
        priority: 30,
        refreshMs: 15000,
        data: async (ctx) => {
          const s = await summary(ctx);
          const eng = s.last?.engine ?? s.engineSetting;
          if (!s.last) return [{ label: `firewall · ${eng} · não aplicado`, level: "warn" as const }];
          const level = s.pend.state === "reverted" ? ("error" as const) : s.pend.state !== "none" || !s.current ? ("warn" as const) : ("ok" as const);
          return [{ label: `firewall · ${eng} · ${s.last.rules} regras`, level, detail: s.pend.state === "pending" ? "aguardando confirmação" : !s.current ? "listas mudaram" : undefined }];
        },
      },
      atencao: {
        slot: "home.attention",
        priority: 30,
        refreshMs: 15000,
        data: async (ctx) => {
          const s = await summary(ctx);
          return [
            ...(s.missing.length ? [{ level: "warn" as const, title: `firewall: faltam ${s.missing.length} IP(s) base da Phonevox`, fix: "firewall ip trust-phonevox" }] : []),
            ...(s.pend.state === "pending" ? [{ level: "warn" as const, title: `firewall: reversão automática em ${s.pend.left}s`, fix: "firewall confirm" }] : []),
          ];
        },
      },
    },
    pages: {
      firewall: { title: "Firewall", render: page(sdk), tab: { label: "Firewall", order: 30 } },
    },
  };
};
export default factory;
