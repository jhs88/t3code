// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { type ProviderOptionSelection } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export interface PiAcpSettings {
  readonly binaryPath?: string;
  readonly piBinaryPath?: string;
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;
const THOUGHT_LEVEL_SELECTION_IDS = new Set([
  "effort",
  "reasoning",
  "reasoningeffort",
  "thoughtlevel",
  "thought_level",
]);

function pathDelimiterForEnvironment(environment?: NodeJS.ProcessEnv): string {
  const pathValue = environment?.PATH ?? environment?.Path ?? environment?.path;
  return pathValue?.includes(";") ? ";" : NodePath.delimiter;
}

function pathKeyForEnvironment(environment?: NodeJS.ProcessEnv): "PATH" | "Path" | "path" {
  if (environment && "Path" in environment) return "Path";
  if (environment && "path" in environment) return "path";
  return "PATH";
}

function dirnameForExecutablePath(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.replaceAll("\\", "/");
  const isWindowsAbsolute = WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalized);
  if (!normalized.startsWith("/") && !isWindowsAbsolute) return null;
  const separatorIndex = normalized.lastIndexOf("/");
  if (isWindowsAbsolute && separatorIndex === 2) return value.slice(0, 3);
  return separatorIndex > 0 ? value.slice(0, separatorIndex) : "/";
}

function prependUniquePathEntries(
  currentPath: string | undefined,
  entries: ReadonlyArray<string | null>,
  delimiter: string,
): string {
  const seen = new Set<string>();
  const result: Array<string> = [];
  for (const entry of [...entries, ...(currentPath ? currentPath.split(delimiter) : [])]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result.join(delimiter);
}

function buildPiAcpEnvironment(
  settings: PiAcpSettings | null | undefined,
  environment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  if (!settings?.piBinaryPath && !settings?.binaryPath && !environment) return undefined;

  const env = { ...environment };
  const pathKey = pathKeyForEnvironment(env);
  if (settings?.piBinaryPath) env.PI_ACP_PI_COMMAND = settings.piBinaryPath;
  const pathValue = prependUniquePathEntries(
    env[pathKey],
    [
      dirnameForExecutablePath(settings?.binaryPath),
      dirnameForExecutablePath(settings?.piBinaryPath),
    ],
    pathDelimiterForEnvironment(env),
  );
  if (pathValue) env[pathKey] = pathValue;
  return env;
}

export interface PiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "resumeFailureMode" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly piSettings: PiAcpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface PiAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export function buildPiAcpSpawnInput(
  settings: PiAcpSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const env = buildPiAcpEnvironment(settings, environment);
  return {
    command: settings?.binaryPath || "pi-acp",
    args: [],
    cwd,
    ...(env ? { env } : {}),
  };
}

export const makePiAcpRuntime = (
  input: PiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntimeShape,
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildPiAcpSpawnInput(input.piSettings, input.cwd, input.environment),
        authMethodId: "terminal_setup",
        resumeFailureMode: "fail",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

interface PiAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntimeShape["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

function normalizeSelectionId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/g, "");
}

function isThoughtLevelOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const category = normalizeSelectionId(option.category ?? "").replaceAll("_", "");
  const id = normalizeSelectionId(option.id).replaceAll("_", "");
  return category === "thoughtlevel" || id === "thoughtlevel";
}

function findThoughtLevelSelection(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  configOption: EffectAcpSchema.SessionConfigOption,
): ProviderOptionSelection | undefined {
  return selections?.find((selection) => {
    const selectionId = normalizeSelectionId(selection.id);
    return (
      selectionId === normalizeSelectionId(configOption.id) ||
      THOUGHT_LEVEL_SELECTION_IDS.has(selectionId)
    );
  });
}

export function applyPiAcpModelSelection<E>(input: {
  readonly runtime: PiAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: PiAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.model?.trim()) {
      yield* input.runtime
        .setModel(input.model.trim())
        .pipe(Effect.mapError((cause) => input.mapError({ cause, step: "set-model" })));
    }

    const thoughtLevelOption = (yield* input.runtime.getConfigOptions).find(isThoughtLevelOption);
    if (!thoughtLevelOption) return;
    const selection = findThoughtLevelSelection(input.selections, thoughtLevelOption);
    if (
      !selection ||
      (typeof selection.value !== "string" && typeof selection.value !== "boolean")
    ) {
      return;
    }
    yield* input.runtime.setConfigOption(thoughtLevelOption.id, selection.value).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          step: "set-config-option",
          configId: thoughtLevelOption.id,
        }),
      ),
    );
  });
}
