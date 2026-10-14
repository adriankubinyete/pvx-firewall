/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// The review before an apply, read from the structured `firewall.diff` query. Nothing runs until the technician says so.
// Three views over one state: the summary (the confirmation), the raw rules (`d`) and the field that asks for the technician's IP.
import type { SdkUi } from "@pvx/sdk";
import type { DiffView, EngineProblem } from "../health/summary.ts";
import { isEngineProblem } from "../health/summary.ts";
import type { FwState } from "../state.ts";
import { makeReviewAskIp } from "./ReviewAskIp.tsx";
import { makeReviewDetails } from "./ReviewDetails.tsx";
import { makeReviewSummary, type ApplyChoice } from "./ReviewSummary.tsx";

export type { ApplyChoice };

export interface ApplyReviewProps {
  lists: FwState;
  onApply: (choice: ApplyChoice) => void;
  onCancel: () => void;
  /** The diff could not be read (no engine, a failed probe). */
  onFailure: (message: string) => void;
}

type View = "summary" | "details" | "askIp";

export const makeApplyReview = (ui: SdkUi) => {
  const { h, Loading, useQuery, useState, useEffect } = ui;
  const ReviewSummary = makeReviewSummary(ui);
  const ReviewDetails = makeReviewDetails(ui);
  const ReviewAskIp = makeReviewAskIp(ui);

  return function ApplyReview({ lists, onApply, onCancel, onFailure }: ApplyReviewProps) {
    const [view, setView] = useState<View>("summary");
    const [informedIp, setInformedIp] = useState<string | undefined>(undefined);
    // The informed IP is an argument of the query, so the diff counts the failsafe rule it adds.
    const query = useQuery<DiffView | EngineProblem>("firewall.diff", informedIp);
    const diff = query.data && !isEngineProblem(query.data) ? query.data : undefined;
    const problem = query.error ?? (query.data && isEngineProblem(query.data) ? query.data.error : undefined);
    useEffect(() => {
      if (problem) onFailure(problem);
    }, [problem]);

    const showSummary = () => setView("summary");
    const informIp = (ip: string) => {
      setInformedIp(ip);
      setView("summary");
    };

    if (view === "askIp") return <ReviewAskIp onSubmit={informIp} onCancel={showSummary} />;
    if (!diff) return <Loading label="comparando as regras vivas com as listas…" />;
    if (view === "details") return <ReviewDetails diff={diff} onClose={showSummary} />;
    return <ReviewSummary lists={lists} diff={diff} informedIp={informedIp} onApply={onApply} onInform={() => setView("askIp")} onDetails={() => setView("details")} onCancel={onCancel} />;
  };
};
