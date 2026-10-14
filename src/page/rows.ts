// The rows of the two list panels, from the lists in the store. Pure.
import type { ListColumn, ListItem, Tone } from "@pvx/sdk";
import { isIp, type Entry, type FwState, type ListName, type Source } from "../state.ts";
import type { ListPanelId } from "./layout.ts";

export type EntryKind = "ip" | "port";

/** One entry of a list; its id is `<list>:<value>`, so the selection survives reordering. */
export interface EntryRow {
  id: string;
  list: ListName;
  entry: Entry;
}

export type ActionId = "add" | "trust";

/** A row that does something instead of showing an entry: it sits under the entries. */
export interface ActionRow {
  id: ActionId;
  label: string;
}

export interface PanelRows {
  kind: EntryKind;
  entries: EntryRow[];
  actions: ActionRow[];
}

export const kindOfList = (list: ListName): EntryKind => (isIp(list) ? "ip" : "port");

export const KIND_OF_PANEL: Record<ListPanelId, EntryKind> = { ips: "ip", ports: "port" };

const ADD_ACTION: ActionRow = { id: "add", label: "+ adicionar…" };
const TRUST_ACTION: ActionRow = { id: "trust", label: "+ confiar IPs da Phonevox" };

const entryRows = (state: FwState, accept: ListName, deny: ListName): EntryRow[] =>
  [accept, deny].flatMap((list) => state[list].map((entry) => ({ id: `${list}:${entry.value}`, list, entry })));

export function panelRows(state: FwState, kind: EntryKind): PanelRows {
  if (kind === "ip") return { kind, entries: entryRows(state, "ipAccept", "ipDeny"), actions: [ADD_ACTION, TRUST_ACTION] };
  return { kind, entries: entryRows(state, "portAccept", "portDeny"), actions: [ADD_ACTION] };
}

/** Every row a key can land on, in the order they are drawn. */
export const rowIds = (rows: PanelRows): string[] => [...rows.entries.map((row) => row.id), ...rows.actions.map((row) => row.id)];

export const isDeny = (list: ListName): boolean => list === "ipDeny" || list === "portDeny";

// ---- the List ----

const VALUE_WIDTH = 17; // the longest base entry: 186.233.120.72/29
const VERDICT_WIDTH = 8; // "bloquear"
const SOURCE_WIDTH = 8; // "asterisk"

export const LIST_COLUMNS: ListColumn[] = [
  { id: "value", title: "valor", width: VALUE_WIDTH },
  { id: "verdict", title: "ação", width: VERDICT_WIDTH },
  { id: "source", title: "origem", width: SOURCE_WIDTH },
  { id: "comment", title: "comentário", grow: 1 },
];

const SOURCE_TEXT: Record<Source, string> = { base: "base", asterisk: "asterisk", manual: "manual" };
const SOURCE_TONE: Record<Source, Tone> = { base: "dim", asterisk: "info", manual: "accent" };

/** An empty cell is `—` (UI.md §6). */
const EMPTY_CELL = "—";

export function entryItem({ id, list, entry }: EntryRow): ListItem {
  const deny = isDeny(list);
  return {
    id,
    cells: {
      value: entry.value,
      verdict: { text: deny ? "bloquear" : "aceitar", tone: deny ? "error" : "text" },
      source: { text: SOURCE_TEXT[entry.source], tone: SOURCE_TONE[entry.source] },
      comment: entry.comment || EMPTY_CELL,
    },
  };
}

export const actionItem = ({ id, label }: ActionRow): ListItem => ({ id, label, tone: "accent" });

// ---- position ----

/** `3/13` for the selected entry, or just `13` when the selection is not on an entry. */
export function positionText(rows: PanelRows, selectedId: string | undefined): string {
  const index = rows.entries.findIndex((row) => row.id === selectedId);
  return index < 0 ? String(rows.entries.length) : `${index + 1}/${rows.entries.length}`;
}
