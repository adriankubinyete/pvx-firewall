// IPv4, CIDR and port helpers. Pure: no I/O.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAX_OCTET = 255;
const MAX_PREFIX_BITS = 32;

// JavaScript bit operators work on SIGNED 32-bit integers; every `>>> 0` below turns the result back into an unsigned
// address (0 to 4294967295), the form the rest of this file compares and prints.

export const ipToInt = (ip: string): number | undefined => {
  const match = IPV4.exec(ip);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > MAX_OCTET)) return undefined;
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
};

export const intToIp = (address: number): string =>
  [address >>> 24, (address >>> 16) & MAX_OCTET, (address >>> 8) & MAX_OCTET, address & MAX_OCTET].join(".");

/** The netmask of a prefix length: `maskOf(24)` is `255.255.255.0` as a number. `/0` is the empty mask (a shift by 32 would wrap). */
const maskOf = (bits: number): number => (bits === 0 ? 0 : (~0 << (MAX_PREFIX_BITS - bits)) >>> 0);

export interface Cidr {
  addr: number;
  bits: number;
}

/** `1.2.3.4` or `1.2.3.0/24`. Undefined when invalid or when host bits are set (`1.2.3.4/24`). */
export const parseCidr = (text: string): Cidr | undefined => {
  const [ip, length, ...extra] = text.split("/");
  if (extra.length || ip === undefined) return undefined;
  const addr = ipToInt(ip);
  if (addr === undefined) return undefined;
  if (length === undefined) return { addr, bits: MAX_PREFIX_BITS };
  if (!/^\d{1,2}$/.test(length) || Number(length) > MAX_PREFIX_BITS) return undefined;
  const bits = Number(length);
  const hostBitsAreClear = (addr & maskOf(bits)) >>> 0 === addr;
  return hostBitsAreClear ? { addr, bits } : undefined;
};

/** Canonical text: `/32` dropped. */
export const cidrText = (cidr: Cidr): string => {
  const ip = intToIp(cidr.addr);
  return cidr.bits === MAX_PREFIX_BITS ? ip : `${ip}/${cidr.bits}`;
};

export const normCidr = (text: string): string | undefined => {
  const cidr = parseCidr(text.trim());
  return cidr && cidrText(cidr);
};

/** Does `outer` contain all of `inner`? */
export const contains = (outer: Cidr, inner: Cidr): boolean => {
  if (outer.bits > inner.bits) return false;
  return ((inner.addr & maskOf(outer.bits)) >>> 0) === outer.addr;
};

/** Is `value` (an IP or CIDR) inside any of the `networks`? Invalid text is never covered. */
export const coveredBy = (value: string, networks: string[]): boolean => {
  const inner = parseCidr(value);
  if (!inner) return false;
  return networks.some((network) => {
    const outer = parseCidr(network);
    return outer !== undefined && contains(outer, inner);
  });
};

// ---- ports ----

const MIN_PORT = 1;
const MAX_PORT = 65535;
/** `5060`, `10000-20000`, `5060/udp`, `10000-20000/tcp`. */
const PORT_SPEC = /^(\d{1,5})(?:-(\d{1,5}))?(?:\/(tcp|udp))?$/;

export type Protocol = "tcp" | "udp";

export interface PortSpec {
  lo: number;
  hi: number;
  /** Undefined = tcp and udp. */
  proto?: Protocol;
}

/** One protocol of a port spec: what a rule matches (`range` is `5060` or `10000-20000`). */
export interface PortMatch {
  proto: Protocol;
  range: string;
}

/** `5060/udp`, `10000-20000/tcp`, `80` (no protocol = tcp and udp). */
export const parsePort = (text: string): PortSpec | undefined => {
  const match = PORT_SPEC.exec(text.trim().toLowerCase());
  if (!match) return undefined;
  const lo = Number(match[1]);
  const hi = match[2] === undefined ? lo : Number(match[2]);
  if (lo < MIN_PORT || hi > MAX_PORT || hi < lo) return undefined;
  return { lo, hi, proto: match[3] as Protocol | undefined };
};

const rangeText = (spec: PortSpec): string => (spec.lo === spec.hi ? String(spec.lo) : `${spec.lo}-${spec.hi}`);

export const portText = (spec: PortSpec): string => `${rangeText(spec)}${spec.proto ? `/${spec.proto}` : ""}`;

export const normPort = (text: string): string | undefined => {
  const spec = parsePort(text);
  return spec && portText(spec);
};

/** One match per protocol, ranges as `lo-hi`; invalid text gives none. */
export const expandPort = (text: string): PortMatch[] => {
  const spec = parsePort(text);
  if (!spec) return [];
  const protocols: Protocol[] = spec.proto ? [spec.proto] : ["tcp", "udp"];
  return protocols.map((proto) => ({ proto, range: rangeText(spec) }));
};

// ---- the SSH session ----

/** The `(ip)` that `who -m` prints after the terminal and the login time. */
const WHO_CLIENT = /\((\d{1,3}(?:\.\d{1,3}){3})\)/;

/** First IPv4 of `SSH_CLIENT` / `SSH_CONNECTION`, else the `(ip)` of `who -m`. */
export const sessionIp = (env: Record<string, string | undefined>, whoOutput = ""): string | undefined => {
  for (const variable of [env.SSH_CLIENT, env.SSH_CONNECTION]) {
    const firstWord = variable?.trim().split(/\s+/)[0];
    if (firstWord && ipToInt(firstWord) !== undefined) return firstWord;
  }
  const fromWho = WHO_CLIENT.exec(whoOutput)?.[1];
  return fromWho !== undefined && ipToInt(fromWho) !== undefined ? fromWho : undefined;
};
