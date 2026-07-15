import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect } from "vite-plus/test";

import { applyPiAcpModelSelection, buildPiAcpSpawnInput } from "./PiAcpSupport.ts";

describe("buildPiAcpSpawnInput", () => {
  it("builds the default Pi ACP command", () => {
    expect(buildPiAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "pi-acp",
      args: [],
      cwd: "/tmp/project",
    });
  });

  it("passes the Pi command and makes absolute binary directories discoverable", () => {
    const env = { HOME: "/tmp/pi-home", PATH: "/usr/bin" };
    expect(
      buildPiAcpSpawnInput(
        {
          binaryPath: "/Users/me/.local/bin/pi-acp",
          piBinaryPath: "/opt/homebrew/bin/pi",
        },
        "/tmp/project",
        env,
      ),
    ).toEqual({
      command: "/Users/me/.local/bin/pi-acp",
      args: [],
      cwd: "/tmp/project",
      env: {
        ...env,
        PATH: "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin",
        PI_ACP_PI_COMMAND: "/opt/homebrew/bin/pi",
      },
    });
  });

  it("preserves Windows Path casing and command directories", () => {
    const env = { Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs" };
    expect(
      buildPiAcpSpawnInput(
        {
          binaryPath: "C:\\Users\\me\\bin\\pi-acp.cmd",
          piBinaryPath: "C:\\Users\\me\\bin\\pi.cmd",
        },
        "C:\\work",
        env,
      ).env,
    ).toEqual({
      ...env,
      Path: "C:\\Users\\me\\bin;C:\\Windows\\System32;C:\\Program Files\\nodejs",
      PI_ACP_PI_COMMAND: "C:\\Users\\me\\bin\\pi.cmd",
    });
  });
});

describe("applyPiAcpModelSelection", () => {
  it.effect("sets the ACP model and advertised thought-level option", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly id: string;
        readonly value: string | boolean;
      }> = [];
      const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
        {
          id: "thought-level",
          name: "Thinking",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
      ];
      const runtime = {
        getConfigOptions: Effect.succeed(configOptions),
        setModel: (value: string) =>
          Effect.sync(() => {
            calls.push({ id: "model", value });
          }),
        setConfigOption: (id: string, value: string | boolean) =>
          Effect.sync(() => {
            calls.push({ id, value });
          }),
      };

      yield* applyPiAcpModelSelection({
        runtime,
        model: "anthropic/claude-sonnet-4",
        selections: [{ id: "reasoningEffort", value: "high" }],
        mapError: ({ cause }) => cause,
      });

      expect(calls).toEqual([
        { id: "model", value: "anthropic/claude-sonnet-4" },
        { id: "thought-level", value: "high" },
      ]);
    }),
  );
});
