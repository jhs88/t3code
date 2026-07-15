import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect } from "vite-plus/test";

import type { PiSettings } from "@t3tools/contracts";
import {
  buildInitialPiProviderSnapshot,
  buildPiModelsFromConfigOptions,
  checkPiProviderStatus,
} from "./PiProvider.ts";

const settings: PiSettings = {
  enabled: true,
  binaryPath: "pi-acp",
  piBinaryPath: "pi",
};

const configOptions = [
  {
    type: "select",
    currentValue: "openai/gpt-5.4",
    options: [
      { name: "Claude Sonnet", value: "anthropic/claude-sonnet" },
      { name: "GPT 5.4", value: "openai/gpt-5.4" },
      { name: "Duplicate GPT", value: "openai/gpt-5.4" },
    ],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "medium",
    options: [
      { name: "Off", value: "off" },
      { name: "Medium", value: "medium" },
      { name: "Extra High", value: "xhigh" },
    ],
    category: "thought_level",
    id: "thought_level",
    name: "Thinking",
    description: "Controls reasoning depth.",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

describe("buildPiModelsFromConfigOptions", () => {
  it("deterministically maps ACP model and thought-level choices", () => {
    expect(buildPiModelsFromConfigOptions(configOptions)).toEqual([
      {
        slug: "anthropic/claude-sonnet",
        name: "Claude Sonnet",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "thought_level",
              label: "Thinking",
              description: "Controls reasoning depth.",
              type: "select",
              currentValue: "medium",
              options: [
                { id: "off", label: "Off" },
                { id: "medium", label: "Medium", isDefault: true },
                { id: "xhigh", label: "Extra High" },
              ],
            },
          ],
        },
      },
      {
        slug: "openai/gpt-5.4",
        name: "Duplicate GPT",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "thought_level",
              label: "Thinking",
              description: "Controls reasoning depth.",
              type: "select",
              currentValue: "medium",
              options: [
                { id: "off", label: "Off" },
                { id: "medium", label: "Medium", isDefault: true },
                { id: "xhigh", label: "Extra High" },
              ],
            },
          ],
        },
      },
    ]);
  });

  it("does not infer fallback models without ACP choices", () => {
    expect(buildPiModelsFromConfigOptions([])).toEqual([]);
  });

  it("recognizes model and thought-level option ids when categories are absent", () => {
    const options = configOptions.map(({ category: _, ...option }) => option);
    expect(buildPiModelsFromConfigOptions(options)).toHaveLength(2);
    expect(
      buildPiModelsFromConfigOptions(options)[0]?.capabilities?.optionDescriptors,
    ).toHaveLength(1);
  });
});

describe("buildInitialPiProviderSnapshot", () => {
  it.effect("advertises Pi as early access without an interaction-mode toggle", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(settings);
      expect(snapshot).toMatchObject({
        displayName: "Pi",
        badgeLabel: "Early Access",
        showInteractionModeToggle: false,
        allowedRuntimeModes: ["full-access"],
        runtimeModeReason:
          "Pi ACP does not provide per-tool approval enforcement, so only full access is available.",
        supportsConversationRollback: false,
        enabled: true,
        models: [],
      });
    }),
  );
});

describe("checkPiProviderStatus", () => {
  it.effect("publishes global Pi skills even when the ACP probe fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-pi-skills-test-",
      });
      const skillDirectory = path.join(agentDirectory, "skills", "review-changes");
      yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(skillDirectory, "SKILL.md"),
        [
          "---",
          "name: review-changes",
          "description: Review the current changes for correctness.",
          "---",
          "",
          "Review the current worktree.",
        ].join("\n"),
      );

      const snapshot = yield* checkPiProviderStatus(
        { ...settings, binaryPath: "t3-guaranteed-missing-pi-acp" },
        { PI_CODING_AGENT_DIR: agentDirectory, PATH: "" },
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.skills).toEqual([
        {
          name: "review-changes",
          description: "Review the current changes for correctness.",
          path: expect.stringMatching(/review-changes[\\/]SKILL\.md$/),
          scope: "user",
          enabled: true,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
