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

export const engineUnavailable = (engineId: string, reason: string | undefined) => `engine indisponível: ${engineId} (${reason ?? "?"})`;
