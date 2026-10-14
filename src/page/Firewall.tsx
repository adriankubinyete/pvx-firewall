/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// The Firewall page: decides which screen is up (the tab, a form, the apply review, the countdown, a result) and runs the commands.
// Every change is one of the module's own commands (useCommand), so it lands in the scrollback, the history and the audit.
import type { CommandRun, SdkUi } from "@pvx/sdk";
import { STORE_KEY, load, type PendingRevert } from "../state.ts";
import { makeApplyReview, type ApplyChoice } from "./ApplyReview.tsx";
import { makeCountdown } from "./Countdown.tsx";
import { makeEntryForm, type FormTarget } from "./EntryForm.tsx";
import { INITIAL_FOCUS, INITIAL_SELECTION, makeMainScreen, type Focus, type Selection } from "./MainScreen.tsx";
import { makeResultScreen } from "./ResultScreen.tsx";
import { attempt, failedRun, headlineOf } from "./outcome.ts";
import { makeCommands } from "./commands.ts";
import { kindOfList } from "./rows.ts";

type Screen =
  | { name: "main" }
  | { name: "form"; target: FormTarget }
  | { name: "review" }
  | { name: "busy"; label: string }
  | { name: "countdown"; deadline: number }
  | { name: "result"; run: CommandRun };

const MAIN: Screen = { name: "main" };
const REVERT_FINISHED_TEXT = "reversão automática concluída";

export function makeFirewall(ui: SdkUi) {
  const { h, Loading, useState, useMemo, useStore, useNudge } = ui;
  const useFirewallCommands = makeCommands(ui);
  const MainScreen = makeMainScreen(ui);
  const EntryForm = makeEntryForm(ui);
  const ApplyReview = makeApplyReview(ui);
  const Countdown = makeCountdown(ui);
  const ResultScreen = makeResultScreen(ui);

  return function Firewall() {
    const store = useStore();
    const nudge = useNudge();
    const commands = useFirewallCommands();
    const [screen, setScreen] = useState<Screen>(MAIN);
    const [revision, setRevision] = useState(0);
    const [focus, setFocus] = useState<Focus>(INITIAL_FOCUS);
    const [selection, setSelection] = useState<Selection>(INITIAL_SELECTION);
    const lists = useMemo(() => load(store), [revision]);

    const backToMain = () => setScreen(MAIN);

    const announce = (run: CommandRun) => {
      const headline = headlineOf(run);
      if (headline.tone === "ok") nudge(headline.text, "ok");
      else nudge(headline.text);
    };

    /** A success goes back to the tab and says so in the footer (UI.md §13); a failure opens the result screen and stays there. */
    const settle = (run: CommandRun) => {
      setRevision(revision + 1);
      if (run.exit === 0) {
        announce(run);
        setScreen(MAIN);
      } else {
        setScreen({ name: "result", run });
      }
    };
    const perform = async (label: string, action: () => Promise<CommandRun>) => {
      setScreen({ name: "busy", label });
      settle(await attempt(action));
    };

    const applyLists = async (choice: ApplyChoice) => {
      setScreen({ name: "busy", label: "aplicando…" });
      const run = await attempt(() => commands.apply(choice));
      const pending = store.get<PendingRevert>(STORE_KEY.pending);
      if (run.exit === 0 && pending) {
        setRevision(revision + 1);
        setScreen({ name: "countdown", deadline: pending.deadline });
        return;
      }
      settle(run);
    };
    const closeCountdown = () => {
      setRevision(revision + 1);
      nudge(REVERT_FINISHED_TEXT);
      setScreen(MAIN);
    };

    switch (screen.name) {
      case "form":
        return (
          <EntryForm
            target={screen.target}
            onAdd={({ list, value, comment }) => void perform("adicionando…", () => commands.addEntry(list, value, comment))}
            onEditComment={(row, comment) => void perform("atualizando o comentário…", () => commands.addEntry(row.list, row.entry.value, comment))}
            onRemove={(row) => void perform("removendo…", () => commands.removeEntry(kindOfList(row.list), row.entry.value))}
            onCancel={backToMain}
          />
        );
      case "review":
        return <ApplyReview lists={lists} onApply={(choice) => void applyLists(choice)} onCancel={backToMain} onFailure={(message) => setScreen({ name: "result", run: failedRun(message) })} />;
      case "busy":
        return <Loading label={screen.label} />;
      case "countdown":
        return <Countdown deadline={screen.deadline} onConfirm={() => void perform("confirmando…", commands.confirm)} onClose={closeCountdown} />;
      case "result":
        return <ResultScreen run={screen.run} onClose={backToMain} />;
      case "main":
        return (
          <MainScreen
            lists={lists}
            focus={focus}
            onFocusChange={setFocus}
            selection={selection}
            onSelectionChange={setSelection}
            revision={revision}
            onAdd={(kind) => setScreen({ name: "form", target: { mode: "add", kind } })}
            onEdit={(row) => setScreen({ name: "form", target: { mode: "edit", row } })}
            onTrust={() => void perform("confiando nos IPs da Phonevox…", commands.trustPhonevox)}
            onReview={() => setScreen({ name: "review" })}
          />
        );
    }
  };
}
