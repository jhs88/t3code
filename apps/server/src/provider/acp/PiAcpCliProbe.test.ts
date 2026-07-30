/**
 * Opt-in integration check against a real `pi-acp` and authenticated Pi install.
 *
 * Enable with:
 * T3_PI_ACP_PROBE=1 T3_PI_ACP_BINARY=/path/to/pi-acp \
 *   T3_PI_BINARY=/path/to/pi vp test run apps/server/src/provider/acp/PiAcpCliProbe.test.ts
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { buildPiModelsFromConfigOptions } from "../Layers/PiProvider.ts";
import { makePiAcpRuntime } from "./PiAcpSupport.ts";

describe.runIf(process.env.T3_PI_ACP_PROBE === "1")("Pi ACP CLI probe", () => {
  it.effect("returns the fixed live conversation marker", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makePiAcpRuntime({
        childProcessSpawner,
        piSettings: {
          binaryPath: process.env.T3_PI_ACP_BINARY ?? "pi-acp",
          piBinaryPath: process.env.T3_PI_BINARY ?? "pi",
        },
        environment: process.env,
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-pi-live-probe", version: "0.0.0" },
      });

      yield* runtime.start();
      const discoveredModels = buildPiModelsFromConfigOptions(yield* runtime.getConfigOptions);
      expect(discoveredModels.length).toBeGreaterThan(0);
      yield* runtime.setModel(discoveredModels[0]!.slug);

      yield* runtime.prompt({
        prompt: [{ type: "text", text: "Reply with exactly PI_E2E_OK and nothing else." }],
      });
      const events = Array.from(
        yield* Stream.runCollect(
          Stream.takeUntil(runtime.getEvents(), (event) => event._tag === "AssistantItemCompleted"),
        ),
      );
      const assistantText = events
        .flatMap((event) =>
          event._tag === "ContentDelta" && event.streamKind !== "reasoning_text"
            ? [event.text]
            : [],
        )
        .join("")
        .trim();

      expect(assistantText).toBe("PI_E2E_OK");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
