// start-on-boot: a oneshot unit that reapplies the lists. Its ExecStart MUST be a real command of this module
// (the Python unit called `firewall sync`, which never existed; test/boot.test.ts ties the two).
import type { BootStatus, EngineId, Io, ProbeIo } from "./engines/types.ts";

export const UNIT_NAME = "pvx-firewall.service";
export const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;
export const DEFAULT_BIN = "/usr/local/bin/pvx";
/** No session at boot: no failsafe (`--force`) and no revert timer (`--no-rollback`). */
export const BOOT_ARGS = ["firewall", "apply", "--yes", "--force", "--no-rollback"];

export const unitText = (bin: string, engine: EngineId): string =>
  [
    "[Unit]",
    "Description=pvx firewall: reapply the saved lists",
    `After=network-online.target${engine === "firewalld" ? " firewalld.service" : ""}`,
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `ExecStart=${bin} ${BOOT_ARGS.join(" ")}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");

/** The three boot operations are the same for every engine; only the unit ordering differs. */
export const makeBoot = (engine: EngineId) => ({
  async bootEnable(io: Io, pvxBin: string) {
    await io.fs.write(UNIT_PATH, unitText(pvxBin, engine));
    for (const args of [["daemon-reload"], ["enable", UNIT_NAME]]) {
      await io.shell.must("systemctl", args);
    }
  },
  async bootDisable(io: Io) {
    await io.shell.run("systemctl", ["disable", UNIT_NAME]);
    await io.fs.remove(UNIT_PATH);
    await io.shell.run("systemctl", ["daemon-reload"]);
  },
  async bootStatus(io: Pick<ProbeIo, "shell">): Promise<BootStatus> {
    const result = await io.shell.run("systemctl", ["is-enabled", UNIT_NAME]);
    return result.stdout.trim() === "enabled" ? "enabled" : "disabled";
  },
});
