import type { ProviderAdapterCapabilities, ProviderAdapterShape } from "./ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";

export const ACP_ADAPTER_RUNTIME_MODE_REASON =
  "Generic ACP sessions do not yet negotiate T3 permission modes, so only full access is available.";

export const ACP_ADAPTER_CAPABILITIES = {
  sessionModelSwitch: "in-session",
  allowedRuntimeModes: ["full-access"],
  runtimeModeReason: ACP_ADAPTER_RUNTIME_MODE_REASON,
  supportsConversationRollback: false,
} as const satisfies ProviderAdapterCapabilities;

export interface AcpAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
