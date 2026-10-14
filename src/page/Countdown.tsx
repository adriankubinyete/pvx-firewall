/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// After an apply: the revert is armed. Enter confirms the access; when the time runs out the old rules are already coming back.
import type { SdkUi } from "@pvx/sdk";

const TICK_MS = 500;

export interface CountdownProps {
  /** Epoch ms when the automatic revert fires. */
  deadline: number;
  onConfirm: () => void;
  onClose: () => void;
}

export const secondsLeft = (deadline: number, now: number): number => Math.max(0, Math.ceil((deadline - now) / 1000));

export const makeCountdown = ({ h, Panel, Text, Button, useState, useEffect }: SdkUi) =>
  function Countdown({ deadline, onConfirm, onClose }: CountdownProps) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), TICK_MS);
      return () => clearInterval(timer);
    }, []);
    const left = secondsLeft(deadline, now);
    if (left > 0) {
      return (
        <Panel>
          <Panel title="aplicado" tone="warn">
            <Text tone="warn" bold>ainda tem acesso?</Text>
            <Text>{`reversão automática em ${left}s`}</Text>
            <Button label="confirmar acesso" primary keys="enter" onPress={onConfirm} />
          </Panel>
        </Panel>
      );
    }
    return (
      <Panel>
        <Panel title="aplicado" tone="error">
          <Text tone="error" bold>tempo esgotado: as regras anteriores estão voltando</Text>
          <Button label="fechar" primary keys="enter" onPress={onClose} />
        </Panel>
      </Panel>
    );
  };
