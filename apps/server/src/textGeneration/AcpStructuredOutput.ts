import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as EffectAcpErrors from "effect-acp/errors";

import type { AcpSessionRuntimeShape } from "../provider/acp/AcpSessionRuntime.ts";

export type AcpTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

function isTextGenerationError(error: unknown): error is TextGenerationError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "TextGenerationError"
  );
}

export function makeAcpStructuredOutputRunner(options: {
  readonly providerName: string;
  readonly timeoutMs: number;
  readonly makeRuntime: (
    cwd: string,
  ) => Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope>;
  readonly configure: (
    runtime: AcpSessionRuntimeShape,
    modelSelection: ModelSelection,
    operation: AcpTextGenerationOperation,
  ) => Effect.Effect<void, TextGenerationError>;
}) {
  const mapError = (
    operation: AcpTextGenerationOperation,
    detail: string,
    cause: unknown,
  ): TextGenerationError =>
    new TextGenerationError({
      operation,
      detail,
      ...(cause !== undefined ? { cause } : {}),
    });

  return <S extends Schema.Top>(input: {
    readonly operation: AcpTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* options.makeRuntime(input.cwd);

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") return Effect.void;
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const promptResult = yield* Effect.gen(function* () {
        yield* runtime.start();
        yield* options.configure(runtime, input.modelSelection, input.operation);
        return yield* runtime.prompt({ prompt: [{ type: "text", text: input.prompt }] });
      }).pipe(
        Effect.timeoutOption(options.timeoutMs),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: `${options.providerName} Agent request timed out.`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : mapError(input.operation, `${options.providerName} ACP request failed.`, cause),
        ),
      );

      const rawResult = (yield* Ref.get(outputRef)).trim();
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? `${options.providerName} ACP request was cancelled.`
              : `${options.providerName} Agent returned empty output.`,
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(rawResult)).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: `${options.providerName} Agent returned invalid structured output.`,
              cause,
            }),
          ),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : mapError(input.operation, `${options.providerName} ACP text generation failed.`, cause),
      ),
      Effect.scoped,
    );
}
