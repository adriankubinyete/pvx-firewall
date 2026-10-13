// Peers of the local Asterisk that are worth trusting. Never applied without a review (spec risk 6).
import { coveredBy, ipToInt } from "./net.ts";
import { run, ok } from "./exec.ts";
import type { ExecFn } from "./engines/types.ts";

export const COMMANDS = ["sip show peers", "pjsip show contacts", "pjsip show endpoints"];

export interface Peer {
  ip: string;
  peer: string;
}

/** Name and IPv4 of each line that carries one. `Transport:` lines are our own bind addresses. */
export function parsePeers(out: string): Peer[] {
  const found: Peer[] = [];
  for (const line of out.split("\n")) {
    if (/^\s*Transport:/.test(line)) continue;
    const ips = [...line.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)].map((m) => m[1]!).filter((i) => ipToInt(i) !== undefined);
    if (!ips.length) continue;
    const name = /^\s*Contact:\s+([^\s/]+)/.exec(line)?.[1] ?? /^\s*([^\s/]+)/.exec(line)?.[1] ?? "?";
    for (const ip of ips) found.push({ ip, peer: name });
  }
  return found;
}

const PRIVATE = ["0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/3"];

export interface Candidates {
  candidates: Peer[];
  /** Why each other IP was left out. */
  skipped: { ip: string; why: string }[];
}

/** Public, not this host, not already trusted. One entry per IP, with every peer name that uses it. */
export function filterCandidates(peers: Peer[], own: string[], trusted: string[]): Candidates {
  const by = new Map<string, Set<string>>();
  for (const p of peers) (by.get(p.ip) ?? by.set(p.ip, new Set()).get(p.ip)!).add(p.peer);
  const candidates: Peer[] = [];
  const skipped: Candidates["skipped"] = [];
  for (const [ip, names] of by) {
    const why = own.includes(ip) ? "IP do próprio host" : coveredBy(ip, PRIVATE) ? "privado ou loopback" : coveredBy(ip, trusted) ? "já confiável" : "";
    if (why) skipped.push({ ip, why });
    else candidates.push({ ip, peer: [...names].join(", ") });
  }
  return { candidates, skipped };
}

export async function collect(exec: ExecFn): Promise<{ peers: Peer[]; asterisk: boolean }> {
  const peers: Peer[] = [];
  let asterisk = false;
  for (const c of COMMANDS) {
    const r = await run(exec, "asterisk", ["-rx", c], { timeoutMs: 5000 });
    if (r.code === 127) break; // not installed: one miss is enough
    asterisk = true;
    if (ok(r)) peers.push(...parsePeers(r.stdout));
  }
  return { peers, asterisk };
}
