// `status`, `check`, `apply`, `confirm`, `revert`: reading the firewall and putting the lists on it.
// The flow of an apply (snapshot, failsafe, scheduled revert, load, verify) is in ../apply.ts.
import type { CommandCtx, CommandDef, ErrorsKit } from "@pvx/sdk";
import { applyFlow } from "../apply.ts";
import { isEngineProblem, readDiff, readLiveStatus, type DiffView, type LiveStatus } from "../health/summary.ts";
import { ipToInt, ipv4Of } from "../net.ts";
import { ROLLBACK_SECONDS, cancel, describePending, paths, pendingInfo } from "../rollback.ts";
import { clearApplyState, clearPending } from "../state.ts";
import { FIX } from "../texts.ts";
import { engineOrReport, runOrReport } from "./context.ts";

// ---- status ----

function reportStatus(ctx: CommandCtx, status: LiveStatus): void {
  const summary = `status: ${status.active ? "ATIVO" : "INATIVO"}  ${status.loadedRules}/${status.wantedRules} regra(s)`;
  if (status.active) ctx.out.success(summary);
  else ctx.out.warning(summary);
  ctx.out.plain(`engine: ${status.engine}${status.auto ? " (auto)" : ""}`);
  ctx.out.plain(`boot: ${status.boot === "enabled" ? "habilitado" : "desabilitado"}`);
  ctx.out.plain(`sessão: ${status.session ?? "desconhecida"}`);
  ctx.out.plain(`reversão: ${describePending(status.pending)}`);
  ctx.out.plain(`último apply: ${status.lastApply ? `${status.lastApply.at} por ${status.lastApply.by}` : "nunca"}`);
}

const status: CommandDef = {
  help: "Mostra o estado vivo do firewall",
  readonly: true,
  async run(ctx) {
    const live = await readLiveStatus(ctx);
    if (isEngineProblem(live)) {
      ctx.out.error(live.error);
      return;
    }
    reportStatus(ctx, live);
  },
};

// ---- check ----

function reportDiff(ctx: CommandCtx, diff: DiffView): void {
  if (diff.missingBaseIps.length) ctx.out.warning(`faltam ${diff.missingBaseIps.length} IP(s) base da Phonevox: ${diff.missingBaseIps.join(", ")} (${FIX.trustPhonevox})`);
  if (!diff.session) ctx.out.warning("IP da sessão desconhecido: o apply exigirá --failsafe-ip <ip> ou --force");
  if (!diff.added.length && !diff.removed.length) {
    ctx.out.success("as regras vivas batem com as listas");
    return;
  }
  ctx.out.warning(`um apply adicionaria ${diff.added.length} e removeria ${diff.removed.length} regra(s)`);
  for (const rule of diff.removed) ctx.out.plain(`- ${rule}`);
  for (const rule of diff.added) ctx.out.plain(`+ ${rule}`);
}

const check: CommandDef = {
  help: "Compara as regras vivas com as listas (o que um apply mudaria)",
  readonly: true,
  async run(ctx) {
    const diff = await readDiff(ctx);
    if (isEngineProblem(diff)) {
      ctx.out.error(diff.error);
      return;
    }
    reportDiff(ctx, diff);
  },
};

// ---- apply ----

/** The text of `--failsafe-ip` is not an IPv4 (a range would open the whole network, so only one address is accepted). */
const invalidFailsafeIp = (given: string | undefined): given is string => given !== undefined && ipToInt(given) === undefined;

const apply = (errors: ErrorsKit): CommandDef => ({
  help: `Aplica as listas; reverte sozinho em ${ROLLBACK_SECONDS}s se você não rodar ${FIX.confirm}`,
  destructive: true,
  args: [
    { name: "force", help: "Aplica mesmo sem IP de sessão (sem failsafe)", kind: "flag" },
    { name: "failsafe-ip", help: "IP que fica liberado como failsafe (padrão: o IP da sessão SSH)", kind: "option" },
    { name: "no-rollback", help: "Não agenda a reversão automática", kind: "flag" },
  ],
  async run(ctx) {
    const given = ctx.option("failsafe-ip");
    if (invalidFailsafeIp(given)) {
      ctx.out.error(`IP inválido em --failsafe-ip: ${given}`);
      return;
    }
    const drivable = await engineOrReport(ctx);
    if (!drivable) return;
    const failsafe = given ?? ipv4Of(ctx.session.sshClient);
    const result = await applyFlow(drivable.engine, drivable.io, ctx.store, {
      failsafe,
      describeFailure: errors.describeFailure,
      force: ctx.flag("force"),
      noRollback: ctx.flag("no-rollback"),
    });
    if (!result.ok) {
      ctx.out.error(result.error);
      return;
    }
    ctx.out.success(`aplicado (${drivable.engine.id}): ${result.rules} regras${result.failsafe ? `, failsafe ${result.failsafe}` : ", sem failsafe"}`);
    if (result.scheduled) ctx.out.warning(`reversão automática em ${ROLLBACK_SECONDS}s (${result.scheduled}); ainda tem acesso? rode: ${FIX.confirm}`);
  },
});

// ---- confirm ----

const confirm: CommandDef = {
  help: "Confirma o último apply e cancela a reversão automática",
  async run(ctx) {
    const pending = await pendingInfo(ctx.fs, ctx.store);
    if (pending.state === "none") {
      ctx.out.success("nada pendente");
      return;
    }
    if (pending.state === "reverted") {
      // The rules `lastApply` describes are gone: forget it too.
      clearApplyState(ctx.store);
      ctx.out.warning("a reversão automática já aconteceu: as regras anteriores voltaram");
      return;
    }
    await cancel(ctx.shell, ctx.fs);
    clearPending(ctx.store);
    ctx.out.success("apply confirmado; reversão cancelada");
  },
};

// ---- revert ----

const revert = (errors: ErrorsKit): CommandDef => ({
  help: "Volta às regras de antes do último apply",
  destructive: true,
  async run(ctx) {
    const drivable = await engineOrReport(ctx);
    if (!drivable) return;
    const { script } = paths();
    if (!(await ctx.fs.exists(script))) {
      ctx.out.error("não há snapshot guardado");
      return;
    }
    if (!(await runOrReport(ctx, errors, () => drivable.engine.restore(drivable.io, script)))) return;
    await cancel(ctx.shell, ctx.fs);
    clearApplyState(ctx.store);
    ctx.out.success("regras anteriores restauradas");
  },
});

export const applyCommands = (errors: ErrorsKit): Record<string, CommandDef> => ({ status, check, apply: apply(errors), confirm, revert: revert(errors) });
