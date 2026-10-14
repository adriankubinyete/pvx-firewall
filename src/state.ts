// What the module keeps in its store (`state.json`): the lists and the records of the last apply. Pure helpers over plain objects.
import type { Store } from "@pvx/sdk";
import { coveredBy, normCidr, normPort } from "./net.ts";
import type { Desired } from "./engines/types.ts";

/** The store keys this module writes. Each one has a type below; nothing else is persisted. */
export const STORE_KEY = {
  lists: "state",
  engine: "engine",
  zone: "zone",
  lastApply: "lastApply",
  pending: "pending",
  asterisk: "asterisk",
} as const;

export type Source = "base" | "asterisk" | "manual";
export interface Entry {
  /** ip/cidr or port/proto. */
  value: string;
  comment: string;
  source: Source;
  addedBy: string;
  at: string;
}
export interface FwState {
  ipAccept: Entry[];
  ipDeny: Entry[];
  portAccept: Entry[];
  portDeny: Entry[];
}
export type ListName = keyof FwState;

/** `lastApply`: what the last successful apply recorded. `key` is `listsFingerprint` of the lists it loaded. */
export interface LastApply {
  at: string;
  by: string;
  engine: string;
  key: string;
  rules: number;
  failsafe?: string;
  /** Whether a revert job was scheduled with it. */
  rollback: boolean;
}

/** `pending`: an apply the technician has not confirmed yet. Epoch milliseconds. */
export interface PendingRevert {
  at: number;
  deadline: number;
}

/** `asterisk`: the outcome of the last `ip trust-asterisk` review. */
export interface AsteriskReview {
  at: number;
  /** Candidates the technician has not accepted. */
  pending: { ip: string; peer: string }[];
}

/** The single source of the Phonevox base IPs. */
export const BASE_IPS: readonly (readonly [string, string])[] = [
  ["127.0.0.1", "LOCALHOST"],
  ["10.0.0.0/8", "INTERNO"],
  ["172.16.0.0/12", "INTERNO"],
  ["192.168.0.0/16", "INTERNO"],
  ["189.124.85.75", "PHONEVOX PRINCIPAL"],
  ["186.233.124.252", "PHONEVOX SECUNDARIO"],
  ["189.124.85.152/29", "PHONEVOX REDE"],
  ["186.233.120.72/29", "PHONEVOX REDE"],
  ["179.199.136.199", "MAGNUSBILLING PHONEVOX"],
  ["149.78.185.36", "PHONEVOX MAGNUS 2"],
  ["31.97.160.127", "PHONEVOX INTERNO V2"],
  ["45.140.193.125", "PHONEVOX HELPDESK"],
  ["186.233.122.92", "PHONEVOX ABNER"],
];

const PORT_ACCEPT: [string, string][] = [
  ["5060/udp", "SIP"],
  ["5060/tcp", "SIP"],
  ["5061/tcp", "SIP TLS"],
  ["50007/tcp", "SIP custom"],
  ["50007/udp", "SIP custom"],
  ["10000-20000/udp", "RTP audio/video"],
];
// Admin ports stay closed to the world on purpose: real access comes from the accepted IPs or the session failsafe.
const PORT_DENY: [string, string][] = [
  ["995/udp", "POP3D"],
  ["995/tcp", "POP3D"],
  ["110/udp", "POP3D"],
  ["110/tcp", "POP3D"],
  ["4569/udp", "IAX"],
  ["5353/udp", "mDNS"],
  ["20-23", "ftp-data/ftp/ssh/telnet"],
  ["80/tcp", "HTTP"],
  ["443/tcp", "HTTPS"],
  ["3306/tcp", "MySQL"],
  ["5038/tcp", "Asterisk Manager Interface"],
  ["21122/tcp", "SSH custom"],
  ["10050/tcp", "Zabbix agent"],
  ["10051/tcp", "Zabbix server"],
];

export const UNKNOWN_ACTOR = "desconhecido";

/** Who is acting: the user behind `sudo`, else the login. */
export const actor = (env: Record<string, string | undefined> = process.env): string => env.SUDO_USER || env.LOGNAME || UNKNOWN_ACTOR;

export const seed = (at = new Date().toISOString()): FwState => {
  const baseEntry = ([value, comment]: readonly [string, string]): Entry => ({ value, comment, source: "base", addedBy: "firewall", at });
  return { ipAccept: BASE_IPS.map(baseEntry), ipDeny: [], portAccept: PORT_ACCEPT.map(baseEntry), portDeny: PORT_DENY.map(baseEntry) };
};

/**
 * Reads never write. A missing state is the seed, and a writer saves what it loaded, so an add on a fresh central keeps the
 * base IPs (the Python module once lost them this way and a technician lost the SSH session).
 */
export const load = (store: Pick<Store, "get">): FwState => store.get<FwState>(STORE_KEY.lists) ?? seed();

export const isIp = (list: ListName) => list === "ipAccept" || list === "ipDeny";
export const norm = (list: ListName, value: string) => (isIp(list) ? normCidr(value) : normPort(value));

/** The list a value would contradict: accepting a value that is denied (or the reverse). The deny wins when both hold it. */
export const OPPOSITE_LIST: Record<ListName, ListName> = {
  ipAccept: "ipDeny",
  ipDeny: "ipAccept",
  portAccept: "portDeny",
  portDeny: "portAccept",
};

/** The first piece of comma-separated `text` that is not a valid value of `list` (same split as `ctx.list`). */
export function firstInvalidValue(list: ListName, text: string): string | undefined {
  const pieces = text.split(",").map((piece) => piece.trim()).filter(Boolean);
  return pieces.find((piece) => norm(list, piece) === undefined);
}

export type AddResult = "added" | "updated" | "unchanged";

/**
 * Adds, or updates the comment of an existing entry. An empty comment keeps the
 * existing one, unless `replace` is set (editing): then it is stored as given.
 */
export function addEntry(state: FwState, list: ListName, value: string, comment: string, source: Source, addedBy: string, at = new Date().toISOString(), replace = false): AddResult {
  const existing = state[list].find((entry) => entry.value === value);
  if (!existing) {
    state[list].push({ value, comment, source, addedBy, at });
    return "added";
  }
  if ((replace || comment) && comment !== existing.comment) {
    existing.comment = comment;
    return "updated";
  }
  return "unchanged";
}

/** Removes `value` from the given lists; returns the lists that had it. */
export function removeEntry(state: FwState, lists: ListName[], value: string): ListName[] {
  const hit: ListName[] = [];
  for (const list of lists) {
    const before = state[list].length;
    state[list] = state[list].filter((entry) => entry.value !== value);
    if (state[list].length !== before) hit.push(list);
  }
  return hit;
}

/** Base entries not covered by an accepted network. */
export const missingBase = (state: FwState): (readonly [string, string])[] => {
  const accepted = state.ipAccept.map((entry) => entry.value);
  return BASE_IPS.filter(([value]) => !coveredBy(value, accepted));
};

export const desiredOf = (state: FwState, failsafe?: string): Desired => ({
  ipAccept: state.ipAccept.map((entry) => entry.value),
  ipDeny: state.ipDeny.map((entry) => entry.value),
  portAccept: state.portAccept.map((entry) => entry.value),
  portDeny: state.portDeny.map((entry) => entry.value),
  failsafe,
});

/**
 * A small stable fingerprint of the lists' values ("djb2" over the sorted values): "is what was applied what is listed now?".
 * It is saved in `lastApply.key` on every central. Do NOT change the algorithm: a new hash would make every existing
 * install report "as listas mudaram" until the next apply.
 */
export const listsFingerprint = (state: FwState): string => {
  const sortedValues = [state.ipAccept, state.ipDeny, state.portAccept, state.portDeny].map((entries) => entries.map((entry) => entry.value).sort());
  const text = JSON.stringify(sortedValues);
  let hash = 5381;
  for (let index = 0; index < text.length; index++) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  return hash.toString(16);
};

/** Forgets the unconfirmed apply (its deadline), and keeps the record of what was last applied. */
export const clearPending = (store: Store): void => store.delete(STORE_KEY.pending);

/** Forgets the unconfirmed apply AND the record of the last apply: the rules it described are gone (a revert ran). */
export function clearApplyState(store: Store): void {
  clearPending(store);
  store.delete(STORE_KEY.lastApply);
}
