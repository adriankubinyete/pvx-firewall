/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// The tab: [1] status, [2] IPs, [3] portas. Focus has the four levels of UI.md §1 (tab bar, page, panel, row) and the mouse reaches everything.
import type { SdkUi } from "@pvx/sdk";
import type { StatusView } from "../health/queries.ts";
import type { FwState } from "../state.ts";
import { needsApplyNotice } from "../texts.ts";
import { makeEntryPanel } from "./EntryPanel.tsx";
import { makeStatusPanel } from "./StatusPanel.tsx";
import { listLayout, type ListPanelId } from "./layout.ts";
import { needsApplyReason } from "./status-lines.ts";
import { KIND_OF_PANEL, panelRows, rowIds, type ActionId, type EntryKind, type EntryRow, type PanelRows } from "./rows.ts";

/** How often the status panel asks the engine again. Each ask runs a few read-only probes. */
const STATUS_REFRESH_MS = 5000;

export type PanelId = "status" | ListPanelId;
type Direction = "left" | "right" | "up" | "down";
type Key = Direction | "enter";

/** Where the focus is: on a panel as a whole (`inside` false) or on the rows of its list. */
export interface Focus {
  panel: PanelId;
  inside: boolean;
}

/** The remembered row of each list (an entry or an action id). */
export type Selection = Record<ListPanelId, string | undefined>;

export const INITIAL_FOCUS: Focus = { panel: "status", inside: false };
export const INITIAL_SELECTION: Selection = { ips: undefined, ports: undefined };

const PANEL_TITLE: Record<PanelId, string> = { status: "[1] status", ips: "[2] IPs", ports: "[3] portas" };

const isPanelId = (id: string): id is PanelId => id === "status" || id === "ips" || id === "ports";
const isListPanel = (id: string): id is ListPanelId => id === "ips" || id === "ports";

export interface MainScreenProps {
  lists: FwState;
  /** Focus and selection live in the page, so they survive a form or a result screen: success returns to the same row. */
  focus: Focus;
  onFocusChange: (focus: Focus) => void;
  selection: Selection;
  onSelectionChange: (selection: Selection) => void;
  /** Bumped after every change: the status query asks again. */
  revision: number;
  onAdd: (kind: EntryKind) => void;
  onEdit: (row: EntryRow) => void;
  onTrust: () => void;
  onReview: () => void;
}

export const makeMainScreen = (ui: SdkUi) => {
  const { h, Panel, Row: SideBySide, Text, Notice, Button, useRef, useKey, useBack, useNudge, usePanels, usePageFocused, useQuery, useViewport } = ui;
  const StatusPanel = makeStatusPanel(ui);
  const EntryPanel = makeEntryPanel(ui);

  /** The keys of the level the focus is on live in their own component, so the footer follows the level. */
  function PanelLevelKeys({ onKey }: { onKey: (key: Key) => void }) {
    useKey("←", "painel", () => onKey("left"));
    useKey("→", "painel", () => onKey("right"), { help: true });
    useKey("↑", "painel", () => onKey("up"), { help: true });
    useKey("↓", "painel", () => onKey("down"), { help: true });
    useKey("enter", "entra", () => onKey("enter"), { help: true });
    return null;
  }

  /** `enter` is the List's own action (`onAction`), so only the arrows are mapped here. */
  function InsideKeys({ onKey }: { onKey: (key: Key) => void }) {
    useKey("↑", "sobe", () => onKey("up"), { help: true });
    useKey("↓", "desce", () => onKey("down"), { help: true });
    return null;
  }

  /** `1`, `2` and `3` jump straight to a panel, from any level. */
  function JumpKeys({ onJump }: { onJump: (panel: PanelId) => void }) {
    useKey("1", "status", () => onJump("status"), { help: true });
    useKey("2", "IPs", () => onJump("ips"), { help: true });
    useKey("3", "portas", () => onJump("ports"), { help: true });
    return null;
  }

  function RefreshKey({ onRefresh }: { onRefresh: () => void }) {
    useKey("r", "atualiza", onRefresh);
    return null;
  }

  function AddKey({ onAdd }: { onAdd: () => void }) {
    useKey("a", "adiciona", onAdd);
    return null;
  }

  function TrustKey({ onTrust }: { onTrust: () => void }) {
    useKey("t", "trust-phonevox", onTrust);
    return null;
  }

  return function MainScreen({ lists, focus, onFocusChange: setFocus, selection, onSelectionChange: setSelection, revision, onAdd, onEdit, onTrust, onReview }: MainScreenProps) {
    const panels = usePanels();
    const nudge = useNudge();
    const viewport = useViewport();
    const pageFocused = usePageFocused();
    const status = useQuery<StatusView>("firewall.status", [revision], { refreshMs: STATUS_REFRESH_MS });
    const pendingReason = needsApplyReason(status.data);
    // A mouse down bubbles from a row to its panel: the row marks it so the panel does not undo what the row did.
    const rowPressed = useRef(false);

    const rows: Record<ListPanelId, PanelRows> = { ips: panelRows(lists, "ip"), ports: panelRows(lists, "port") };
    const selectedIdOf = (panel: ListPanelId): string => {
      const ids = rowIds(rows[panel]);
      return ids.find((id) => id === selection[panel]) ?? ids[0]!;
    };
    const sizeOf = (panel: string): number => (isListPanel(panel) ? rowIds(rows[panel]).length : 0);

    const select = (panel: ListPanelId, id: string) => setSelection({ ...selection, [panel]: id });
    const moveSelection = (panel: ListPanelId, move: number) => {
      const ids = rowIds(rows[panel]);
      select(panel, ids[panels.wrap(ids.indexOf(selectedIdOf(panel)), move, ids.length)]!);
    };

    const runAction = (kind: EntryKind, action: ActionId) => (action === "add" ? onAdd(kind) : onTrust());
    const openRow = (panel: ListPanelId) => (id: string) => {
      const entry = rows[panel].entries.find((row) => row.id === id);
      if (entry) return onEdit(entry);
      const action = rows[panel].actions.find((row) => row.id === id);
      if (action) runAction(KIND_OF_PANEL[panel], action.id);
    };

    /** The two-level rule of the host for one key: pick a panel, go inside, move, act. */
    const press = (key: Key) => {
      const step = panels.step({ panel: focus.panel, inside: focus.inside }, key, sizeOf);
      if (!step) return;
      if (step.bar) return panels.toBar();
      if (step.nudge) return nudge(step.nudge);
      const panel = step.panel;
      if (!isPanelId(panel)) return;
      if (isListPanel(panel) && step.move) moveSelection(panel, step.move);
      setFocus({ panel, inside: step.inside });
    };
    useBack(focus.inside ? () => setFocus({ ...focus, inside: false }) : undefined);

    const pressPanel = (panel: PanelId) => () => {
      if (rowPressed.current) {
        rowPressed.current = false;
        return;
      }
      setFocus({ panel, inside: false });
    };
    const pressRow = (panel: ListPanelId) => (id: string) => {
      rowPressed.current = true;
      select(panel, id);
      setFocus({ panel, inside: true });
    };
    // Hover moves the selection only in the list that has the focus (UI.md §2); elsewhere the List tints the row by itself.
    const hoverRow = (panel: ListPanelId) => (id: string | undefined) => {
      if (id && focus.inside && focus.panel === panel) select(panel, id);
    };

    const activeList: ListPanelId = focus.panel === "ports" ? "ports" : "ips";
    const layout = listLayout(viewport, activeList, { ips: rows.ips.actions.length, ports: rows.ports.actions.length });
    const focusedPanel = (panel: PanelId) => pageFocused && focus.panel === panel;

    const listPanel = (panel: ListPanelId) => (
      <EntryPanel
        key={panel}
        title={PANEL_TITLE[panel]}
        rows={rows[panel]}
        selectedId={selectedIdOf(panel)}
        listActive={focusedPanel(panel) && focus.inside}
        panelFocused={focusedPanel(panel)}
        capacity={layout.capacity[panel]}
        grow={layout.sideBySide}
        panelRef={panels.ref(panel)}
        onPanelPress={pressPanel(panel)}
        onRowPress={pressRow(panel)}
        onRowAction={openRow(panel)}
        onRowHover={hoverRow(panel)}
      />
    );
    const listPanels = [listPanel("ips"), listPanel("ports")];

    return (
      <Panel>
        {focus.inside ? <InsideKeys onKey={press} /> : <PanelLevelKeys onKey={press} />}
        <JumpKeys onJump={(panel) => setFocus({ panel, inside: false })} />
        <RefreshKey onRefresh={() => void status.refetch()} />
        {focus.panel === "status" ? null : <AddKey onAdd={() => onAdd(KIND_OF_PANEL[activeList])} />}
        {focus.panel === "ips" ? <TrustKey onTrust={onTrust} /> : null}
        <SideBySide>
          <Button label="aplicar" primary keys="A" onPress={onReview} />
          {pendingReason ? <Notice level="warn">{needsApplyNotice(pendingReason)}</Notice> : <Text tone="dim"> </Text>}
        </SideBySide>
        <StatusPanel title={PANEL_TITLE.status} status={status} focused={focusedPanel("status")} panelRef={panels.ref("status")} onPress={pressPanel("status")} />
        {layout.sideBySide ? <SideBySide>{listPanels}</SideBySide> : listPanels}
      </Panel>
    );
  };
};
