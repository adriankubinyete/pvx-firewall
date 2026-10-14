/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// The Firewall tab. Only `sdk.ui`: no React import.
import type { Sdk } from "@pvx/sdk";
import { makeFirewall } from "./Firewall.tsx";

export function page(sdk: Sdk) {
  const { h } = sdk.ui;
  const Firewall = makeFirewall(sdk.ui);
  return () => <Firewall />;
}
