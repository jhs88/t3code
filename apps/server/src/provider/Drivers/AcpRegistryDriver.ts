import {
  AcpRegistrySettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeAcpAdapter } from "../Layers/PiAdapter.ts";
import { checkAcpRegistryProviderStatus } from "../Layers/AcpRegistryProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { ACP_ADAPTER_CAPABILITIES } from "../Services/AcpAdapter.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type AcpRegistryDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

const unsupportedTextGeneration = TextGeneration.of({
  generateCommitMessage: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Generic ACP providers do not yet support utility text generation.",
      }),
    ),
  generatePrContent: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generatePrContent",
        detail: "Generic ACP providers do not yet support utility text generation.",
      }),
    ),
  generateBranchName: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateBranchName",
        detail: "Generic ACP providers do not yet support utility text generation.",
      }),
    ),
  generateThreadTitle: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Generic ACP providers do not yet support utility text generation.",
      }),
    ),
});

export const AcpRegistryDriver: ProviderDriver<AcpRegistrySettings, AcpRegistryDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "ACP Agent", supportsMultipleInstances: true },
  configSchema: AcpRegistrySettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies AcpRegistrySettings;
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const cachedSnapshot = yield* checkAcpRegistryProviderStatus(
        effectiveConfig,
        processEnv,
      ).pipe(Effect.map(stampIdentity));
      const adapter = yield* makeAcpAdapter(
        effectiveConfig,
        {
          provider: DRIVER_KIND,
          displayName: displayName ?? "ACP Agent",
          capabilities: ACP_ADAPTER_CAPABILITIES,
          makeAssistantTextFilter: () => ({ push: (text) => text, flush: () => "" }),
        },
        {
          environment: processEnv,
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
          instanceId,
        },
      );
      const snapshot = yield* makeManagedServerProvider<AcpRegistrySettings>({
        maintenanceCapabilities: MAINTENANCE,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: () => Effect.succeed(cachedSnapshot),
        checkProvider: Effect.succeed(cachedSnapshot),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build ACP provider snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: unsupportedTextGeneration,
      } satisfies ProviderInstance;
    }),
};
