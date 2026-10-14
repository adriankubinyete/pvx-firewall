/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// Panel [1]: the live state of the firewall, read with `useQuery` (so a refresh is not a command in the history).
import type { SdkUi } from "@pvx/sdk";
import type { StatusView } from "../health/queries.ts";
import { statusLines } from "./status-lines.ts";

export interface StatusPanelProps {
  title: string;
  /** The result of `useQuery("firewall.status")`. */
  status: { data?: StatusView; error?: string; loading: boolean };
  focused: boolean;
  panelRef: unknown;
  onPress: () => void;
}

export const makeStatusPanel = ({ h, Panel, Text, Loading, useTheme }: SdkUi) =>
  function StatusPanel({ title, status, focused, panelRef, onPress }: StatusPanelProps) {
    const { g } = useTheme();
    return (
      <Panel title={`${title}${focused ? ` ${g.active}` : ""}`} tone={focused ? "accent" : undefined} panelRef={panelRef} onPress={onPress}>
        {status.data ? statusLines(status.data).map((line, index) => <Text key={index} tone={line.tone}>{line.text}</Text>) : null}
        {!status.data && status.loading ? <Loading label="consultando o firewall…" /> : null}
        {status.error ? <Text tone="error">{status.error}</Text> : null}
      </Panel>
    );
  };
