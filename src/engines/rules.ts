// The ORDER of the rules is the safety contract of the module, and it is written once, here. Each engine only says how
// one rule looks in its own syntax (`RuleFormat`); it never decides where a rule goes.
import { expandPort, type PortMatch } from "../net.ts";
import type { Desired } from "./types.ts";

/** How one engine writes each kind of rule. */
export interface RuleFormat {
  /** The SSH session IP: accept. */
  failsafe(ip: string): string;
  /** Rules that always come after the failsafe: established connections, loopback, icmp (an engine may have fewer). */
  baseline: string[];
  ipDeny(ip: string): string;
  ipAccept(ip: string): string;
  portDeny(match: PortMatch): string;
  portAccept(match: PortMatch): string;
  /** The last rules: the default drop (firewalld has none, its zone target drops). */
  closing: string[];
}

/**
 * failsafe, baseline (icmp...), denied IPs, accepted IPs, denied ports, accepted ports, closing drop.
 *
 * - The failsafe is first so a technician never loses the session while the rest loads.
 * - Denied IPs come before accepted ones, and denied ports before accepted ports: a deny wins over an accept of the same value.
 */
export function renderRules(desired: Desired, format: RuleFormat): string[] {
  return [
    ...(desired.failsafe ? [format.failsafe(desired.failsafe)] : []),
    ...format.baseline,
    ...desired.ipDeny.map((ip) => format.ipDeny(ip)),
    ...desired.ipAccept.map((ip) => format.ipAccept(ip)),
    ...portRules(desired.portDeny, (match) => format.portDeny(match)),
    ...portRules(desired.portAccept, (match) => format.portAccept(match)),
    ...format.closing,
  ];
}

const portRules = (specs: string[], format: (match: PortMatch) => string): string[] =>
  specs.flatMap((spec) => expandPort(spec).map(format));

/** Line diff of the loaded rules against the wanted ones: what an apply would add and remove. */
export const diffRules = (loaded: string[], wanted: string[]): { added: string[]; removed: string[] } => ({
  added: wanted.filter((rule) => !loaded.includes(rule)),
  removed: loaded.filter((rule) => !wanted.includes(rule)),
});
