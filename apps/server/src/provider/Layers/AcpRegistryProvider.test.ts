import * as NodeURL from "node:url";

import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { checkAcpRegistryProviderStatus } from "./AcpRegistryProvider.ts";

it.layer(NodeServices.layer)("generic ACP provider status", (it) => {
  it.effect("builds a disabled snapshot without spawning a process", () =>
    checkAcpRegistryProviderStatus({
      enabled: false,
      binaryPath: "hermes",
      launchArgs: "acp",
      authMethodId: "",
    }).pipe(
      Effect.map((snapshot) => {
        expect(snapshot.displayName).toBe("ACP Agent");
        expect(snapshot.status).toBe("disabled");
        expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
      }),
    ),
  );

  it.effect("probes an arbitrary ACP command using Hermes-shaped launch settings", () =>
    checkAcpRegistryProviderStatus({
      enabled: true,
      binaryPath: process.execPath,
      launchArgs: NodeURL.fileURLToPath(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      ),
      authMethodId: "",
    }).pipe(
      Effect.map((snapshot) => {
        expect(snapshot.status).toBe("ready");
        expect(snapshot.version).toBe("0.0.0-test");
      }),
    ),
  );
});
