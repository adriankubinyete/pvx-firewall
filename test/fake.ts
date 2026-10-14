// The module's test seam over `@pvx/testing`'s fake system: only what is specific to the firewall lives here.
import type { Shell } from "@pvx/sdk";
import { createShell } from "@pvx/core";
import { callLine, fakeFs, fakeReadCtx, fakeSdk, fakeSystem, memStore, type Call, type Reply } from "@pvx/testing";
import type { Desired, ExecFn, Io } from "../src/engines/types.ts";

export { fakeFs, fakeReadCtx, fakeSdk, fakeSystem, memStore };
export type { Call };

/** An exec that records every call and answers by `reply` (default: exit 0, no output). Nothing real runs. */
export const fakeExec = (reply: (call: Call) => Reply | undefined = () => undefined): { exec: ExecFn; calls: Call[] } => {
  const system = fakeSystem({ rules: [reply] });
  return { exec: system.exec, calls: system.calls };
};

export const line = callLine;

/** `ctx.shell` over a fake exec, as a command gets it. */
export const shellOf = (exec: ExecFn): Shell => createShell(exec);

export const io = (exec: ExecFn, fs = fakeFs(), zone?: string): Io => ({ exec, shell: shellOf(exec), fs, zone });

export const sample: Desired = {
  ipAccept: ["127.0.0.1", "10.0.0.0/8", "203.0.113.9"],
  ipDeny: ["198.51.100.0/24"],
  portAccept: ["5060/udp", "10000-20000/udp"],
  portDeny: ["80/tcp", "20-23"],
  failsafe: "203.0.113.7",
};
