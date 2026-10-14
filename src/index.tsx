// pvx module `firewall`. The factory only builds the object: every effect happens inside run(), prove() or a query.
// All process execution goes through ctx.exec, so the trust review has nothing to warn about. This file only wires the parts.
import type { ModuleFactory } from "@pvx/sdk";
import { applyCommands } from "./commands/apply.ts";
import { asteriskCommands } from "./commands/asterisk.ts";
import { bootCommands } from "./commands/boot.ts";
import { engineCommands } from "./commands/engine.ts";
import { listCommands } from "./commands/lists.ts";
import { capabilities } from "./health/prove.ts";
import { queries } from "./health/queries.ts";
import { widgets } from "./health/widgets.ts";
import { page } from "./page/index.tsx";

const PAGE_TAB_ORDER = 30;

export const factory: ModuleFactory = (sdk) => ({
  commands: { ...applyCommands(sdk.errors), ...engineCommands, ...listCommands, ...asteriskCommands, ...bootCommands(sdk.errors) },
  capabilities: capabilities(sdk.proof),
  queries,
  widgets,
  pages: {
    firewall: { title: "Firewall", render: page(sdk), tab: { label: "Firewall", order: PAGE_TAB_ORDER } },
  },
});
export default factory;
