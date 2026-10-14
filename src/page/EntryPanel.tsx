/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// Panels [2] IPs and [3] portas: a table of entries and, under it, the action rows. The selection shows only while the list has the focus.
import type { Component, SdkUi } from "@pvx/sdk";
import { LIST_COLUMNS, actionItem, entryItem, positionText, rowsAround, type PanelRows } from "./rows.ts";

export interface EntryPanelProps {
  title: string;
  rows: PanelRows;
  /** The remembered selection (an entry or action id). */
  selectedId: string | undefined;
  /** Only the list with the focus draws its selection. */
  listActive: boolean;
  panelFocused: boolean;
  /** Entries shown; 0 collapses the panel to its title. */
  capacity: number;
  grow: boolean;
  panelRef: unknown;
  onPanelPress: () => void;
  onRowPress: (id: string) => void;
  onRowHover: (id: string | undefined) => void;
}

export const makeEntryPanel = ({ h, Panel, List, Text, useTheme }: SdkUi): Component<EntryPanelProps> =>
  function EntryPanel(props) {
    const { g } = useTheme();
    const { rows, selectedId, listActive, capacity } = props;
    const selected = listActive ? selectedId : undefined;
    const title = `${props.title} ${positionText(rows, selectedId)}${props.panelFocused ? ` ${g.active}` : ""}`;
    const onActionRow = rows.actions.some((row) => row.id === selectedId);
    const anchorId = onActionRow ? rows.entries.at(-1)?.id : selectedId;
    const shown = rowsAround(rows.entries, anchorId, capacity);
    return (
      <Panel title={title} tone={props.panelFocused ? "accent" : undefined} grow={props.grow} panelRef={props.panelRef} onPress={props.onPanelPress}>
        {capacity > 0 && shown.length ? <List items={shown.map(entryItem)} columns={LIST_COLUMNS} selected={selected} onPress={props.onRowPress} onHover={props.onRowHover} /> : null}
        {capacity > 0 && !shown.length ? <Text tone="dim">—</Text> : null}
        {capacity > 0 ? <List items={rows.actions.map(actionItem)} selected={selected} onPress={props.onRowPress} onHover={props.onRowHover} /> : null}
      </Panel>
    );
  };
