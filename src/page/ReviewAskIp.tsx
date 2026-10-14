/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// `informar meu IP`: the technician types the address the failsafe keeps open when the host could not find the session's.
import type { FieldSpec, SdkUi } from "@pvx/sdk";
import { informedIpError } from "./review.ts";

const IP_FIELD: FieldSpec = { id: "ip", label: "meu IP", kind: "line" };

export interface ReviewAskIpProps {
  onSubmit: (ip: string) => void;
  onCancel: () => void;
}

export const makeReviewAskIp = ({ h, Panel, Fields }: SdkUi) =>
  function ReviewAskIp({ onSubmit, onCancel }: ReviewAskIpProps) {
    const validate = (values: Record<string, string | boolean>) => {
      const message = informedIpError(String(values.ip ?? ""));
      if (message) return { ip: message };
    };
    return (
      <Panel>
        <Panel title="informar meu IP" tone="accent">
          <Fields fields={[IP_FIELD]} onSubmit={(values) => onSubmit(String(values.ip).trim())} onCancel={onCancel} validate={validate} />
        </Panel>
      </Panel>
    );
  };
