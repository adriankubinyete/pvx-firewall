// Fake system programs for the story tests. PATH is replaced by a directory holding ONLY these scripts, so the real
// firewall-cmd, nft, iptables or systemctl of the machine running the tests can never be reached.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = `#!/bin/sh
cmd=\${0##*/}
echo "$cmd $*" >> "$PVX_STUB_DIR/calls"
case "$cmd $1" in
  "nft --version") echo "nftables v1.0.9" ;;
  "nft -f")
    : > "$PVX_STUB_DIR/loaded"
    while IFS= read -r l; do printf '%s\\n' "$l" >> "$PVX_STUB_DIR/loaded"; done ;;
  "nft list")
    [ -s "$PVX_STUB_DIR/loaded" ] || exit 1
    echo "table ip pvx {"; echo "	chain input {"
    while IFS= read -r l; do case "$l" in "    "*) case "$l" in *"type filter"*) ;; *) echo "\${l#    }" ;; esac ;; esac; done < "$PVX_STUB_DIR/loaded"
    echo "	}"; echo "}" ;;
  "systemctl is-active") echo inactive; exit 3 ;;
  "systemctl is-enabled") echo disabled; exit 1 ;;
  "asterisk -rx") [ -f "$PVX_STUB_DIR/asterisk.$2" ] && while IFS= read -r l; do printf '%s\\n' "$l"; done < "$PVX_STUB_DIR/asterisk.$2" ;;
esac
exit 0
`;

export interface Stubs {
  dir: string;
  calls(): string[];
  loaded(): string;
  restore(): void;
}

/** `programs`: which commands exist. Everything else is "not found". */
export function installStubs(programs: string[]): Stubs {
  const dir = mkdtempSync(join(tmpdir(), "pvx-stubs-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const p of programs) {
    writeFileSync(join(bin, p), SCRIPT);
    chmodSync(join(bin, p), 0o755);
  }
  const old = { PATH: process.env.PATH, PVX_STUB_DIR: process.env.PVX_STUB_DIR };
  process.env.PATH = bin;
  process.env.PVX_STUB_DIR = dir;
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return {
    dir,
    calls: () => read("calls").split("\n").filter(Boolean),
    loaded: () => read("loaded"),
    restore() {
      process.env.PATH = old.PATH;
      if (old.PVX_STUB_DIR === undefined) delete process.env.PVX_STUB_DIR;
      else process.env.PVX_STUB_DIR = old.PVX_STUB_DIR;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
