// Peers of the local Asterisk that are worth trusting. Never applied without a review (spec risk 6).
import { coveredBy, ipToInt } from "./net.ts";
import { notFound, ok, run } from "./exec.ts";
import type { ExecFn } from "./engines/types.ts";

/** The `asterisk -rx` queries that list peers, for chan_sip and for PJSIP. */
export const PEER_QUERIES = ["sip show peers", "pjsip show contacts", "pjsip show endpoints"];
const ASTERISK_TIMEOUT_MS = 5000;

export interface Peer {
  ip: string;
  peer: string;
}

/** An IPv4 that is not part of a longer dotted number. */
const IPV4_IN_LINE = /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g;
/** `pjsip show contacts` line: ` Contact:  2000/sip:...`; the peer is the text before the first `/`. */
const PJSIP_CONTACT = /^\s*Contact:\s+([^\s/]+)/;
/** `sip show peers` line: the peer is the first word, up to the first `/`. */
const FIRST_WORD = /^\s*([^\s/]+)/;
const UNNAMED_PEER = "?";

const peerNameOf = (line: string): string => PJSIP_CONTACT.exec(line)?.[1] ?? FIRST_WORD.exec(line)?.[1] ?? UNNAMED_PEER;

/** Name and IPv4 of each line that carries one. `Transport:` lines are our own bind addresses. */
export function parsePeers(output: string): Peer[] {
  const found: Peer[] = [];
  for (const line of output.split("\n")) {
    if (/^\s*Transport:/.test(line)) continue;
    const ips = [...line.matchAll(IPV4_IN_LINE)].map((match) => match[1]!).filter((ip) => ipToInt(ip) !== undefined);
    const peer = peerNameOf(line);
    for (const ip of ips) found.push({ ip, peer });
  }
  return found;
}

/** Never worth trusting: unspecified, private, loopback, link-local and multicast ranges. */
const NON_PUBLIC = ["0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/3"];

export interface Candidates {
  candidates: Peer[];
  /** Why each other IP was left out. */
  skipped: { ip: string; why: string }[];
}

/** Public, not this host, not already trusted. One entry per IP, with every peer name that uses it. */
export function filterCandidates(peers: Peer[], ownIps: string[], trusted: string[]): Candidates {
  const namesByIp = groupNamesByIp(peers);
  const candidates: Peer[] = [];
  const skipped: Candidates["skipped"] = [];
  for (const [ip, names] of namesByIp) {
    const why = whySkipped(ip, ownIps, trusted);
    if (why) skipped.push({ ip, why });
    else candidates.push({ ip, peer: [...names].join(", ") });
  }
  return { candidates, skipped };
}

function groupNamesByIp(peers: Peer[]): Map<string, Set<string>> {
  const namesByIp = new Map<string, Set<string>>();
  for (const { ip, peer } of peers) {
    const names = namesByIp.get(ip) ?? new Set<string>();
    names.add(peer);
    namesByIp.set(ip, names);
  }
  return namesByIp;
}

/** The reason an IP is not offered for review, or "" when it is a candidate. */
function whySkipped(ip: string, ownIps: string[], trusted: string[]): string {
  if (ownIps.includes(ip)) return "IP do próprio host";
  if (coveredBy(ip, NON_PUBLIC)) return "privado ou loopback";
  if (coveredBy(ip, trusted)) return "já confiável";
  return "";
}

export async function collect(exec: ExecFn): Promise<{ peers: Peer[]; asterisk: boolean }> {
  const peers: Peer[] = [];
  let asterisk = false;
  for (const query of PEER_QUERIES) {
    const result = await run(exec, "asterisk", ["-rx", query], { timeoutMs: ASTERISK_TIMEOUT_MS });
    if (notFound(result)) break; // not installed: one miss is enough
    asterisk = true;
    if (ok(result)) peers.push(...parsePeers(result.stdout));
  }
  return { peers, asterisk };
}
