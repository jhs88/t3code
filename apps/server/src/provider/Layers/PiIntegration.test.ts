import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ApprovalRequestId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { PiDriver } from "../Drivers/PiDriver.ts";
import { makePiAdapter } from "./PiAdapter.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";

// An isolated JSON-RPC peer, not Pi or a model. Requests are logged before replies,
// so assertions wait on protocol completion rather than sleeps or filesystem polling.
const peer = String.raw`
import * as fs from "node:fs";
import * as readline from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({jsonrpc:"2.0", ...message}) + "\n");
const reply = (id, result) => send({id, result});
const fail = (id) => send({id, error:{code:-32002,message:"fixture failure"}});
const update = (sessionUpdate, text) => send({method:"session/update",params:{sessionId:"pi-fixture",update:{sessionUpdate,content:{type:"text",text}}}});
const configOptions = [
 {id:"model",name:"Model",category:"model",type:"select",currentValue:"test/old",options:[{value:"test/model",name:"Fixture model"},{value:"test/old",name:"Old model"}]},
 {id:"thought_level",name:"Thinking",category:"thought_level",type:"select",currentValue:"low",options:[{value:"low",name:"Low"},{value:"high",name:"High"}]}
];
let promptId;
readline.createInterface({input:process.stdin}).on("line", line => {
 const m = JSON.parse(line);
 fs.appendFileSync(process.env.PI_FIXTURE_LOG, JSON.stringify(m) + "\n");
 if (!m.method) { reply(promptId, {stopReason:"end_turn"}); return; }
 switch (m.method) {
 case "initialize":
  if (process.env.PI_FIXTURE_FAIL === "initialize") { fail(m.id); return; }
  reply(m.id,{protocolVersion:1,agentCapabilities:{loadSession:true},agentInfo:{name:"pi-fixture",version:"1.0.0"},authMethods:[]}); return;
 case "session/new": reply(m.id,{sessionId:"pi-fixture",configOptions}); return;
 case "session/load":
  if (process.env.PI_FIXTURE_FAIL === "load") fail(m.id);
  else reply(m.id,{configOptions});
  return;
 case "session/set_config_option": reply(m.id,{configOptions}); return;
 case "session/set_model": reply(m.id,{}); return;
 case "session/cancel": reply(promptId,{stopReason:"cancelled"}); return;
 case "session/prompt": {
  promptId = m.id;
  const text = m.params.prompt[0]?.text;
  if (text === "exit") { process.exit(7); }
  if (text === "confirm" || text === "select") {
   send({id:"extension",method:"session/request_permission",params:{sessionId:"pi-fixture",toolCall:{toolCallId:"extension",title:"Choose",status:"pending",rawInput:{method:text,options:["One","Two"]}},options:[{optionId:"choice-0",name:"One",kind:"allow_once"},{optionId:"choice-1",name:"Two",kind:"reject_once"}]}});
   return;
  }
  update("agent_thought_chunk", "fixture reasoning");
  if (text === "wait") return;
  update("agent_message_chunk", process.env.PI_FIXTURE_OUTPUT ?? "fixture answer");
  reply(m.id,{stopReason:"end_turn"}); return;
 }
 default: reply(m.id,{});
 }
});
`;

const makeFixture = Effect.fn("makePiFixture")(function* (extra: Record<string, string> = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-integration-" });
  const log = path.join(cwd, "requests.jsonl");
  yield* fs.writeFileString(log, "");
  const binaryPath = yield* Effect.sync(() =>
    writeFakeCli({ directory: cwd, name: "pi-fixture", source: peer }),
  );
  const environment = {
    PATH: (yield* HostProcessEnvironment).PATH,
    PI_CODING_AGENT_DIR: cwd,
    PI_FIXTURE_LOG: log,
    ...extra,
  };
  const settings = { enabled: true, binaryPath, piBinaryPath: "never-run-real-pi" };
  const readLog = fs.readFileString(log).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: { configId?: string; value?: string };
              result?: unknown;
            },
        ),
    ),
  );
  return { cwd, settings, environment, readLog };
});

const layer = ServerConfig.layerTest(".", { prefix: "t3-pi-integration-config-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);
const threadId = ThreadId.make("pi-integration");
const instanceId = ProviderInstanceId.make("pi");

it.layer(layer)("Pi ACP integration", (it) => {
  it.effect(
    "streams thoughts separately, selects model options, resumes and refuses unsafe modes and rollback",
    () =>
      Effect.gen(function* () {
        const h = yield* makeFixture();
        const adapter = yield* makePiAdapter(h.settings, { environment: h.environment });
        const start = {
          threadId,
          cwd: h.cwd,
          runtimeMode: "full-access" as const,
          modelSelection: {
            instanceId,
            model: "test/model",
            options: [{ id: "thought_level", value: "high" }],
          },
        };
        expect(
          (yield* adapter
            .startSession({ ...start, runtimeMode: "approval-required" })
            .pipe(Effect.flip))._tag,
        ).toBe("ProviderAdapterValidationError");
        const session = yield* adapter.startSession(start);
        const events = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({ threadId, input: "hello" });
        const collected = yield* Fiber.join(events);
        expect(
          collected.filter((event) => event.type === "content.delta").map((event) => event.payload),
        ).toEqual([
          expect.objectContaining({ streamKind: "reasoning_text", delta: "fixture reasoning" }),
          expect.objectContaining({ streamKind: "assistant_text", delta: "fixture answer" }),
        ]);
        expect(
          (yield* adapter
            .sendTurn({ threadId, input: "plan", interactionMode: "plan" })
            .pipe(Effect.flip))._tag,
        ).toBe("ProviderAdapterValidationError");
        expect((yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip))._tag).toBe(
          "ProviderAdapterRequestError",
        );
        expect((yield* adapter.readThread(threadId)).turns).toHaveLength(1);
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({ ...start, resumeCursor: session.resumeCursor });
        expect((yield* h.readLog).map((entry) => entry.method)).toContain("session/load");
        expect(yield* h.readLog).toContainEqual(
          expect.objectContaining({
            method: "session/set_config_option",
            params: expect.objectContaining({ configId: "thought_level", value: "high" }),
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("does not replace a failed resume with an empty session", () =>
    Effect.gen(function* () {
      const h = yield* makeFixture({ PI_FIXTURE_FAIL: "load" });
      const adapter = yield* makePiAdapter(h.settings, { environment: h.environment });
      yield* adapter
        .startSession({
          threadId,
          cwd: h.cwd,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "pi-fixture" },
        })
        .pipe(Effect.flip);
      expect(yield* adapter.listSessions()).toEqual([]);
      expect((yield* h.readLog).map((entry) => entry.method)).not.toContain("session/new");
    }).pipe(Effect.scoped),
  );

  for (const interaction of ["confirm", "select"] as const) {
    it.effect(`returns the advertised Pi ${interaction} choice`, () =>
      Effect.gen(function* () {
        const h = yield* makeFixture();
        const adapter = yield* makePiAdapter(h.settings, { environment: h.environment });
        yield* adapter.startSession({ threadId, cwd: h.cwd, runtimeMode: "full-access" });
        const responder = yield* adapter.streamEvents.pipe(
          Stream.tap((event) => {
            if (event.type === "request.opened")
              return adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(event.requestId!),
                "accept",
              );
            if (event.type === "user-input.requested") {
              expect(event.payload.questions[0]?.options?.map((option) => option.label)).toEqual([
                "One",
                "Two",
              ]);
              return adapter.respondToUserInput(
                threadId,
                ApprovalRequestId.make(event.requestId!),
                { selection: "Two" },
              );
            }
            return Effect.void;
          }),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({ threadId, input: interaction });
        yield* Fiber.join(responder);
        expect(yield* h.readLog).toContainEqual(
          expect.objectContaining({
            result: {
              outcome: {
                outcome: "selected",
                optionId: interaction === "confirm" ? "choice-0" : "choice-1",
              },
            },
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  it.effect("interrupts a prompt after its thought event and cleans up the session", () =>
    Effect.gen(function* () {
      const h = yield* makeFixture();
      const adapter = yield* makePiAdapter(h.settings, { environment: h.environment });
      yield* adapter.startSession({ threadId, cwd: h.cwd, runtimeMode: "full-access" });
      const ready = yield* Deferred.make<void>();
      const events = yield* adapter.streamEvents.pipe(
        Stream.tap((event) =>
          event.type === "content.delta" ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const turn = yield* adapter.sendTurn({ threadId, input: "wait" }).pipe(Effect.forkChild);
      yield* Deferred.await(ready);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(turn);
      expect(yield* Fiber.join(events)).toContainEqual(
        expect.objectContaining({
          type: "turn.completed",
          payload: expect.objectContaining({ state: "cancelled" }),
        }),
      );
      yield* adapter.stopSession(threadId);
      expect(yield* adapter.listSessions()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a peer process exit as a failed turn", () =>
    Effect.gen(function* () {
      const h = yield* makeFixture();
      const adapter = yield* makePiAdapter(h.settings, { environment: h.environment });
      yield* adapter.startSession({ threadId, cwd: h.cwd, runtimeMode: "full-access" });
      const error = yield* adapter.sendTurn({ threadId, input: "exit" }).pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterProcessError");
    }).pipe(Effect.scoped),
  );

  for (const fail of [false, true]) {
    it.effect(`caches the eager discovery ${fail ? "failure" : "success"} across refreshes`, () =>
      Effect.gen(function* () {
        const h = yield* makeFixture(fail ? { PI_FIXTURE_FAIL: "initialize" } : {});
        const instance = yield* PiDriver.create({
          instanceId,
          displayName: undefined,
          accentColor: undefined,
          environment: Object.entries(h.environment).flatMap(([name, value]) =>
            value === undefined ? [] : [{ name, value, sensitive: false }],
          ),
          enabled: true,
          config: h.settings,
        });
        const snapshot = yield* instance.snapshot.refresh;
        expect(snapshot.status).toBe(fail ? "error" : "ready");
        if (!fail)
          expect(snapshot.models[0]?.capabilities?.optionDescriptors?.[0]?.id).toBe(
            "thought_level",
          );
        yield* instance.snapshot.refresh;
        yield* instance.snapshot.refresh;
        expect((yield* h.readLog).filter((entry) => entry.method === "initialize")).toHaveLength(1);
      }).pipe(Effect.scoped),
    );
  }

  it.effect("generates structured utility text with an isolated ACP session", () =>
    Effect.gen(function* () {
      const h = yield* makeFixture({ PI_FIXTURE_OUTPUT: '{"title":"Fixture title"}' });
      const generation = yield* makePiTextGeneration(h.settings, h.environment);
      expect(
        yield* generation.generateThreadTitle({
          cwd: h.cwd,
          message: "fixture task",
          modelSelection: { instanceId, model: "test/model" },
        }),
      ).toEqual({ title: "Fixture title" });
      expect((yield* h.readLog).filter((entry) => entry.method === "session/new")).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
