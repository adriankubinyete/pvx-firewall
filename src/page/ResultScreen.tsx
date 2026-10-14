/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// An action that failed: the whole output and the cause, until the technician closes it (UI.md §8). It never goes back by itself.
import type { CommandRun, SdkUi } from "@pvx/sdk";
import { toneOfLine } from "./outcome.ts";

export interface ResultScreenProps {
  run: CommandRun;
  onClose: () => void;
}

export const makeResultScreen = ({ h, Panel, Text, Button, useBack }: SdkUi) =>
  function ResultScreen({ run, onClose }: ResultScreenProps) {
    useBack(onClose);
    return (
      <Panel>
        <Panel title={`erro (saiu ${run.exit})`} tone="error">
          {run.lines.map((line, index) => <Text key={index} tone={toneOfLine(line)}>{line.text}</Text>)}
        </Panel>
        <Button label="fechar" primary keys="enter" onPress={onClose} />
      </Panel>
    );
  };
