// The two Início widgets. They read the record only (a widget has 2 s to answer): never the live engine.
import type { Level, ReadCtx, SlotData, WidgetDef } from "@pvx/sdk";
import { FIX } from "../texts.ts";
import { readSummary, type Summary } from "./summary.ts";

const WIDGET_REFRESH_MS = 15_000;
/** Where the firewall sits among the other modules' widgets of a slot. */
const WIDGET_PRIORITY = 30;

type Chips = Extract<SlotData, { label: string }[]>;
type Attentions = Extract<SlotData, { title: string }[]>;

export const widgets: Record<string, WidgetDef> = {
  chip: { slot: "home.chips", priority: WIDGET_PRIORITY, refreshMs: WIDGET_REFRESH_MS, data: firewallChip },
  atencao: { slot: "home.attention", priority: WIDGET_PRIORITY, refreshMs: WIDGET_REFRESH_MS, data: firewallAttention },
};

async function firewallChip(ctx: ReadCtx): Promise<Chips> {
  const summary = await readSummary(ctx);
  const engine = summary.lastApply?.engine ?? summary.engineSetting;
  if (!summary.lastApply) return [{ label: `firewall · ${engine} · não aplicado`, level: "warn" }];
  return [{ label: `firewall · ${engine} · ${summary.lastApply.rules} regras`, level: chipLevel(summary), detail: chipDetail(summary) }];
}

function chipLevel({ pending, listsMatchLastApply }: Summary): Level {
  if (pending.state === "reverted") return "error";
  if (pending.state !== "none" || !listsMatchLastApply) return "warn";
  return "ok";
}

function chipDetail({ pending, listsMatchLastApply }: Summary): string | undefined {
  if (pending.state === "pending") return "aguardando confirmação";
  if (!listsMatchLastApply) return "listas mudaram";
  return undefined;
}

async function firewallAttention(ctx: ReadCtx): Promise<Attentions> {
  const { missingBase, pending } = await readSummary(ctx);
  const attention: Attentions = [];
  if (missingBase.length) attention.push({ level: "warn", title: `firewall: faltam ${missingBase.length} IP(s) base da Phonevox`, fix: FIX.trustPhonevox });
  if (pending.state === "pending") attention.push({ level: "warn", title: `firewall: reversão automática em ${pending.left}s`, fix: FIX.confirm });
  return attention;
}
