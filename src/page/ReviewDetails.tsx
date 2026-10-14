/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// The raw rules an apply would load (`+`) or drop (`-`). A page does not scroll, so the arrows walk a windowed list.
import type { SdkUi } from "@pvx/sdk";
import type { DiffView } from "../health/summary.ts";
import { reviewMaxRows } from "./layout.ts";
import { reviewItems } from "./review.ts";

export interface ReviewDetailsProps {
  diff: DiffView;
  /** `d` or esc: back to the summary. */
  onClose: () => void;
}

export const makeReviewDetails = ({ h, Panel, List, useState, useKey, useBack, usePanels, useViewport }: SdkUi) =>
  function ReviewDetails({ diff, onClose }: ReviewDetailsProps) {
    const panels = usePanels();
    const viewport = useViewport();
    const items = reviewItems(diff);
    const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
    const current = items.find((item) => item.id === selectedId) ?? items[0];
    const position = current ? ` ${items.indexOf(current) + 1}/${items.length}` : "";

    const move = (delta: number) => {
      const index = Math.max(0, items.findIndex((item) => item.id === current?.id));
      setSelectedId(items[panels.wrap(index, delta, items.length)]?.id);
    };
    useKey("↑", "sobe", () => move(-1), { help: true });
    useKey("↓", "desce", () => move(1), { help: true });
    useKey("d", "resumo", onClose);
    useBack(onClose);

    return (
      <Panel>
        <Panel title={`regras que mudam${position}`} tone="accent" shrink>
          <List items={items} selected={current?.id} maxRows={reviewMaxRows(viewport)} />
        </Panel>
      </Panel>
    );
  };
