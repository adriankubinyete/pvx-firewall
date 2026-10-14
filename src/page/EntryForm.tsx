/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// The form that adds an entry or edits the comment of one (with the `remover` button, which the framework confirms).
import type { FieldSpec, SdkUi } from "@pvx/sdk";
import { firstInvalidValue, type ListName } from "../state.ts";
import { isDeny, type EntryKind, type EntryRow } from "./rows.ts";

export type FormTarget = { mode: "add"; kind: EntryKind } | { mode: "edit"; row: EntryRow };
type Values = Record<string, string | boolean>;

type Verdict = "accept" | "deny";
const LIST_OF: Record<EntryKind, Record<Verdict, ListName>> = {
  ip: { accept: "ipAccept", deny: "ipDeny" },
  port: { accept: "portAccept", deny: "portDeny" },
};

const VALUE_LABEL: Record<EntryKind, string> = { ip: "IP ou CIDR", port: "porta (5060/udp, 10000-20000/tcp)" };
const ADD_TITLE: Record<EntryKind, string> = { ip: "adicionar IP", port: "adicionar porta" };
const INVALID_VALUE: Record<EntryKind, string> = { ip: "IP/CIDR inválido", port: "porta inválida" };

const addFields = (kind: EntryKind): FieldSpec[] => [
  { id: "value", label: VALUE_LABEL[kind], kind: "line" },
  { id: "verdict", label: "ação", kind: "choice", options: [{ value: "accept", label: "aceitar" }, { value: "deny", label: "bloquear" }] },
  { id: "comment", label: "comentário", kind: "line" },
];
const EDIT_FIELDS: FieldSpec[] = [{ id: "comment", label: "comentário", kind: "line" }];

/** Inline errors under the field: the value is required and every comma-separated piece must be valid. */
export const validateNewEntry = (kind: EntryKind) => (values: Values): Record<string, string> | void => {
  const text = String(values.value ?? "").trim();
  if (!text) return { value: "informe o valor" };
  const invalid = firstInvalidValue(LIST_OF[kind].accept, text);
  if (invalid !== undefined) return { value: `${INVALID_VALUE[kind]}: ${invalid}` };
};

export interface NewEntry {
  list: ListName;
  value: string;
  comment: string;
}

/** What the add form asked for. */
export function newEntryOf(kind: EntryKind, values: Values): NewEntry {
  const verdict: Verdict = values.verdict === "deny" ? "deny" : "accept";
  return { list: LIST_OF[kind][verdict], value: String(values.value ?? "").trim(), comment: String(values.comment ?? "").trim() };
}

export interface EntryFormProps {
  target: FormTarget;
  onAdd: (entry: NewEntry) => void;
  onEditComment: (row: EntryRow, comment: string) => void;
  onRemove: (row: EntryRow) => void;
  onCancel: () => void;
}

export const makeEntryForm = ({ h, Panel, Text, Fields }: SdkUi) =>
  function EntryForm({ target, onAdd, onEditComment, onRemove, onCancel }: EntryFormProps) {
    if (target.mode === "add") {
      return (
        <Panel>
          <Panel title={ADD_TITLE[target.kind]} tone="accent">
            <Fields fields={addFields(target.kind)} validate={validateNewEntry(target.kind)} onSubmit={(values) => onAdd(newEntryOf(target.kind, values))} onCancel={onCancel} />
          </Panel>
        </Panel>
      );
    }
    const { row } = target;
    return (
      <Panel>
        <Panel title={`comentar ${row.entry.value}`} tone="accent">
          <Text tone="dim">{`${isDeny(row.list) ? "bloquear" : "aceitar"} · ${row.entry.source}`}</Text>
          <Fields
            fields={EDIT_FIELDS}
            initial={{ comment: row.entry.comment }}
            onSubmit={(values) => onEditComment(row, String(values.comment ?? "").trim())}
            onCancel={onCancel}
            onDelete={() => onRemove(row)}
          />
        </Panel>
      </Panel>
    );
  };
