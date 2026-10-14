// What a page says about a command it ran. Pure, except `attempt`.
import type { CommandRun, OutLine, Tone } from "@pvx/sdk";
import { errorMessage } from "../exec.ts";

export interface Notice {
  text: string;
  tone: Tone;
}

const TONE_BY_KIND: Record<OutLine["kind"], Tone> = { success: "ok", warning: "warn", error: "error", info: "info", plain: "text" };
export const toneOfLine = (line: OutLine): Tone => TONE_BY_KIND[line.kind];

/** The first thing worth saying about a run: an error, else a success or warning, else the first line. */
function lineWorthSaying(run: CommandRun): OutLine | undefined {
  const error = run.lines.find((line) => line.kind === "error");
  if (error) return error;
  const verdict = run.lines.find((line) => line.kind === "success" || line.kind === "warning");
  return verdict ?? run.lines[0];
}

export function headlineOf(run: CommandRun): Notice {
  const line = lineWorthSaying(run);
  const text = line?.text ?? (run.exit === 0 ? "ok" : `saiu ${run.exit}`);
  if (run.exit !== 0) return { text, tone: "error" };
  return { text, tone: line ? toneOfLine(line) : "ok" };
}

/** Runs a command; a throw (the host refusing it, say) becomes a failed run, so the page shows the result screen for it too. */
export async function attempt(action: () => Promise<CommandRun>): Promise<CommandRun> {
  try {
    return await action();
  } catch (error) {
    return failedRun(errorMessage(error));
  }
}

export const failedRun = (message: string): CommandRun => ({ exit: 1, lines: [{ kind: "error", text: message }] });
