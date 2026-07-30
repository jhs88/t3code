import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  RUNTIME_MODES,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";

export type ProviderComposerCapabilitySource = Pick<
  ServerProvider,
  "allowedRuntimeModes" | "runtimeModeReason" | "showInteractionModeToggle"
>;

export interface ProviderComposerCapabilities {
  readonly allowedRuntimeModes: ReadonlyArray<RuntimeMode>;
  readonly runtimeModeReason: string | undefined;
  readonly showInteractionModeToggle: boolean;
}

export function isProviderInteractionModeSupported(
  capabilities: Pick<ProviderComposerCapabilities, "showInteractionModeToggle">,
  interactionMode: ProviderInteractionMode,
): boolean {
  return interactionMode === DEFAULT_PROVIDER_INTERACTION_MODE
    ? true
    : capabilities.showInteractionModeToggle;
}

export function resolveProviderComposerCapabilities(
  provider: ProviderComposerCapabilitySource | null | undefined,
): ProviderComposerCapabilities {
  return {
    allowedRuntimeModes:
      provider?.allowedRuntimeModes && provider.allowedRuntimeModes.length > 0
        ? provider.allowedRuntimeModes
        : RUNTIME_MODES,
    runtimeModeReason: provider?.runtimeModeReason,
    showInteractionModeToggle: provider?.showInteractionModeToggle ?? true,
  };
}

export function normalizeProviderComposerModes(
  capabilities: ProviderComposerCapabilities,
  current: {
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  },
): {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
} {
  const runtimeMode = capabilities.allowedRuntimeModes.includes(current.runtimeMode)
    ? current.runtimeMode
    : capabilities.allowedRuntimeModes.includes(DEFAULT_RUNTIME_MODE)
      ? DEFAULT_RUNTIME_MODE
      : (capabilities.allowedRuntimeModes[0] ?? DEFAULT_RUNTIME_MODE);
  return {
    runtimeMode,
    interactionMode: isProviderInteractionModeSupported(capabilities, current.interactionMode)
      ? current.interactionMode
      : DEFAULT_PROVIDER_INTERACTION_MODE,
  };
}
