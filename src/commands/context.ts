// What the commands share: the engine's Io and the engine to drive.
import type { CommandCtx } from "@pvx/sdk";
import { resolveEngine, zoneOf, type ResolvedEngine } from "../engines/index.ts";
import type { Io } from "../engines/types.ts";
import { isEngineProblem } from "../health/summary.ts";

export const ioOf = (ctx: CommandCtx): Io => ({ exec: ctx.exec, fs: ctx.fs, zone: zoneOf(ctx.store) });

export interface DrivableEngine extends ResolvedEngine {
  io: Io;
}

/** The engine to drive, or undefined after printing why it cannot be (the command then just returns). */
export async function engineOrReport(ctx: CommandCtx): Promise<DrivableEngine | undefined> {
  const resolved = await resolveEngine(ctx.exec, ctx.store);
  if (isEngineProblem(resolved)) {
    ctx.out.error(resolved.error);
    return undefined;
  }
  return { ...resolved, io: ioOf(ctx) };
}
