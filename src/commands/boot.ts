// `boot enable|disable|status`: the systemd unit that reapplies the lists at boot.
import type { CommandDef } from "@pvx/sdk";
import { BOOT_ARGS, DEFAULT_BIN, UNIT_NAME, unitText } from "../boot.ts";
import { ENGINES, engineSettingOf, pickEngine } from "../engines/index.ts";
import { ioOf } from "./context.ts";

/** The unit is the same for every engine except its ordering after firewalld, so a host with no engine gets the nftables one. */
const FALLBACK_ENGINE = ENGINES.nftables;

const bootEnable: CommandDef = {
  help: "Instala e habilita a unit systemd que reaplica as listas no boot",
  destructive: true,
  args: [
    { name: "dry-run", help: "Só mostra a unit", kind: "flag" },
    { name: "pvx-bin", help: `Caminho do pvx (padrão ${DEFAULT_BIN})`, kind: "option" },
  ],
  async run(ctx) {
    const pvxBin = ctx.option("pvx-bin") ?? DEFAULT_BIN;
    const picked = await pickEngine(ctx.exec, engineSettingOf(ctx.store));
    const engine = "engine" in picked ? picked.engine : FALLBACK_ENGINE;
    if (ctx.flag("dry-run")) {
      for (const line of unitText(pvxBin, engine.id).split("\n")) ctx.out.plain(line);
      return;
    }
    await engine.bootEnable(ioOf(ctx), pvxBin);
    ctx.out.success(`start-on-boot habilitado (${UNIT_NAME}: ${pvxBin} ${BOOT_ARGS.join(" ")})`);
  },
};

const bootDisable: CommandDef = {
  help: "Desabilita e remove a unit de boot",
  destructive: true,
  async run(ctx) {
    await FALLBACK_ENGINE.bootDisable(ioOf(ctx));
    ctx.out.success("start-on-boot desabilitado");
  },
};

const bootStatus: CommandDef = {
  help: "Diz se a unit de boot está habilitada",
  readonly: true,
  async run(ctx) {
    const status = await FALLBACK_ENGINE.bootStatus(ioOf(ctx));
    if (status === "enabled") ctx.out.success("start-on-boot habilitado");
    else ctx.out.warning("start-on-boot desabilitado");
  },
};

export const bootCommands: Record<string, CommandDef> = { "boot enable": bootEnable, "boot disable": bootDisable, "boot status": bootStatus };
