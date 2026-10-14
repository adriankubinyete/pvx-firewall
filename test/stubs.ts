// Fake system programs for the story and page tests. PATH is replaced by a directory holding ONLY these scripts, so the real
// firewall-cmd, nft, iptables or systemctl of the machine running the tests can never be reached.
// Every script logs its call to `$PVX_STUB_DIR/calls` first (`calls()` reads it), then answers like the program would.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOG_THE_CALL = `echo "\${0##*/} $*" >> "$PVX_STUB_DIR/calls"`;

/** A script that logs the call, runs `body`, and exits 0 unless the body exits first. */
const program = (body: string) => `#!/bin/sh\n${LOG_THE_CALL}\n${body}\nexit 0\n`;

/** The programs that answer something. Any other name in `installStubs` is a no-op that exits 0 (`systemd-run`). */
const STUB_BODIES: Record<string, string> = {
  // nft: a table that remembers what was loaded into it (`loaded`).
  nft: `case "$1" in
  # The engine probe.
  --version) echo "nftables v1.0.9" ;;
  # \`nft -f -\`: the transaction comes on stdin. Keep it as the loaded rules.
  -f)
    : > "$PVX_STUB_DIR/loaded"
    while IFS= read -r line; do printf '%s\\n' "$line" >> "$PVX_STUB_DIR/loaded"; done ;;
  # \`nft list table ip pvx\`: fails while nothing is loaded; then prints the loaded rules (indented four spaces), without the chain's \`type\` line.
  list)
    [ -s "$PVX_STUB_DIR/loaded" ] || exit 1
    echo "table ip pvx {"; echo "	chain input {"
    while IFS= read -r line; do
      case "$line" in "    "*) case "$line" in *"type filter"*) ;; *) echo "\${line#    }" ;; esac ;; esac
    done < "$PVX_STUB_DIR/loaded"
    echo "	}"; echo "}" ;;
esac`,

  // systemctl: firewalld is not running and the boot unit is not enabled.
  systemctl: `case "$1" in
  is-active) echo inactive; exit 3 ;;
  is-enabled) echo disabled; exit 1 ;;
esac`,

  // asterisk -rx "<query>": prints the file \`asterisk.<query>\` of the stub directory, if the test wrote one.
  asterisk: `if [ "$1" = "-rx" ] && [ -f "$PVX_STUB_DIR/asterisk.$2" ]; then
  while IFS= read -r line; do printf '%s\\n' "$line"; done < "$PVX_STUB_DIR/asterisk.$2"
fi`,
};

export interface Stubs {
  dir: string;
  /** Every call, as `program arg arg`, in order. */
  calls(): string[];
  /** What the last `nft -f -` loaded. */
  loaded(): string;
  restore(): void;
}

/** `programs`: which commands exist. Everything else is "not found". */
export function installStubs(programs: string[]): Stubs {
  const dir = mkdtempSync(join(tmpdir(), "pvx-stubs-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of programs) {
    writeFileSync(join(bin, name), program(STUB_BODIES[name] ?? ""));
    chmodSync(join(bin, name), 0o755);
  }
  const original = { PATH: process.env.PATH, PVX_STUB_DIR: process.env.PVX_STUB_DIR };
  process.env.PATH = bin;
  process.env.PVX_STUB_DIR = dir;
  const read = (file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : "");
  return {
    dir,
    calls: () => read("calls").split("\n").filter(Boolean),
    loaded: () => read("loaded"),
    restore() {
      process.env.PATH = original.PATH;
      if (original.PVX_STUB_DIR === undefined) delete process.env.PVX_STUB_DIR;
      else process.env.PVX_STUB_DIR = original.PVX_STUB_DIR;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The SSH client the story and page tests pretend to connect from (`ctx.session.sshClient`). */
export const SSH_CLIENT_IP = "203.0.113.7";
