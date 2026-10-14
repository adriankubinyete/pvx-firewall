// The pure parts of the page: layout, rows, form validation and the words about a command run. No terminal.
import { expect, test } from "bun:test";
import type { CommandRun, OutLine } from "@pvx/sdk";
import { newEntryOf, validateNewEntry } from "../src/page/EntryForm.tsx";
import { listLayout, reviewMaxRows, type ListPanelId } from "../src/page/layout.ts";
import { headlineOf } from "../src/page/outcome.ts";
import { panelRows, positionText } from "../src/page/rows.ts";
import { seed } from "../src/state.ts";

const ACTION_ROWS = { ips: 2, ports: 1 };
/** Rows the host spends around a page (tab bar, footer, frame), the top bar and the status panel: see layout.ts. */
const FIXED_ROWS = 6 + 1 + 6;
const PANEL_FRAME = 2;
const COLUMN_HEADER = 1;

test("the lists never need more rows than the terminal has, from 80x24 up", () => {
  for (const cols of [80, 100, 119]) {
    for (let rows = 24; rows <= 60; rows++) {
      for (const active of ["ips", "ports"] as ListPanelId[]) {
        const { capacity } = listLayout({ cols, rows }, active, ACTION_ROWS);
        const panelRowsOf = (id: ListPanelId) => (capacity[id] > 0 ? PANEL_FRAME + COLUMN_HEADER + capacity[id] + ACTION_ROWS[id] : PANEL_FRAME);
        expect(FIXED_ROWS + panelRowsOf("ips") + panelRowsOf("ports")).toBeLessThanOrEqual(rows);
      }
    }
  }
});

test("side by side from 120 columns; stacked below, the focused list gets the height when both do not fit", () => {
  expect(listLayout({ cols: 120, rows: 30 }, "ips", ACTION_ROWS).sideBySide).toBe(true);
  expect(listLayout({ cols: 119, rows: 30 }, "ips", ACTION_ROWS).sideBySide).toBe(false);
  expect(listLayout({ cols: 80, rows: 24 }, "ports", ACTION_ROWS).capacity.ips).toBe(0);
  expect(listLayout({ cols: 80, rows: 24 }, "ports", ACTION_ROWS).capacity.ports).toBeGreaterThan(1);
  const tall = listLayout({ cols: 80, rows: 50 }, "ips", ACTION_ROWS).capacity;
  expect(tall.ips).toBeGreaterThan(1);
  expect(tall.ports).toBeGreaterThan(1);
});

test("the review shows at least a few rules, even in a short terminal", () => {
  expect(reviewMaxRows({ cols: 80, rows: 24 }, 2)).toBeGreaterThanOrEqual(3);
});

test("the IP panel has the two action rows, the port panel one; entries are by list and value", () => {
  const ips = panelRows(seed(), "ip");
  expect(ips.actions.map((row) => row.id)).toEqual(["add", "trust"]);
  expect(panelRows(seed(), "port").actions.map((row) => row.id)).toEqual(["add"]);
  expect(ips.entries[0]!.id).toBe("ipAccept:127.0.0.1");
  expect(positionText(ips, "ipAccept:10.0.0.0/8")).toBe("2/13");
  expect(positionText(ips, "add")).toBe("13");
});

test("the add form blocks an empty or invalid value and names the piece that is wrong", () => {
  const validateIp = validateNewEntry("ip");
  expect(validateIp({ value: "  " })).toEqual({ value: "informe o valor" });
  expect(validateIp({ value: "10.0.0.1, 300.1.1.1" })).toEqual({ value: "IP/CIDR inválido: 300.1.1.1" });
  expect(validateIp({ value: "10.0.0.1,10.0.0.2" })).toBeUndefined();
  expect(validateNewEntry("port")({ value: "99999" })).toEqual({ value: "porta inválida: 99999" });
});

test("the add form's choice picks the list", () => {
  expect(newEntryOf("ip", { value: " 1.2.3.4 ", verdict: "deny", comment: " x " })).toEqual({ list: "ipDeny", value: "1.2.3.4", comment: "x" });
  expect(newEntryOf("port", { value: "80", verdict: "accept", comment: "" }).list).toBe("portAccept");
});

test("the headline of a run is the error, else the success or warning, else the first line", () => {
  const run = (exit: number, ...lines: OutLine[]): CommandRun => ({ exit, lines });
  const info: OutLine = { kind: "info", text: "a" };
  expect(headlineOf(run(1, info, { kind: "error", text: "b" }))).toEqual({ text: "b", tone: "error" });
  expect(headlineOf(run(0, info, { kind: "success", text: "b" }))).toEqual({ text: "b", tone: "ok" });
  expect(headlineOf(run(0, info))).toEqual({ text: "a", tone: "info" });
  expect(headlineOf(run(2))).toEqual({ text: "saiu 2", tone: "error" });
});
