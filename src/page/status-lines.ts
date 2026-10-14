// The text of the status panel, from the `firewall.status` query. Pure.
import type { Tone } from "@pvx/sdk";
import type { StatusView } from "../health/queries.ts";
import { isEngineProblem } from "../health/summary.ts";
import { describePending } from "../rollback.ts";

export interface StatusLine {
  text: string;
  tone: Tone;
}

/** `STATUS_LINES` (layout.ts) lines, or one error line when the engine cannot be driven. */
export function statusLines(view: StatusView): StatusLine[] {
  const { live } = view;
  if (isEngineProblem(live)) return [{ text: live.error, tone: "error" }];
  const verdict = live.active ? "ATIVO" : "INATIVO";
  const lastApply = live.lastApply ? `${live.lastApply.at} por ${live.lastApply.by}` : "nunca";
  return [
    { text: `status: ${verdict}  ${live.loadedRules}/${live.wantedRules} regra(s)`, tone: live.active ? "ok" : "warn" },
    { text: `engine: ${live.engine}${live.auto ? " (auto)" : ""} · boot: ${live.boot === "enabled" ? "habilitado" : "desabilitado"}`, tone: "text" },
    { text: `sessão: ${live.session ?? "desconhecida"} · reversão: ${describePending(live.pending)}`, tone: "text" },
    { text: `último apply: ${lastApply}`, tone: "text" },
  ];
}
