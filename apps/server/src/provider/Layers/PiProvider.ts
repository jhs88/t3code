import { ProviderDriverKind } from "@t3tools/contracts";
import type { PiSettings, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { makePiAcpRuntime } from "../acp/PiAcpSupport.ts";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { PI_ADAPTER_CAPABILITIES } from "../Services/PiAdapter.ts";
import { discoverPiSkills, resolvePiSkillsDirectory } from "./PiSkills.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_ACP_PROBE_TIMEOUT_MS = 15_000;
const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  allowedRuntimeModes: PI_ADAPTER_CAPABILITIES.allowedRuntimeModes,
  runtimeModeReason: PI_ADAPTER_CAPABILITIES.runtimeModeReason,
  supportsConversationRollback: PI_ADAPTER_CAPABILITIES.supportsConversationRollback,
} as const;

interface PiSelectOption {
  readonly value: string;
  readonly name: string;
}

function flattenSelectOptions(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<PiSelectOption> {
  if (!option || option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), name: entry.name.trim() }]
      : entry.options.map((nested) => ({
          value: nested.value.trim(),
          name: nested.name.trim(),
        })),
  );
}

function compareText(left: string, right: string): number {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeConfigOptionKind(value: string | null | undefined): string | undefined {
  return value?.trim().toLowerCase().replaceAll("-", "_");
}

function hasConfigOptionKind(
  option: EffectAcpSchema.SessionConfigOption,
  kind: "model" | "thought_level",
): boolean {
  return (
    normalizeConfigOptionKind(option.category) === kind ||
    normalizeConfigOptionKind(option.id) === kind
  );
}

export function buildPiModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const options = configOptions ?? [];
  const modelOption = options.find((option) => hasConfigOptionKind(option, "model"));
  const thoughtOption = options.find(
    (option) => hasConfigOptionKind(option, "thought_level") && option.type === "select",
  );
  const thoughtChoices = flattenSelectOptions(thoughtOption).filter(
    (choice) => choice.value.length > 0,
  );
  const thoughtDescriptor =
    thoughtOption && thoughtOption.type === "select" && thoughtChoices.length > 0
      ? buildSelectOptionDescriptor({
          id: thoughtOption.id,
          label: thoughtOption.name.trim() || "Thinking",
          ...(thoughtOption.description?.trim()
            ? { description: thoughtOption.description.trim() }
            : {}),
          options: thoughtChoices.map((choice) => ({
            value: choice.value,
            label: choice.name || choice.value,
            isDefault: choice.value === thoughtOption.currentValue?.trim(),
          })),
        })
      : undefined;
  const capabilities = createModelCapabilities({
    optionDescriptors: thoughtDescriptor ? [thoughtDescriptor] : [],
  });
  const discovered = flattenSelectOptions(modelOption)
    .filter((choice) => choice.value.length > 0)
    .sort((left, right) => compareText(left.name || left.value, right.name || right.value));
  const seen = new Set<string>();

  return discovered.flatMap((choice) => {
    if (seen.has(choice.value)) return [];
    seen.add(choice.value);
    return [
      {
        slug: choice.value,
        name: choice.name || choice.value,
        isCustom: false,
        capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message} ${errorDetail(error.cause)}`.trim();
  }
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return String(error ?? "");
  const record = error as Record<string, unknown>;
  return [record._tag, record.message, record.command, record.cause]
    .map(errorDetail)
    .filter((value) => value.length > 0)
    .join(" ");
}

function isMissingBinary(error: unknown): boolean {
  const detail = errorDetail(error).toLowerCase();
  return detail.includes("enoent") || detail.includes("notfound") || detail.includes("not found");
}

function isAuthenticationFailure(error: unknown): boolean {
  const detail = errorDetail(error).toLowerCase();
  return (
    detail.includes("auth") ||
    detail.includes("login") ||
    detail.includes("no models available") ||
    detail.includes("configure a model")
  );
}

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      driver: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: [],
      probe: piSettings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Pi ACP availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Pi is disabled in T3 Code settings.",
          },
    }),
  );
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const skills = yield* discoverPiSkills(resolvePiSkillsDirectory(environment));
  if (!piSettings.enabled) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: [],
      skills,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const probe = yield* Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-provider-probe-" });
    const runtime = yield* makePiAcpRuntime({
      piSettings,
      environment,
      childProcessSpawner: spawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.start();
    return {
      version: started.initializeResult.agentInfo?.version?.trim() || null,
      models: buildPiModelsFromConfigOptions(yield* runtime.getConfigOptions),
    };
  }).pipe(Effect.scoped, Effect.timeoutOption(PI_ACP_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(probe)) {
    const missing = isMissingBinary(probe.failure);
    const unauthenticated = isAuthenticationFailure(probe.failure);
    return buildServerProvider({
      driver: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      skills,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: unauthenticated ? { status: "unauthenticated" } : { status: "unknown" },
        message: missing
          ? "Pi ACP adapter (`pi-acp`) is not installed or not on PATH. Install it or update the ACP adapter path."
          : unauthenticated
            ? "Pi is not configured with an authenticated model provider. Run `pi` in a terminal and configure a provider."
            : `Pi ACP probe failed: ${errorDetail(probe.failure) || "unknown error"}.`,
      },
    });
  }

  if (Option.isNone(probe.success)) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      skills,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi ACP probe timed out after ${PI_ACP_PROBE_TIMEOUT_MS}ms.`,
      },
    });
  }

  const discovered = probe.success.value;
  return buildServerProvider({
    driver: PROVIDER,
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models: discovered.models,
    skills,
    probe: {
      installed: true,
      version: discovered.version,
      status: discovered.models.length > 0 ? "ready" : "warning",
      auth: { status: "authenticated", type: "pi" },
      ...(discovered.models.length === 0
        ? { message: "Pi ACP probe returned no available models." }
        : {}),
    },
  });
});
