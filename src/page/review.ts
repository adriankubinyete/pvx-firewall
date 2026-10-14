// What the apply review says, as data. Pure: the components only draw it.
import type { ListItem } from "@pvx/sdk";
import type { DiffView } from "../health/summary.ts";
import { ipToInt } from "../net.ts";
import type { FwState, ListName } from "../state.ts";

/** The rules that would leave (`-`, first) and enter (`+`), as the rows of the details view. */
export const reviewItems = ({ removed, added }: DiffView): ListItem[] => [
  ...removed.map((rule) => ({ id: `-${rule}`, label: rule, mark: { text: "-", tone: "error" as const } })),
  ...added.map((rule) => ({ id: `+${rule}`, label: rule, mark: { text: "+", tone: "ok" as const } })),
];

/** Is there an IP the failsafe rule can keep open? Without one an apply can cut the technician off. */
export const hasFailsafe = (diff: DiffView): boolean => diff.session !== undefined;

/** The text of the field `informar meu IP`: an error message, or undefined when it is a single IPv4. */
export function informedIpError(text: string): string | undefined {
  if (ipToInt(text.trim()) !== undefined) return undefined;
  return `IP inválido: ${text.trim() || "—"}`;
}

const ELLIPSIS = "…";
const SEPARATOR = ", ";

/** The values joined by commas, cut at a whole value and ended with `…` when they do not fit in `width` cells. */
export function joinFit(values: string[], width: number): string {
  const all = values.join(SEPARATOR);
  if (all.length <= width) return all;
  let fitted = "";
  for (const value of values) {
    const next = fitted ? `${fitted}${SEPARATOR}${value}` : value;
    if (next.length + SEPARATOR.length + ELLIPSIS.length > width) break;
    fitted = next;
  }
  return fitted ? `${fitted}${SEPARATOR}${ELLIPSIS}` : ELLIPSIS;
}

export interface SummaryRow {
  id: string;
  label: string;
  /** Empty for a row that has no count (`o resto`). */
  count: string;
  values: string;
}

/** The lists, grouped the way a technician thinks about them. A list with nothing in it is not shown, except the two that always matter. */
const GROUPS: { id: ListName; label: string; always: boolean }[] = [
  { id: "ipAccept", label: "IPs aceitos", always: true },
  { id: "ipDeny", label: "IPs bloqueados", always: false },
  { id: "portAccept", label: "portas liberadas", always: true },
  { id: "portDeny", label: "portas bloqueadas", always: false },
];

export const REST_ROW: SummaryRow = { id: "rest", label: "o resto", count: "", values: "bloqueado" };

/** One row per list and `o resto`, and `removidas` when an apply would drop rules that are loaded now. */
export function summaryRows(lists: FwState, diff: DiffView, valuesWidth: number): SummaryRow[] {
  const rows: SummaryRow[] = [];
  for (const group of GROUPS) {
    const values = lists[group.id].map((entry) => entry.value);
    if (!values.length && !group.always) continue;
    rows.push({ id: group.id, label: group.label, count: String(values.length), values: joinFit(values, valuesWidth) });
  }
  rows.push(REST_ROW);
  if (diff.removed.length) rows.push({ id: "removed", label: "removidas", count: String(diff.removed.length), values: "regras que deixam de valer" });
  return rows;
}

const LABEL_WIDTH = 18;
const COUNT_WIDTH = 3;
const COLUMN_GAP = "  ";

/** Columns of one row: label, count (right-aligned) and values. */
export const rowText = ({ label, count, values }: SummaryRow): string => `${label.padEnd(LABEL_WIDTH)}${count.padStart(COUNT_WIDTH)}${COLUMN_GAP}${values}`;

/** Cells the values column has when the review is drawn in `cols` columns. */
const FRAME_COLS = 12;
export const valuesWidth = (cols: number): number => cols - FRAME_COLS - LABEL_WIDTH - COUNT_WIDTH - COLUMN_GAP.length;

/** The line under the summary that says what the host does after the apply. */
export const afterApplyText = (seconds: number): string => `depois de aplicar: ${seconds}s para confirmar, senão as regras voltam`;

export const rulesButtonLabel = (diff: DiffView): string => `ver as ${diff.added.length + diff.removed.length} regras`;
