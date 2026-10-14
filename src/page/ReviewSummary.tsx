/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// The apply confirmation: whether the session stays open, what the lists ask for in words, and the buttons.
// Enter applies only when that is safe (a failsafe IP is known or was given); otherwise it walks to the warning's buttons.
import type { SdkUi } from "@pvx/sdk";
import type { DiffView } from "../health/summary.ts";
import { ROLLBACK_SECONDS } from "../rollback.ts";
import type { FwState } from "../state.ts";
import { FIX } from "../texts.ts";
import { hasFailsafe, afterApplyText, rowText, rulesButtonLabel, summaryRows, valuesWidth, type SummaryRow } from "./review.ts";

/** What the technician chose for an apply. Nothing set: a plain apply (the failsafe is the session's). */
export interface ApplyChoice {
  failsafeIp?: string;
  force?: boolean;
}

type WarningButton = "inform" | "force";
const WARNING_BUTTONS: WarningButton[] = ["inform", "force"];

/** Rows of height a blank line is worth having; below it the summary stays tight. */
const SPACIOUS_ROWS = 28;

export interface ReviewSummaryProps {
  lists: FwState;
  diff: DiffView;
  /** The IP the technician typed, when there is one: the diff already counts it as the failsafe. */
  informedIp?: string;
  onApply: (choice: ApplyChoice) => void;
  onInform: () => void;
  onDetails: () => void;
  onCancel: () => void;
}

const sessionText = (diff: DiffView, informed: boolean): string => {
  if (informed) return `IP ${diff.session} informado fica liberado (failsafe)`;
  return `sessão ${diff.session} fica liberada (failsafe)`;
};

const NO_SESSION_TEXT = "Não achei o IP da sua sessão SSH\nsem ele não há failsafe: um erro pode derrubar o acesso";

export const makeReviewSummary = ({ h, Panel, Row: SideBySide, Text, Notice, Button, Spacer, useState, useKey, useBack, useViewport }: SdkUi) => {
  /** While a warning button has the focus: arrows choose, enter presses. */
  function WarningKeys({ onMove, onPress }: { onMove: (delta: number) => void; onPress: () => void }) {
    useKey("←", "botão", () => onMove(-1));
    useKey("→", "botão", () => onMove(1));
    useKey("enter", "escolhe", onPress);
    return null;
  }

  /** Without a failsafe IP, enter walks to the warning's buttons instead of applying. */
  function FocusWarningKey({ onFocus }: { onFocus: () => void }) {
    useKey("enter", "ver o aviso", onFocus);
    return null;
  }

  const summaryLine = (row: SummaryRow) => (
    <Text key={row.id} tone={row.id === "removed" ? "warn" : undefined}>{rowText(row)}</Text>
  );

  return function ReviewSummary({ lists, diff, informedIp, onApply, onInform, onDetails, onCancel }: ReviewSummaryProps) {
    const viewport = useViewport();
    const safe = hasFailsafe(diff);
    const [warningFocus, setWarningFocus] = useState<WarningButton | undefined>(undefined);

    const applyForced = () => onApply({ force: true });
    const pressWarning: Record<WarningButton, () => void> = { inform: onInform, force: applyForced };
    const focusWarning = () => setWarningFocus("inform");
    const moveWarningFocus = (delta: number) => {
      const index = WARNING_BUTTONS.indexOf(warningFocus ?? "inform");
      setWarningFocus(WARNING_BUTTONS[(index + delta + WARNING_BUTTONS.length) % WARNING_BUTTONS.length]);
    };
    const applyOrWarn = () => (safe ? onApply({ failsafeIp: informedIp }) : focusWarning());
    useBack(warningFocus ? () => setWarningFocus(undefined) : onCancel);

    const rows = summaryRows(lists, diff, valuesWidth(viewport.cols));
    const nothingChanges = !diff.added.length && !diff.removed.length;
    return (
      <Panel>
        <Panel title="aplicar firewall" tone="accent" shrink>
          {safe ? <Notice level="ok">{sessionText(diff, informedIp !== undefined)}</Notice> : <Notice level="warn">{NO_SESSION_TEXT}</Notice>}
          {safe ? null : (
            <SideBySide>
              <Button label="informar meu IP" focused={warningFocus === "inform"} onPress={onInform} />
              <Button label="aplicar sem failsafe" focused={warningFocus === "force"} onPress={applyForced} />
            </SideBySide>
          )}
          {viewport.rows >= SPACIOUS_ROWS ? <Spacer /> : null}
          {diff.missingBaseIps.length ? <Text tone="warn">{`faltam ${diff.missingBaseIps.length} IP(s) base da Phonevox (${FIX.trustPhonevox})`}</Text> : null}
          {rows.map(summaryLine)}
          {nothingChanges ? <Text tone="dim">as regras vivas já batem com as listas</Text> : null}
          {viewport.rows >= SPACIOUS_ROWS ? <Spacer /> : null}
          <Text tone="dim">{afterApplyText(ROLLBACK_SECONDS)}</Text>
          <SideBySide>
            <Button label="aplicar" primary keys={safe ? "enter" : undefined} onPress={applyOrWarn} />
            <Button label="cancelar" keys="n" onPress={onCancel} />
            <Button label={rulesButtonLabel(diff)} keys="d" onPress={onDetails} />
          </SideBySide>
        </Panel>
        {safe ? null : warningFocus ? <WarningKeys onMove={moveWarningFocus} onPress={pressWarning[warningFocus]} /> : <FocusWarningKey onFocus={focusWarning} />}
      </Panel>
    );
  };
};
