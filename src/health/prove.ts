// The three capabilities. Each proof reads as a list of named steps (`proof.firstProblem`): a step answers with a problem or with nothing.
import type { CapabilityDef, Proof, ProofKit, ReadCtx } from "@pvx/sdk";
import { resolveEngine } from "../engines/index.ts";
import { diffRules } from "../engines/rules.ts";
import { STORE_KEY, desiredOf, missingBase, load, type AsteriskReview, type LastApply } from "../state.ts";
import { FIX } from "../texts.ts";
import { bootUnitEnabled, isEngineProblem, readSummary, type Summary } from "./summary.ts";

export function capabilities(proof: ProofKit): CapabilityDef[] {
  return [
    {
      id: "firewall.active",
      title: "Firewall aplicado",
      goal: "Regras aplicadas e start-on-boot habilitado",
      fix: FIX.apply,
      prove: (ctx) => proveActive(proof, ctx),
    },
    {
      id: "firewall.base-ips",
      title: "IPs base da Phonevox",
      goal: "Todos os IPs base estão aceitos",
      fix: FIX.trustPhonevox,
      affects: ["firewall.active"],
      prove: ({ store }) => proveBaseIps(proof, store),
    },
    {
      id: "firewall.asterisk-ips",
      title: "IPs do Asterisk",
      goal: "Os peers públicos do Asterisk foram revisados",
      fix: FIX.trustAsterisk,
      affects: ["firewall.active"],
      optIn: true,
      prove: ({ store }) => proveAsteriskReviewed(proof, store),
    },
  ];
}

// ---- firewall.active ----

async function proveActive(proof: ProofKit, ctx: ReadCtx): Promise<Proof> {
  const summary = await readSummary(ctx);
  const problem = await proof.firstProblem(
    () => pendingConfirmation(proof, summary),
    () => neverApplied(proof, summary),
    () => listsChangedSinceApply(proof, summary),
    () => rulesMissingFromEngine(proof, ctx, summary),
    () => bootNotEnabled(proof, ctx, summary),
  );
  return problem ?? appliedAndVerified(proof, summary);
}

const pendingConfirmation = (proof: ProofKit, { pending }: Summary) => {
  if (pending.state === "pending") return proof.warn(`aplicação aguardando confirmação (${pending.left}s)`, { fix: FIX.confirm });
  if (pending.state === "reverted") return proof.error("a última aplicação foi revertida automaticamente", { fix: FIX.apply });
};

const neverApplied = (proof: ProofKit, { lastApply }: Summary) => {
  if (!lastApply) return proof.warn("o firewall nunca foi aplicado por este módulo", { fix: FIX.apply });
};

const listsChangedSinceApply = (proof: ProofKit, { listsMatchLastApply }: Summary) => {
  if (!listsMatchLastApply) return proof.warn("as listas mudaram desde o último apply", { fix: FIX.apply });
};

/**
 * The record says "applied"; only the engine knows whether the rules are still loaded (an external flush leaves the record
 * intact). So this step probes the live engine.
 */
async function rulesMissingFromEngine(proof: ProofKit, ctx: ReadCtx, { lastApply, lists }: Summary): Promise<Proof | undefined> {
  if (!lastApply) return;
  const resolved = await resolveEngine(ctx.exec, ctx.store);
  if (isEngineProblem(resolved)) return proof.error(resolved.error);
  const { engine, status } = resolved;
  if (!status.active) return noRulesLoaded(proof, engine.id, lastApply);
  const wanted = engine.render(desiredOf(lists, lastApply.failsafe));
  const missing = diffRules(status.rules, wanted).added.length;
  if (missing) return proof.warn(`${engine.id}: faltam ${missing} regra(s) das listas nas regras vivas`, { fix: FIX.apply, evidence: "`firewall check` mostra a diferença" });
}

const noRulesLoaded = (proof: ProofKit, engineId: string, lastApply: LastApply) =>
  proof.error(`${engineId}: nenhuma regra do pvx carregada (as regras foram removidas fora do módulo)`, {
    fix: FIX.apply,
    evidence: `registro do último apply: ${lastApply.rules} regras em ${lastApply.at}`,
  });

async function bootNotEnabled(proof: ProofKit, ctx: ReadCtx, { lastApply }: Summary): Promise<Proof | undefined> {
  if (!lastApply || (await bootUnitEnabled(ctx.fs))) return;
  return proof.warn(`aplicado (${lastApply.engine}, ${lastApply.rules} regras), mas sem start-on-boot`, { fix: FIX.bootEnable });
}

const appliedAndVerified = (proof: ProofKit, { lastApply }: Summary): Proof => {
  const applied = lastApply ? `${lastApply.engine}: ${lastApply.rules} regras aplicadas em ${lastApply.at}` : "regras aplicadas";
  return proof.ok(`${applied}; start-on-boot habilitado`, { evidence: "regras vivas conferidas com as listas" });
};

// ---- firewall.base-ips ----

function proveBaseIps(proof: ProofKit, store: ReadCtx["store"]): Proof {
  const missing = missingBase(load(store));
  if (!missing.length) return proof.ok("todos cobertos");
  return proof.warn(`faltam ${missing.length}: ${missing.map(([value]) => value).join(", ")}`);
}

// ---- firewall.asterisk-ips ----

/** Reads what the last `trust-asterisk` review left; asking the live Asterisk is not a probe this module runs here. */
function proveAsteriskReviewed(proof: ProofKit, store: ReadCtx["store"]): Proof {
  const review = store.get<AsteriskReview>(STORE_KEY.asterisk);
  if (!review) return proof.warn("ainda não revisado");
  if (!review.pending.length) return proof.ok("nada pendente na última revisão");
  return proof.warn(`${review.pending.length} peer(s) públicos sem revisão: ${review.pending.map((peer) => peer.ip).join(", ")}`);
}
