import {
  ProviderDriverKind,
  type AcpRegistrySettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeGenericAcpRuntime } from "../acp/PiAcpSupport.ts";
import { buildPiModelsFromConfigOptions } from "./PiProvider.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import { ACP_ADAPTER_CAPABILITIES } from "../Services/AcpAdapter.ts";

const DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Agent default",
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  },
];

const PRESENTATION = {
  displayName: "ACP Agent",
  badgeLabel: "Experimental",
  showInteractionModeToggle: false,
  allowedRuntimeModes: ACP_ADAPTER_CAPABILITIES.allowedRuntimeModes,
  runtimeModeReason: ACP_ADAPTER_CAPABILITIES.runtimeModeReason,
  supportsConversationRollback: false,
} as const;

function errorDetail(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === "string" ? error : String(error ?? "unknown error");
}

function isMissingBinary(error: unknown): boolean {
  const detail = errorDetail(error).toLowerCase();
  return detail.includes("enoent") || detail.includes("notfound") || detail.includes("not found");
}

export const checkAcpRegistryProviderStatus = Effect.fn("checkAcpRegistryProviderStatus")(
  function* (
    settings: AcpRegistrySettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled) {
      return buildServerProvider({
        driver: DRIVER_KIND,
        presentation: PRESENTATION,
        enabled: false,
        checkedAt,
        models: DEFAULT_MODELS,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "This ACP provider instance is disabled.",
        },
      });
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const probe = yield* Effect.exit(
      Effect.timeoutOption(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-probe-" });
          const runtime = yield* makeGenericAcpRuntime({
            piSettings: settings,
            environment,
            childProcessSpawner: spawner,
            cwd,
            clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
          });
          const started = yield* runtime.start();
          const discovered = buildPiModelsFromConfigOptions(yield* runtime.getConfigOptions);
          return {
            version: started.initializeResult.agentInfo?.version?.trim() || null,
            models: discovered.length > 0 ? discovered : DEFAULT_MODELS,
          };
        }).pipe(Effect.scoped),
        PROBE_TIMEOUT_MS,
      ),
    );

    if (Exit.isFailure(probe)) {
      const failure = Cause.squash(probe.cause);
      const missing = isMissingBinary(failure);
      return buildServerProvider({
        driver: DRIVER_KIND,
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: DEFAULT_MODELS,
        probe: {
          installed: !missing,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: missing
            ? `ACP command \`${settings.binaryPath}\` is not installed or not on PATH.`
            : `ACP probe failed: ${errorDetail(failure)}.`,
        },
      });
    }

    if (Option.isNone(probe.value)) {
      return buildServerProvider({
        driver: DRIVER_KIND,
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: DEFAULT_MODELS,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: `ACP probe timed out after ${PROBE_TIMEOUT_MS}ms.`,
        },
      });
    }

    return buildServerProvider({
      driver: DRIVER_KIND,
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: probe.value.value.models,
      probe: {
        installed: true,
        version: probe.value.value.version,
        status: "ready",
        auth: { status: "authenticated", type: "acp" },
      },
    });
  },
);
