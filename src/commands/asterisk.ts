// `ip trust-asterisk`: lists the public IPs of the Asterisk peers and, only with `--accept`, trusts the ones the technician chose.
// A review never writes by itself (not even with `--yes`): a provider trunk shows up here too, so each IP is checked by a person.
import { networkInterfaces } from "node:os";
import type { CommandCtx, CommandDef } from "@pvx/sdk";
import { collect, filterCandidates, type Peer } from "../asterisk.ts";
import { STORE_KEY, actor, addEntry, load, type AsteriskReview, type FwState } from "../state.ts";
import { NEEDS_APPLY } from "../texts.ts";

/** `--accept all` trusts every candidate of the review. */
const ACCEPT_ALL = "all";

/** Public IPv4s of this host, to keep them out of the Asterisk candidates. */
const ownIps = (): string[] =>
  Object.values(networkInterfaces()).flatMap((addresses) => (addresses ?? []).filter((address) => address.family === "IPv4").map((address) => address.address));

/** The candidates the technician asked for with `--accept`: all of them, the listed ones, or none. */
function chosenCandidates(candidates: Peer[], accept: string | undefined, requestedIps: string[]): Peer[] {
  if (!accept) return [];
  if (accept === ACCEPT_ALL) return candidates;
  return candidates.filter((candidate) => requestedIps.includes(candidate.ip));
}

function reportUnknownRequests(ctx: CommandCtx, candidates: Peer[], requestedIps: string[]): void {
  for (const ip of requestedIps) {
    if (!candidates.some((candidate) => candidate.ip === ip)) ctx.out.error(`${ip} não é um candidato desta revisão`);
  }
}

const saveReview = (ctx: CommandCtx, notAccepted: Peer[]) => ctx.store.set(STORE_KEY.asterisk, { at: Date.now(), pending: notAccepted } satisfies AsteriskReview);

function reportOutcome(ctx: CommandCtx, review: { candidates: Peer[]; chosen: Peer[]; skippedCount: number }): void {
  const { candidates, chosen, skippedCount } = review;
  if (!candidates.length) {
    ctx.out.success(`nenhum IP público novo no Asterisk (${skippedCount} ignorado(s): privados, do host ou já confiáveis)`);
    return;
  }
  if (chosen.length) {
    ctx.out.success(`confiando em ${chosen.length} IP(s): ${chosen.map((candidate) => `${candidate.ip} (${candidate.peer})`).join(", ")}`);
    ctx.out.info(NEEDS_APPLY);
    return;
  }
  ctx.out.warning(`${candidates.length} candidato(s); nada foi gravado. Um trunk de provedor também aparece aqui: confira cada um.`);
  for (const candidate of candidates) ctx.out.plain(`  ${candidate.ip.padEnd(16)} ${candidate.peer}`);
  ctx.out.info("para confiar: firewall ip trust-asterisk --accept all   (ou --accept ip1,ip2)");
}

const trustAsterisk: CommandDef = {
  help: "Revisa os IPs públicos dos peers do Asterisk; só grava com --accept",
  args: [{ name: "accept", help: "`all` ou IPs separados por vírgula, depois de revisar a lista", kind: "option" }],
  async run(ctx) {
    const { peers, asterisk } = await collect(ctx.exec);
    if (!asterisk) {
      saveReview(ctx, []);
      ctx.out.warning("asterisk não encontrado neste host: nada a revisar");
      return;
    }
    const state: FwState = load(ctx.store);
    const { candidates, skipped } = filterCandidates(peers, ownIps(), state.ipAccept.map((entry) => entry.value));
    const accept = ctx.option("accept");
    const requestedIps = accept === ACCEPT_ALL ? [] : ctx.list("accept");
    const chosen = chosenCandidates(candidates, accept, requestedIps);

    reportUnknownRequests(ctx, candidates, requestedIps);
    for (const candidate of chosen) addEntry(state, "ipAccept", candidate.ip, `asterisk: ${candidate.peer}`, "asterisk", actor());
    if (chosen.length) ctx.store.set(STORE_KEY.lists, state);
    saveReview(ctx, candidates.filter((candidate) => !chosen.includes(candidate)));
    reportOutcome(ctx, { candidates, chosen, skippedCount: skipped.length });
  },
};

export const asteriskCommands: Record<string, CommandDef> = { "ip trust-asterisk": trustAsterisk };
