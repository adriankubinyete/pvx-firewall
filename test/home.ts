// @pvx/testing's runCommand builds a fresh PVX_HOME per call, so it cannot run a sequence ("accept", then "list").
// This does what it does, once, and keeps the home for several lines.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger, createRegistry, execute, loadModules, logsDir } from "@pvx/core";
import type { OutLine } from "@pvx/sdk";
import { ui } from "@pvx/tui";

export interface Session {
  home: string;
  run(line: string, confirmed?: boolean): Promise<{ ok: boolean; exit: number; lines: OutLine[]; text: string }>;
}

export async function openSession(moduleDir: string): Promise<Session> {
  const home = mkdtempSync(join(tmpdir(), "pvx-fw-"));
  mkdirSync(join(home, "usermodules"));
  symlinkSync(resolve(moduleDir), join(home, "usermodules", "firewall"));
  process.env.PVX_HOME = home;
  process.env.PVX_USERMODULES = join(home, "usermodules");
  const registry = createRegistry();
  await loadModules(registry, { hostVersion: "0.1.0", makeLogger: (n) => createLogger(logsDir(), n), ui });
  if (registry.errors[0]) throw new Error(`não carregou: ${registry.errors[0].error}`);
  process.on("exit", () => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    async run(line, confirmed = false) {
      const r = await execute(registry, line, { makeLogger: (n) => createLogger(logsDir(), n), env: {}, confirmed });
      return { ok: r.ok, exit: r.exit, lines: r.lines, text: r.lines.map((l) => l.text).join("\n") };
    },
  };
}
