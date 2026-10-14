// How the page spends the terminal. Pure, so the frame tests and the page agree on the numbers.
// A page does not scroll and the `List` does not window, so the lists show only the rows that fit around the selected one.

export interface Viewport {
  cols: number;
  rows: number;
}

export type ListPanelId = "ips" | "ports";

/**
 * The two lists sit side by side from this width, stacked below it. UI.md §9 says 100 for panels in general, but each list
 * has four columns (valor, ação, origem, comentário): at 100 the comment column would be two characters wide.
 */
export const SIDE_BY_SIDE_COLS = 120;

/** Rows the host spends around a page: the tab bar, the footer and the border of the page frame. */
const HOST_CHROME_ROWS = 6;
/** The line with the `aplicar` button and the notice. */
const TOP_BAR_ROWS = 1;
/** Top and bottom border of a `Panel`. */
const PANEL_FRAME_ROWS = 2;
/** The status panel's text lines (see `statusLines`). */
export const STATUS_LINES = 4;
const STATUS_PANEL_ROWS = STATUS_LINES + PANEL_FRAME_ROWS;
/** The column titles of a list. */
const LIST_HEADER_ROWS = 1;
/** Fewest entries a list shows; below it the other list collapses. */
const MIN_ENTRY_ROWS = 2;

export interface ListLayout {
  sideBySide: boolean;
  /** Entry rows each list shows; 0 means the panel is collapsed to its title. */
  capacity: Record<ListPanelId, number>;
}

/**
 * Side by side, each list takes the full height. Stacked, the two share it when both fit; when the terminal is too short
 * (80x24), the list that has the focus gets it all and the other one collapses to its title.
 * `actionRows`: the rows under each list that are always shown (the "+ adicionar…" buttons).
 */
export function listLayout(viewport: Viewport, active: ListPanelId, actionRows: Record<ListPanelId, number>): ListLayout {
  const free = viewport.rows - HOST_CHROME_ROWS - TOP_BAR_ROWS - STATUS_PANEL_ROWS;
  const fixedRows = (id: ListPanelId) => PANEL_FRAME_ROWS + LIST_HEADER_ROWS + actionRows[id];
  const atLeast = (rows: number) => Math.max(MIN_ENTRY_ROWS, rows);

  if (viewport.cols >= SIDE_BY_SIDE_COLS) {
    return { sideBySide: true, capacity: { ips: atLeast(free - fixedRows("ips")), ports: atLeast(free - fixedRows("ports")) } };
  }
  const shared = Math.floor((free - fixedRows("ips") - fixedRows("ports")) / 2);
  if (shared >= MIN_ENTRY_ROWS) return { sideBySide: false, capacity: { ips: shared, ports: shared } };

  // The collapsed panel keeps its two border rows.
  const activeRows = atLeast(free - PANEL_FRAME_ROWS - fixedRows(active));
  return { sideBySide: false, capacity: active === "ips" ? { ips: activeRows, ports: 0 } : { ips: 0, ports: activeRows } };
}

/** Rule lines the apply review shows: what is left after the frame, the headline, the warnings and the buttons line. */
const REVIEW_FIXED_LINES = 2;
const MIN_REVIEW_ROWS = 3;

export const reviewCapacity = (viewport: Viewport, warningLines: number): number =>
  Math.max(MIN_REVIEW_ROWS, viewport.rows - HOST_CHROME_ROWS - PANEL_FRAME_ROWS - REVIEW_FIXED_LINES - warningLines);
