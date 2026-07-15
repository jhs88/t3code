/** Pi provider adapter backed by one scoped pi-acp process per thread. */
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeContentStreamKind,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyPiAcpModelSelection,
  makePiAcpRuntime,
  type PiAcpSettings,
} from "../acp/PiAcpSupport.ts";
import { PI_ADAPTER_CAPABILITIES, type PiAdapterShape } from "../Services/PiAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_RESUME_VERSION = 1 as const;
const PI_UPDATE_NOTICE_START = "New version available:";
const PI_UPDATE_NOTICE_PATTERN =
  /New version available: v[^\n]*\(installed v[^\n]*\)\. Run: npm i -g \S+\s*/g;
// eslint-disable-next-line no-control-regex
const ANSI_CONTROL_SEQUENCE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const INCOMPLETE_ANSI_CONTROL_SEQUENCE_PATTERN = /(?:\x1b|\x1b\[[0-?]*[ -/]*)$/;
const PI_SELECT_QUESTION_ID = "selection";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

export interface PiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly resolveSettings?: Effect.Effect<PiAcpSettings>;
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  turnInFlight: boolean;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function parsePiResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== PI_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlways = request.options.find((option) => option.kind === "allow_always");
  if (allowAlways?.optionId.trim()) return allowAlways.optionId.trim();
  const allowOnce = request.options.find((option) => option.kind === "allow_once");
  return allowOnce?.optionId.trim() || undefined;
}

function piExtensionSelectOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<{ readonly optionId: string; readonly label: string }> | undefined {
  const rawInput = isRecord(request.toolCall.rawInput) ? request.toolCall.rawInput : undefined;
  if (rawInput?.method !== "select" || !Array.isArray(rawInput.options)) return undefined;
  const labels = rawInput.options.map(String);
  if (labels.length === 0) return undefined;
  const options = labels.flatMap((label, index) => {
    const optionId = `choice-${index}`;
    return request.options.some((option) => option.optionId === optionId)
      ? [{ optionId, label }]
      : [];
  });
  return options.length > 0 ? options : undefined;
}

export function isPiExtensionConfirm(request: EffectAcpSchema.RequestPermissionRequest): boolean {
  const rawInput = isRecord(request.toolCall.rawInput) ? request.toolCall.rawInput : undefined;
  return rawInput?.method === "confirm";
}

export function optionForPiApprovalDecision(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  if (decision === "cancel") return undefined;
  const preferredKinds =
    decision === "acceptForSession"
      ? ["allow_always", "allow_once"]
      : decision === "accept"
        ? ["allow_once", "allow_always"]
        : ["reject_once", "reject_always"];
  return preferredKinds
    .map((kind) => request.options.find((option) => option.kind === kind)?.optionId.trim())
    .find((optionId) => optionId);
}

function selectedAnswerLabel(answers: ProviderUserInputAnswers): string | undefined {
  const answer = answers[PI_SELECT_QUESTION_ID];
  if (typeof answer === "string") return answer;
  if (Array.isArray(answer)) {
    return answer.find((entry): entry is string => typeof entry === "string");
  }
  return undefined;
}

export function sanitizePiAssistantTextDelta(text: string): string {
  return text.replace(ANSI_CONTROL_SEQUENCE_PATTERN, "").replace(PI_UPDATE_NOTICE_PATTERN, "");
}

export function makePiAssistantTextFilter(): {
  readonly push: (text: string) => string;
  readonly flush: () => string;
} {
  let pending = "";
  let pendingAnsiSequence = "";
  return {
    push: (text) => {
      const ansiInput = pendingAnsiSequence + text;
      const incompleteAnsiSequence = ansiInput.match(INCOMPLETE_ANSI_CONTROL_SEQUENCE_PATTERN);
      pendingAnsiSequence = incompleteAnsiSequence?.[0] ?? "";
      const completeInput = pendingAnsiSequence
        ? ansiInput.slice(0, -pendingAnsiSequence.length)
        : ansiInput;
      pending = sanitizePiAssistantTextDelta(pending + completeInput);
      const noticeIndex = pending.indexOf(PI_UPDATE_NOTICE_START);
      if (noticeIndex >= 0) {
        const output = pending.slice(0, noticeIndex);
        pending = pending.slice(noticeIndex);
        return output;
      }
      let heldSuffixLength = 0;
      const maxSuffixLength = Math.min(pending.length, PI_UPDATE_NOTICE_START.length - 1);
      for (let length = maxSuffixLength; length > 0; length -= 1) {
        if (PI_UPDATE_NOTICE_START.startsWith(pending.slice(-length))) {
          heldSuffixLength = length;
          break;
        }
      }
      const output = pending.slice(0, pending.length - heldSuffixLength);
      pending = pending.slice(pending.length - heldSuffixLength);
      return output;
    },
    flush: () => {
      const output = pending.startsWith(PI_UPDATE_NOTICE_START) ? "" : pending;
      pending = "";
      pendingAnsiSequence = "";
      return output;
    },
  };
}

function settlePendingUserInputs(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    pendingUserInputs.values(),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingApprovals(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    pendingApprovals.values(),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

export function makePiAdapter(piSettings: PiAcpSettings, options?: PiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, PiSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUID = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Pi runtime identifier.",
            cause,
          }),
      ),
    );
    const makeEventStamp = () =>
      Effect.all({
        eventId: Effect.map(randomUUID, EventId.make),
        createdAt: nowIso,
      });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });
    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context && !context.stopped
        ? Effect.succeed(context)
        : Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            }),
          );
    };

    const stopSessionInternal = (context: PiSessionContext) =>
      Effect.gen(function* () {
        if (context.stopped) return;
        context.stopped = true;
        yield* settlePendingApprovals(context.pendingApprovals);
        yield* settlePendingUserInputs(context.pendingUserInputs);
        if (context.notificationFiber) yield* Fiber.interrupt(context.notificationFiber);
        yield* Effect.ignore(Scope.close(context.scope, Exit.void));
        sessions.delete(context.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: PiAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (input.runtimeMode !== "full-access") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "Pi only supports runtimeMode 'full-access'; pi-acp cannot enforce standard tool approvals.",
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          const parsedResume = parsePiResume(input.resumeCursor);
          if (input.resumeCursor !== undefined && !parsedResume) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Pi resume cursor is invalid and cannot be loaded safely.",
            });
          }

          const cwd = input.cwd.trim();
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) yield* stopSessionInternal(existing);

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          let context!: PiSessionContext;
          const settings = options?.resolveSettings ? yield* options.resolveSettings : piSettings;
          const acp = yield* makePiAcpRuntime({
            piSettings: settings,
            childProcessSpawner,
            cwd,
            ...(parsedResume ? { resumeSessionId: parsedResume.sessionId } : {}),
            ...(options?.environment ? { environment: options.environment } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...makeAcpNativeLoggers({
              nativeEventLogger,
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                const usedLabels = new Set<string>();
                const selectOptions = piExtensionSelectOptions(params)?.map((option, index) => {
                  let displayLabel = option.label;
                  let suffix = index + 1;
                  while (usedLabels.has(displayLabel)) {
                    displayLabel = `${option.label} (${suffix})`;
                    suffix += 1;
                  }
                  usedLabels.add(displayLabel);
                  return { optionId: option.optionId, label: option.label, displayLabel };
                });
                if (selectOptions) {
                  const requestId = ApprovalRequestId.make(yield* randomUUID);
                  const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                  pendingUserInputs.set(requestId, { answers });
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: context?.activeTurnId,
                    requestId: RuntimeRequestId.make(requestId),
                    payload: {
                      questions: [
                        {
                          id: PI_SELECT_QUESTION_ID,
                          header: "Pi selection",
                          question: params.toolCall.title || "Choose an option",
                          multiSelect: false,
                          options: selectOptions.map(({ displayLabel }) => ({
                            label: displayLabel,
                            description: displayLabel,
                          })),
                        },
                      ],
                    },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      payload: params,
                    },
                  });
                  const resolved = yield* Deferred.await(answers);
                  pendingUserInputs.delete(requestId);
                  const selectedLabel = selectedAnswerLabel(resolved);
                  const selected = selectOptions.find(
                    (option) => option.displayLabel === selectedLabel,
                  );
                  yield* offerRuntimeEvent({
                    type: "user-input.resolved",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: context?.activeTurnId,
                    requestId: RuntimeRequestId.make(requestId),
                    payload: { answers: resolved },
                  });
                  return selected
                    ? {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: selected.optionId,
                        },
                      }
                    : { outcome: { outcome: "cancelled" as const } };
                }

                if (isPiExtensionConfirm(params)) {
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUID);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: context?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "Pi requested confirmation.",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: context?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const optionId = optionForPiApprovalDecision(params, resolved);
                  return optionId
                    ? { outcome: { outcome: "selected" as const, optionId } }
                    : { outcome: { outcome: "cancelled" as const } };
                }

                const optionId = selectAutoApprovedPermissionOption(params);
                return optionId
                  ? { outcome: { outcome: "selected" as const, optionId } }
                  : { outcome: { outcome: "cancelled" as const } };
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new EffectAcpErrors.AcpTransportError({
                      detail: "Failed to resolve Pi permission request.",
                      cause,
                    }),
                ),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          if (modelSelection) {
            yield* applyPiAcpModelSelection({
              runtime: acp,
              model: modelSelection.model,
              selections: modelSelection.options,
              mapError: ({ cause }) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
            });
          }

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: "full-access",
            cwd,
            ...(modelSelection ? { model: modelSelection.model } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: PI_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };
          context = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            turnInFlight: false,
            stopped: false,
          };

          const textFilter = makePiAssistantTextFilter();
          const emitContent = (
            text: string,
            itemId?: string,
            streamKind: RuntimeContentStreamKind = "assistant_text",
          ) =>
            text.length === 0
              ? Effect.void
              : makeEventStamp().pipe(
                  Effect.flatMap((stamp) =>
                    offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: context.threadId,
                        turnId: context.activeTurnId,
                        ...(itemId ? { itemId } : {}),
                        streamKind,
                        text,
                        rawPayload: { filtered: "pi-update-notice" },
                      }),
                    ),
                  ),
                );
          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: context.threadId,
                        turnId: context.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* emitContent(textFilter.flush(), event.itemId);
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: context.threadId,
                        turnId: context.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated": {
                    const fingerprint = `${context.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(event.payload) ?? "unknown"}`;
                    if (context.lastPlanFingerprint === fingerprint) return;
                    context.lastPlanFingerprint = fingerprint;
                    yield* offerRuntimeEvent(
                      makeAcpPlanUpdatedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: context.threadId,
                        turnId: context.activeTurnId,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ToolCallUpdated":
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: context.threadId,
                        turnId: context.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* emitContent(
                      event.streamKind === "reasoning_text"
                        ? event.text
                        : textFilter.push(event.text),
                      event.itemId,
                      event.streamKind ?? "assistant_text",
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.ensuring(
              Effect.all([
                settlePendingApprovals(pendingApprovals),
                settlePendingUserInputs(pendingUserInputs),
              ]),
            ),
            Effect.catch((cause) =>
              Effect.logError("Failed to process Pi runtime notification.", {
                cause,
              }),
            ),
            Effect.forkChild,
          );
          context.notificationFiber = notificationFiber;
          sessions.set(input.threadId, context);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {
              state: "ready",
              reason: "Pi ACP session ready (full access)",
            },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: PiAdapterShape["sendTurn"] = (input) => {
      let acquiredTurn = false;
      return Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (input.interactionMode === "plan") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi does not support plan interaction mode; thought_level is a model option.",
          });
        }
        if (context.turnInFlight) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi already has an active turn for this thread.",
          });
        }
        context.turnInFlight = true;
        acquiredTurn = true;
        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        if (modelSelection) {
          yield* applyPiAcpModelSelection({
            runtime: context.acp,
            model: modelSelection.model,
            selections: modelSelection.options,
            mapError: ({ cause }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
          });
        }

        const prompt: Array<EffectAcpSchema.ContentBlock> = [];
        if (input.input?.trim()) prompt.push({ type: "text", text: input.input.trim() });
        for (const attachment of input.attachments ?? []) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          prompt.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        if (prompt.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const turnId = TurnId.make(yield* randomUUID);
        context.activeTurnId = turnId;
        context.lastPlanFingerprint = undefined;
        context.session = {
          ...context.session,
          activeTurnId: turnId,
          ...(modelSelection ? { model: modelSelection.model } : {}),
          updatedAt: yield* nowIso,
        };
        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: context.session.model ?? "pi-default" },
        });

        const result = yield* context.acp.prompt({ prompt }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.catch((error) =>
            Effect.gen(function* () {
              context.activeTurnId = undefined;
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: error.message,
                },
              });
              return yield* error;
            }),
          ),
        );
        context.turns.push({ id: turnId, items: [{ prompt, result }] });
        context.session = {
          ...context.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason ?? null,
          },
        });
        context.activeTurnId = undefined;
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor,
        };
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!acquiredTurn) return;
            const context = sessions.get(input.threadId);
            if (context) context.turnInFlight = false;
          }),
        ),
      );
    };

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* settlePendingApprovals(context.pendingApprovals);
        yield* settlePendingUserInputs(context.pendingUserInputs);
        yield* Effect.ignore(
          context.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });
    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending Pi selection request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });
    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      requireSession(threadId).pipe(Effect.map((context) => ({ threadId, turns: context.turns })));
    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId) =>
      requireSession(threadId).pipe(
        Effect.andThen(
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "rollbackThread",
              detail:
                "Pi ACP does not support conversation rollback; local history was not modified.",
            }),
          ),
        ),
      );
    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(threadId, requireSession(threadId).pipe(Effect.flatMap(stopSessionInternal)));
    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));
    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });
    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.catch((cause) => Effect.logError("Failed to stop Pi ACP sessions.", { cause })),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: PI_ADAPTER_CAPABILITIES,
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      readThread,
      rollbackThread,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies PiAdapterShape;
  });
}
