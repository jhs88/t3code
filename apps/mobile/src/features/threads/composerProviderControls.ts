import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import {
  isProviderInteractionModeSupported,
  type ProviderComposerCapabilities,
} from "@t3tools/client-runtime/provider-capabilities";

export interface ComposerProviderMenuAction {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly state?: "on";
  readonly subactions?: Array<ComposerProviderMenuAction>;
}

export interface MobileBuiltInSlashCommand {
  readonly id: string;
  readonly command: "model" | "plan" | "default";
  readonly label: string;
  readonly description: string;
}

const RUNTIME_MODE_LABELS: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": "Approve actions",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

const BUILT_IN_SLASH_COMMANDS: ReadonlyArray<MobileBuiltInSlashCommand> = [
  { id: "cmd:model", command: "model", label: "/model", description: "Switch model" },
  { id: "cmd:plan", command: "plan", label: "/plan", description: "Switch to plan mode" },
  {
    id: "cmd:default",
    command: "default",
    label: "/default",
    description: "Switch to default mode",
  },
];

export function buildComposerProviderControls(
  capabilities: ProviderComposerCapabilities,
  current: {
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  },
): {
  readonly runtimeAction: ComposerProviderMenuAction;
  readonly interactionAction: ComposerProviderMenuAction | null;
  readonly slashCommands: ReadonlyArray<MobileBuiltInSlashCommand>;
} {
  const runtimeLabel = RUNTIME_MODE_LABELS[current.runtimeMode];
  const explainOnlyRuntime =
    capabilities.allowedRuntimeModes.length === 1 ? capabilities.runtimeModeReason : undefined;
  return {
    runtimeAction: {
      id: "options-runtime",
      title: "Runtime",
      subtitle: capabilities.runtimeModeReason ?? runtimeLabel,
      subactions: capabilities.allowedRuntimeModes.map((runtimeMode) => ({
        id: `options:runtime:${runtimeMode}`,
        title: RUNTIME_MODE_LABELS[runtimeMode],
        ...(explainOnlyRuntime ? { subtitle: explainOnlyRuntime } : {}),
        ...(current.runtimeMode === runtimeMode ? { state: "on" as const } : {}),
      })),
    },
    interactionAction: capabilities.showInteractionModeToggle
      ? {
          id: "options-interaction",
          title: "Interaction",
          subtitle: current.interactionMode === "plan" ? "Plan" : "Default",
          subactions: (["default", "plan"] as const).map((interactionMode) => ({
            id: `options:interaction:${interactionMode}`,
            title: interactionMode === "plan" ? "Plan" : "Default",
            ...(current.interactionMode === interactionMode ? { state: "on" as const } : {}),
          })),
        }
      : null,
    slashCommands: BUILT_IN_SLASH_COMMANDS.filter(
      (command) =>
        command.command === "model" ||
        isProviderInteractionModeSupported(capabilities, command.command),
    ),
  };
}
