/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// The review before an apply: what would change, read from the structured `firewall.diff` query. Nothing runs until the technician says so.
// The rules are a list the arrows walk through (a page does not scroll), each marked `+` (would load) or `-` (would drop).
import type { ListItem, SdkUi } from "@pvx/sdk";
import type { DiffView, EngineProblem } from "../health/summary.ts";
import { isEngineProblem } from "../health/summary.ts";
import { FIX } from "../texts.ts";
import { reviewMaxRows } from "./layout.ts";

export interface ApplyReviewProps {
  onApply: () => void;
  onCancel: () => void;
  /** The diff could not be read (no engine, a failed probe). */
  onFailure: (message: string) => void;
}

/** The rules that would leave (`-`, first) and enter (`+`). */
export const reviewItems = ({ removed, added }: DiffView): ListItem[] => [
  ...removed.map((rule) => ({ id: `-${rule}`, label: rule, mark: { text: "-", tone: "error" as const } })),
  ...added.map((rule) => ({ id: `+${rule}`, label: rule, mark: { text: "+", tone: "ok" as const } })),
];

function headlineOf(diff: DiffView): string {
  if (!diff.added.length && !diff.removed.length) return "as regras vivas batem com as listas";
  return `um apply adicionaria ${diff.added.length} e removeria ${diff.removed.length} regra(s)`;
}

function warningsOf(diff: DiffView): string[] {
  const warnings: string[] = [];
  if (diff.missingBaseIps.length) warnings.push(`faltam ${diff.missingBaseIps.length} IP(s) base da Phonevox (${FIX.trustPhonevox})`);
  if (!diff.session) warnings.push("IP da sessão desconhecido: o apply exigirá --force");
  return warnings;
}

export const makeApplyReview = ({ h, Panel, Row: SideBySide, Text, Button, Loading, List, useQuery, useState, useEffect, useKey, useBack, usePanels, useViewport }: SdkUi) =>
  function ApplyReview({ onApply, onCancel, onFailure }: ApplyReviewProps) {
    const query = useQuery<DiffView | EngineProblem>("firewall.diff");
    const panels = usePanels();
    const viewport = useViewport();
    const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
    const diff = query.data && !isEngineProblem(query.data) ? query.data : undefined;
    const items = diff ? reviewItems(diff) : [];
    const move = (delta: number) => {
      const index = Math.max(0, items.findIndex((item) => item.id === selectedId));
      setSelectedId(items[panels.wrap(index, delta, items.length)]?.id);
    };
    useKey("↑", "sobe", () => move(-1), { help: true });
    useKey("↓", "desce", () => move(1), { help: true });
    useBack(onCancel);
    const problem = query.error ?? (query.data && isEngineProblem(query.data) ? query.data.error : undefined);
    useEffect(() => {
      if (problem) onFailure(problem);
    }, [problem]);

    if (!diff) return <Loading label="comparando as regras vivas com as listas…" />;
    const warnings = warningsOf(diff);
    const current = items.find((item) => item.id === selectedId) ?? items[0];
    const position = current ? ` ${items.indexOf(current) + 1}/${items.length}` : "";
    return (
      <Panel>
        <Panel title={`o que muda${position}`} tone="accent" shrink>
          <Text tone="warn">{headlineOf(diff)}</Text>
          {warnings.map((warning) => <Text key={warning} tone="warn">{warning}</Text>)}
          {items.length ? <List items={items} selected={current?.id} maxRows={reviewMaxRows(viewport, warnings.length)} /> : null}
        </Panel>
        <SideBySide>
          <Button label="aplicar" primary keys="enter" onPress={onApply} />
          <Button label="cancelar" keys="n" onPress={onCancel} />
        </SideBySide>
      </Panel>
    );
  };
