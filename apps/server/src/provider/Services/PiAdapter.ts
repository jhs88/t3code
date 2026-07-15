import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterCapabilities, ProviderAdapterShape } from "./ProviderAdapter.ts";

export const PI_RUNTIME_MODE_REASON =
  "Pi ACP does not provide per-tool approval enforcement, so only full access is available.";

export const PI_ADAPTER_CAPABILITIES = {
  sessionModelSwitch: "in-session",
  allowedRuntimeModes: ["full-access"],
  runtimeModeReason: PI_RUNTIME_MODE_REASON,
  supportsConversationRollback: false,
} as const satisfies ProviderAdapterCapabilities;

/** Per-instance Pi ACP adapter contract. */
export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
