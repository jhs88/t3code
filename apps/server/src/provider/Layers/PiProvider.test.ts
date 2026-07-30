import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
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

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const hangingSpawnerLayer = (killCalls: Ref.Ref<number>, spawned: Deferred.Deferred<void>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const exitCode = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Deferred.await(exitCode),
          isRunning: Effect.succeed(true),
          kill: () =>
            Ref.update(killCalls, (count) => count + 1).pipe(
              Effect.andThen(
                Deferred.succeed(exitCode, ChildProcessSpawner.ExitCode(143)).pipe(Effect.asVoid),
              ),
            ),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.never,
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
        yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
        yield* Deferred.succeed(spawned, undefined);
        return handle;
      }),
    ),
  );

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

const makeMockAgentWrapper = Effect.fn("makeMockAgentWrapper")(function* (
  extraEnvironment: Readonly<Record<string, string>> = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-pi-provider-mock-",
  });
  const wrapperPath = path.join(directory, "pi-acp");
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const exports = Object.entries(extraEnvironment).map(
    ([key, value]) => `export ${key}=${shellQuote(value)}`,
  );
  yield* fileSystem.writeFileString(
    wrapperPath,
    ["#!/bin/sh", ...exports, `exec node ${shellQuote(mockAgentPath)}`, ""].join("\n"),
  );
  yield* fileSystem.chmod(wrapperPath, 0o755);
  return { directory, wrapperPath };
});

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

it.layer(NodeServices.layer)("checkPiProviderStatus", (it) => {
  it.effect("discovers authenticated Pi models through the ACP process boundary", () =>
    Effect.gen(function* () {
      const { wrapperPath } = yield* makeMockAgentWrapper();
      const snapshot = yield* checkPiProviderStatus({ ...settings, binaryPath: wrapperPath });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toEqual({ status: "authenticated", type: "pi" });
      expect(snapshot.version).toBe("0.0.0-test");
      expect(snapshot.models.map((model) => model.slug)).toContain("default");
    }).pipe(Effect.scoped),
  );

  it.effect("turns ACP authentication defects into an unauthenticated snapshot", () =>
    Effect.gen(function* () {
      const { wrapperPath } = yield* makeMockAgentWrapper({ T3_ACP_FAIL_AUTH: "1" });
      const snapshot = yield* checkPiProviderStatus({ ...settings, binaryPath: wrapperPath });

      expect(snapshot.status).toBe("error");
      expect(snapshot.auth).toEqual({ status: "unauthenticated" });
      expect(snapshot.message).toContain("configure a provider");
    }).pipe(Effect.scoped),
  );

  it.effect("marks a model-less ACP session unavailable without claiming authentication", () =>
    Effect.gen(function* () {
      const { wrapperPath } = yield* makeMockAgentWrapper({ T3_ACP_EMPTY_CONFIG_OPTIONS: "1" });
      const snapshot = yield* checkPiProviderStatus({ ...settings, binaryPath: wrapperPath });

      expect(snapshot.status).toBe("error");
      expect(snapshot.auth).toEqual({ status: "unknown" });
      expect(snapshot.models).toEqual([]);
      expect(snapshot.message).toContain("no usable models");
    }).pipe(Effect.scoped),
  );

  it.effect("closes the ACP probe process after discovery", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const exitDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-pi-provider-exit-",
      });
      const exitLogPath = path.join(exitDirectory, "exit.log");
      const { wrapperPath } = yield* makeMockAgentWrapper({
        T3_ACP_EXIT_LOG_PATH: exitLogPath,
      });

      yield* checkPiProviderStatus({ ...settings, binaryPath: wrapperPath });
      const exitLog = yield* fileSystem.readFileString(exitLogPath);
      expect(exitLog).toContain("SIGTERM");
    }).pipe(Effect.scoped),
  );

  it.effect("returns the timeout diagnostic and closes a hanging ACP process", () =>
    Effect.gen(function* () {
      const killCalls = yield* Ref.make(0);
      const spawned = yield* Deferred.make<void>();
      const timeout = yield* Deferred.make<void>();
      const statusFiber = yield* checkPiProviderStatus(settings, process.env, (probe) =>
        Effect.raceFirst(
          Effect.map(probe, Option.some),
          Deferred.await(timeout).pipe(Effect.as(Option.none())),
        ),
      ).pipe(Effect.provide(hangingSpawnerLayer(killCalls, spawned)), Effect.forkChild);

      yield* Deferred.await(spawned);
      yield* Deferred.succeed(timeout, undefined);
      const snapshot = yield* Fiber.join(statusFiber);
      expect(snapshot).toMatchObject({
        installed: true,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi ACP probe timed out after 15000ms.",
      });
      expect(yield* Ref.get(killCalls)).toBe(1);
    }).pipe(Effect.scoped),
  );

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

      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("not installed or not on PATH");
      expect(snapshot.skills).toEqual([
        {
          name: "review-changes",
          description: "Review the current changes for correctness.",
          path: expect.stringMatching(/review-changes[\\/]SKILL\.md$/),
          scope: "user",
          enabled: true,
        },
      ]);
    }).pipe(Effect.scoped),
  );
});
