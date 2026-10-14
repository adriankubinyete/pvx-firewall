// `ip` and `port` commands: list, accept, deny, remove, and the Phonevox base IPs.
import type { CommandCtx, CommandDef } from "@pvx/sdk";
import { coveredBy, ipv4Of } from "../net.ts";
import { OPPOSITE_LIST, STORE_KEY, actor, addEntry, isIp, load, missingBase, norm, removeEntry, type AddResult, type FwState, type ListName } from "../state.ts";
import { NEEDS_APPLY } from "../texts.ts";

const IP_VALUE_HELP = "IP ou CIDR, separados por vírgula";
const PORT_VALUE_HELP = "porta (5060/udp, 10000-20000/tcp, 80 = tcp e udp), separadas por vírgula";

const ADDED_TEXT: Record<AddResult, (value: string) => string> = {
  added: (value) => `adicionado: ${value}`,
  updated: (value) => `comentário atualizado: ${value}`,
  unchanged: (value) => `já estava na lista: ${value}`,
};

const saveLists = (ctx: CommandCtx, lists: FwState) => ctx.store.set(STORE_KEY.lists, lists);

/** `ip list` / `port list`: one block per list, one line per entry. */
function listCommand(lists: [ListName, string][]): CommandDef {
  return {
    help: "Lista as entradas",
    readonly: true,
    run(ctx) {
      const state = load(ctx.store);
      for (const [list, label] of lists) {
        ctx.out.info(`${label} (${state[list].length})`);
        for (const entry of state[list]) ctx.out.plain(`  ${entry.value.padEnd(20)} [${entry.source}] ${entry.comment}`);
      }
    },
  };
}

function addCommand(list: ListName, help: string): CommandDef {
  return {
    help,
    args: [
      { name: "value", help: isIp(list) ? IP_VALUE_HELP : PORT_VALUE_HELP, kind: "positional", required: true },
      { name: "comment", help: "Comentário", kind: "option" },
    ],
    run(ctx) {
      const state = load(ctx.store);
      const session = list === "ipDeny" ? ipv4Of(ctx.session.sshClient) : undefined;
      let changed = false;
      for (const rawValue of ctx.list("value")) {
        if (addValue(ctx, state, list, rawValue, session)) changed = true;
      }
      if (!changed) return;
      saveLists(ctx, state);
      ctx.out.info(NEEDS_APPLY);
    },
  };
}

/** Validates and adds one value, and says what happened. Returns whether the lists changed. */
function addValue(ctx: CommandCtx, state: FwState, list: ListName, rawValue: string, session?: string): boolean {
  const value = norm(list, rawValue);
  if (!value) {
    ctx.out.error(`${isIp(list) ? "IP/CIDR" : "porta"} inválido: ${rawValue}`);
    return false;
  }
  // Denying the session IP (or a range that holds it) would cut the technician off.
  if (session && coveredBy(session, [value])) {
    ctx.out.error(`recusado: ${value} contém o IP da sua sessão (${session})`);
    return false;
  }
  const result = addEntry(state, list, value, ctx.option("comment") ?? "", "manual", actor());
  ctx.out.success(ADDED_TEXT[result](value));
  const opposite = OPPOSITE_LIST[list];
  if (state[opposite].some((entry) => entry.value === value)) ctx.out.warning(`${value} também está na lista oposta (${opposite}); o bloqueio vence`);
  return result !== "unchanged";
}

/** `ip remove` / `port remove`: takes the value out of both lists of the pair. */
function removeCommand(accept: ListName, deny: ListName): CommandDef {
  return {
    help: "Remove das duas listas (aceitar e bloquear)",
    args: [{ name: "value", help: "Valor a remover", kind: "positional", required: true }],
    run(ctx) {
      const state = load(ctx.store);
      const rawValue = ctx.arg("value") ?? "";
      const value = norm(accept, rawValue) ?? rawValue;
      const removedFrom = removeEntry(state, [accept, deny], value);
      if (!removedFrom.length) {
        ctx.out.warning(`${value} não estava em nenhuma lista`);
        return;
      }
      saveLists(ctx, state);
      ctx.out.success(`removido: ${value}`);
      ctx.out.info(NEEDS_APPLY);
    },
  };
}

const trustPhonevox: CommandDef = {
  help: "Adiciona os IPs base da Phonevox que faltam",
  run(ctx) {
    const state = load(ctx.store);
    const missing = missingBase(state);
    if (!missing.length) {
      ctx.out.success("todos os IPs base já estão cobertos");
      return;
    }
    for (const [value, comment] of missing) addEntry(state, "ipAccept", value, comment, "base", actor());
    saveLists(ctx, state);
    ctx.out.success(`adicionados ${missing.length} IP(s) base: ${missing.map(([value]) => value).join(", ")}`);
    ctx.out.info(NEEDS_APPLY);
  },
};

export const listCommands: Record<string, CommandDef> = {
  "ip list": listCommand([["ipAccept", "IPs aceitos"], ["ipDeny", "IPs bloqueados"]]),
  "ip accept": addCommand("ipAccept", "Aceita IPs (confia neles)"),
  "ip deny": addCommand("ipDeny", "Bloqueia IPs (recusa o IP da sua sessão)"),
  "ip remove": removeCommand("ipAccept", "ipDeny"),
  "ip trust-phonevox": trustPhonevox,
  "port list": listCommand([["portAccept", "Portas liberadas"], ["portDeny", "Portas bloqueadas"]]),
  "port accept": addCommand("portAccept", "Libera portas"),
  "port deny": addCommand("portDeny", "Bloqueia portas (vence a liberação da mesma porta)"),
  "port remove": removeCommand("portAccept", "portDeny"),
};
