// The module's own commands the page runs. Each one goes through the session, so it lands in the scrollback, the history and the audit.
import type { CommandRun, SdkUi } from "@pvx/sdk";
import type { ListName } from "../state.ts";
import type { EntryKind } from "./rows.ts";

export interface FirewallCommands {
  addEntry(list: ListName, value: string, comment: string): Promise<CommandRun>;
  removeEntry(kind: EntryKind, value: string): Promise<CommandRun>;
  trustPhonevox(): Promise<CommandRun>;
  /** Destructive: the host asks for the confirmation before it runs. */
  apply(): Promise<CommandRun>;
  confirm(): Promise<CommandRun>;
}

export const makeCommands = ({ useCommand }: SdkUi) =>
  function useFirewallCommands(): FirewallCommands {
    const acceptIp = useCommand("firewall ip accept");
    const denyIp = useCommand("firewall ip deny");
    const removeIp = useCommand("firewall ip remove");
    const acceptPort = useCommand("firewall port accept");
    const denyPort = useCommand("firewall port deny");
    const removePort = useCommand("firewall port remove");
    const trust = useCommand("firewall ip trust-phonevox");
    const apply = useCommand("firewall apply");
    const confirm = useCommand("firewall confirm");

    const addCommandOf = { ipAccept: acceptIp, ipDeny: denyIp, portAccept: acceptPort, portDeny: denyPort };
    const removeCommandOf = { ip: removeIp, port: removePort };

    return {
      addEntry: (list, value, comment) => addCommandOf[list].run({ args: [value, ...(comment ? ["--comment", comment] : [])] }),
      removeEntry: (kind, value) => removeCommandOf[kind].run({ args: [value] }),
      trustPhonevox: () => trust.run(),
      apply: () => apply.run(),
      confirm: () => confirm.run(),
    };
  };
