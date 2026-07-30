import { resolveProviderComposerCapabilities } from "@t3tools/client-runtime/provider-capabilities";
import { describe, expect, it } from "vite-plus/test";

import { buildComposerProviderControls } from "./composerProviderControls.ts";

describe("buildComposerProviderControls", () => {
  it("offers every runtime mode and plan for legacy providers", () => {
    const controls = buildComposerProviderControls(resolveProviderComposerCapabilities(undefined), {
      runtimeMode: "auto",
      interactionMode: "plan",
    });

    expect(controls.runtimeAction.subactions?.map((action) => action.id)).toEqual([
      "options:runtime:approval-required",
      "options:runtime:auto-accept-edits",
      "options:runtime:auto",
      "options:runtime:full-access",
    ]);
    expect(controls.interactionAction?.subactions?.map((action) => action.id)).toEqual([
      "options:interaction:default",
      "options:interaction:plan",
    ]);
    expect(controls.slashCommands.map((command) => command.command)).toEqual([
      "model",
      "plan",
      "default",
    ]);
  });

  it("offers only explained full access and no plan entry points for Pi", () => {
    const reason = "Pi executes tools under its own configuration.";
    const controls = buildComposerProviderControls(
      resolveProviderComposerCapabilities({
        allowedRuntimeModes: ["full-access"],
        runtimeModeReason: reason,
        showInteractionModeToggle: false,
      }),
      { runtimeMode: "full-access", interactionMode: "default" },
    );

    expect(controls.runtimeAction.subactions).toEqual([
      {
        id: "options:runtime:full-access",
        title: "Full access",
        subtitle: reason,
        state: "on",
      },
    ]);
    expect(controls.runtimeAction.subtitle).toBe(reason);
    expect(controls.interactionAction).toBeNull();
    expect(controls.slashCommands.map((command) => command.command)).toEqual(["model", "default"]);
  });
});
