// Texts the module repeats in several places, so each one is written once.

/** The commands a proof or a warning points the technician to. */
export const FIX = {
  apply: "firewall apply",
  confirm: "firewall confirm",
  trustPhonevox: "firewall ip trust-phonevox",
  trustAsterisk: "firewall ip trust-asterisk",
  bootEnable: "firewall boot enable",
} as const;

export const NEEDS_APPLY = `a lista mudou, mas só vale depois de \`${FIX.apply}\``;

/** The page's `precisa aplicar` notice (UI.md §13): why the saved lists differ from what is applied. */
export const NEEDS_APPLY_REASON = {
  changed: "as listas mudaram desde a última aplicação",
  never: "o firewall ainda não foi aplicado",
} as const;

export const needsApplyNotice = (reason: string) => `precisa aplicar: ${reason}`;

export const engineUnavailable = (engineId: string, reason: string | undefined) => `engine indisponível: ${engineId} (${reason ?? "?"})`;
