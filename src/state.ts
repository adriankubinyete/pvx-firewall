// The firewall lists, kept as JSON in the module store. Pure helpers over a plain object.
import { contains, coveredBy, normCidr, normPort, parseCidr } from "./net.ts";
import type { Desired } from "./engines/types.ts";

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

const who = (env: Record<string, string | undefined>) => env.SUDO_USER || env.LOGNAME || "desconhecido";
export const actor = (env: Record<string, string | undefined> = process.env) => who(env);

export const seed = (at = new Date().toISOString()): FwState => {
  const mk = ([value, comment]: readonly [string, string]): Entry => ({ value, comment, source: "base", addedBy: "firewall", at });
  return { ipAccept: BASE_IPS.map(mk), ipDeny: [], portAccept: PORT_ACCEPT.map(mk), portDeny: PORT_DENY.map(mk) };
};

/**
 * Reads never write. A missing state is the seed, and a writer saves what it loaded, so an add on a fresh central keeps the
 * base IPs (the Python module once lost them this way and a technician lost the SSH session).
 */
export const load = (s: { get<T>(k: string): T | undefined }): FwState => s.get<FwState>("state") ?? seed();

export const isIp = (l: ListName) => l === "ipAccept" || l === "ipDeny";
export const norm = (l: ListName, v: string) => (isIp(l) ? normCidr(v) : normPort(v));

/** Adds, or updates the comment of an existing entry. */
export function addEntry(st: FwState, list: ListName, value: string, comment: string, source: Source, by: string, at = new Date().toISOString()): "added" | "updated" | "unchanged" {
  const cur = st[list].find((e) => e.value === value);
  if (!cur) {
    st[list].push({ value, comment, source, addedBy: by, at });
    return "added";
  }
  if (comment && comment !== cur.comment) {
    cur.comment = comment;
    return "updated";
  }
  return "unchanged";
}

/** Removes `value` from the given lists. */
export function removeEntry(st: FwState, lists: ListName[], value: string): ListName[] {
  const hit: ListName[] = [];
  for (const l of lists) {
    const n = st[l].length;
    st[l] = st[l].filter((e) => e.value !== value);
    if (st[l].length !== n) hit.push(l);
  }
  return hit;
}

/** Base entries not covered by an accepted network. */
export const missingBase = (st: FwState): (readonly [string, string])[] => {
  const nets = st.ipAccept.map((e) => e.value);
  return BASE_IPS.filter(([v]) => !coveredBy(v, nets));
};

/** Does any deny entry cover `ip`? */
export const deniedBy = (st: FwState, ip: string): string | undefined => {
  const c = parseCidr(ip);
  return c ? st.ipDeny.find((e) => { const o = parseCidr(e.value); return !!o && contains(o, c); })?.value : undefined;
};

export const desiredOf = (st: FwState, failsafe?: string): Desired => ({
  ipAccept: st.ipAccept.map((e) => e.value),
  ipDeny: st.ipDeny.map((e) => e.value),
  portAccept: st.portAccept.map((e) => e.value),
  portDeny: st.portDeny.map((e) => e.value),
  failsafe,
});

/** Small stable fingerprint of the lists: "was what is applied what is listed now?". */
export const keyOf = (st: FwState): string => {
  const s = JSON.stringify([st.ipAccept, st.ipDeny, st.portAccept, st.portDeny].map((l) => l.map((e) => e.value).sort()));
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
};
