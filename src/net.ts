// IPv4, CIDR and port helpers. Pure: no I/O.

export const ipToInt = (s: string): number | undefined => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return undefined;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return undefined;
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
};

export interface Cidr {
  addr: number;
  bits: number;
}

/** `1.2.3.4` or `1.2.3.0/24`. Undefined when invalid or when host bits are set (`1.2.3.4/24`). */
export const parseCidr = (s: string): Cidr | undefined => {
  const [ip, len, ...rest] = s.split("/");
  if (rest.length || ip === undefined) return undefined;
  const addr = ipToInt(ip);
  if (addr === undefined) return undefined;
  if (len === undefined) return { addr, bits: 32 };
  if (!/^\d{1,2}$/.test(len) || Number(len) > 32) return undefined;
  const bits = Number(len);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (addr & mask) >>> 0 === addr ? { addr, bits } : undefined;
};

/** Canonical text: `/32` dropped. */
export const cidrText = (c: Cidr): string => {
  const ip = [c.addr >>> 24, (c.addr >>> 16) & 255, (c.addr >>> 8) & 255, c.addr & 255].join(".");
  return c.bits === 32 ? ip : `${ip}/${c.bits}`;
};

export const normCidr = (s: string): string | undefined => {
  const c = parseCidr(s.trim());
  return c && cidrText(c);
};

/** Does `outer` contain all of `inner`? */
export const contains = (outer: Cidr, inner: Cidr): boolean => {
  if (outer.bits > inner.bits) return false;
  const mask = outer.bits === 0 ? 0 : (~0 << (32 - outer.bits)) >>> 0;
  return ((inner.addr & mask) >>> 0) === outer.addr;
};

export const coveredBy = (value: string, nets: string[]): boolean => {
  const c = parseCidr(value);
  return !!c && nets.some((n) => {
    const o = parseCidr(n);
    return !!o && contains(o, c);
  });
};

// ---- ports ----

export interface PortSpec {
  lo: number;
  hi: number;
  /** Undefined = tcp and udp. */
  proto?: "tcp" | "udp";
}

/** `5060/udp`, `10000-20000/tcp`, `80` (no protocol = tcp and udp). */
export const parsePort = (s: string): PortSpec | undefined => {
  const m = /^(\d{1,5})(?:-(\d{1,5}))?(?:\/(tcp|udp))?$/.exec(s.trim().toLowerCase());
  if (!m) return undefined;
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : Number(m[2]);
  if (lo < 1 || hi > 65535 || hi < lo) return undefined;
  return { lo, hi, proto: m[3] as PortSpec["proto"] };
};

export const portText = (p: PortSpec): string => `${p.lo === p.hi ? p.lo : `${p.lo}-${p.hi}`}${p.proto ? `/${p.proto}` : ""}`;

export const normPort = (s: string): string | undefined => {
  const p = parsePort(s);
  return p && portText(p);
};

/** One entry per protocol, ranges as `lo-hi`. */
export const expandPort = (spec: string): { proto: "tcp" | "udp"; range: string }[] => {
  const p = parsePort(spec);
  if (!p) return [];
  const range = p.lo === p.hi ? String(p.lo) : `${p.lo}-${p.hi}`;
  return (p.proto ? [p.proto] : (["tcp", "udp"] as const)).map((proto) => ({ proto, range }));
};

// ---- the SSH session ----

/** First IPv4 of `SSH_CLIENT` / `SSH_CONNECTION`, else the `(ip)` of `who -m`. */
export const sessionIp = (env: Record<string, string | undefined>, whoOut = ""): string | undefined => {
  for (const v of [env.SSH_CLIENT, env.SSH_CONNECTION]) {
    const ip = v?.trim().split(/\s+/)[0];
    if (ip && ipToInt(ip) !== undefined) return ip;
  }
  const m = /\((\d{1,3}(?:\.\d{1,3}){3})\)/.exec(whoOut);
  return m && ipToInt(m[1]!) !== undefined ? m[1] : undefined;
};
