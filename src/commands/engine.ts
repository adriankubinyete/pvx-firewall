// `engine`: shows or sets which firewall the module drives.
import type { CommandCtx, CommandDef } from "@pvx/sdk";
import { SETTINGS, engineSettingOf, isEngineSetting, pickEngine, type EngineSetting } from "../engines/index.ts";
import { STORE_KEY } from "../state.ts";

const invalidEngineMessage = (name: string) => `engine inválido: ${name} (use ${SETTINGS.join(", ")})`;

/** `engine: auto -> nftables`, or `engine: auto (why none can be picked)`. */
async function reportChosenEngine(ctx: CommandCtx, setting: EngineSetting): Promise<void> {
  const picked = await pickEngine(ctx, setting);
  const outcome = "engine" in picked ? ` -> ${picked.engine.id}` : ` (${picked.error})`;
  ctx.out.success(`engine: ${setting}${outcome}`);
}

const engine: CommandDef = {
  help: "Mostra ou define o engine (auto, firewalld, nftables, iptables)",
  args: [
    { name: "name", help: "Engine", kind: "positional", values: [...SETTINGS] },
    { name: "zone", help: "Zona do firewalld (padrão pvxfw)", kind: "option" },
  ],
  async run(ctx) {
    const name = ctx.arg("name");
    if (name && !isEngineSetting(name)) {
      ctx.out.error(invalidEngineMessage(name));
      return;
    }
    if (name) ctx.store.set(STORE_KEY.engine, name);
    const zone = ctx.option("zone");
    if (zone) ctx.store.set(STORE_KEY.zone, zone);
    await reportChosenEngine(ctx, engineSettingOf(ctx.store));
  },
};

export const engineCommands: Record<string, CommandDef> = { engine };
