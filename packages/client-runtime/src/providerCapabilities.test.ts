import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  RUNTIME_MODES,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isProviderInteractionModeSupported,
  normalizeProviderComposerModes,
  resolveProviderComposerCapabilities,
} from "./providerCapabilities.ts";

describe("provider composer capabilities", () => {
  it("treats omitted and empty capability fields as legacy support for every mode", () => {
    expect(resolveProviderComposerCapabilities(undefined)).toEqual({
      allowedRuntimeModes: RUNTIME_MODES,
      runtimeModeReason: undefined,
      showInteractionModeToggle: true,
    });
    expect(resolveProviderComposerCapabilities({ allowedRuntimeModes: [] })).toEqual({
      allowedRuntimeModes: RUNTIME_MODES,
      runtimeModeReason: undefined,
      showInteractionModeToggle: true,
    });
  });

  it("preserves explicit Pi restrictions", () => {
    const capabilities = resolveProviderComposerCapabilities({
      allowedRuntimeModes: ["full-access"],
      runtimeModeReason: "Pi executes tools under its own configuration.",
      showInteractionModeToggle: false,
    });
    expect(capabilities).toEqual({
      allowedRuntimeModes: ["full-access"],
      runtimeModeReason: "Pi executes tools under its own configuration.",
      showInteractionModeToggle: false,
    });
    expect(isProviderInteractionModeSupported(capabilities, "plan")).toBe(false);
    expect(isProviderInteractionModeSupported(capabilities, "default")).toBe(true);
  });

  it("keeps supported modes and normalizes unsupported modes to safe provider defaults", () => {
    const unrestricted = resolveProviderComposerCapabilities(undefined);
    expect(
      normalizeProviderComposerModes(unrestricted, {
        runtimeMode: "auto",
        interactionMode: "plan",
      }),
    ).toEqual({ runtimeMode: "auto", interactionMode: "plan" });

    const pi = resolveProviderComposerCapabilities({
      allowedRuntimeModes: ["full-access"],
      showInteractionModeToggle: false,
    });
    expect(
      normalizeProviderComposerModes(pi, {
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }),
    ).toEqual({
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    });
  });
});
