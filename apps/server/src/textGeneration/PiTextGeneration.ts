import { TextGenerationError, type PiSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { applyPiAcpModelSelection, makePiAcpRuntime } from "../provider/acp/PiAcpSupport.ts";
import {
  type AcpTextGenerationOperation,
  makeAcpStructuredOutputRunner,
} from "./AcpStructuredOutput.ts";
import { type ThreadTitleGenerationResult, type TextGenerationShape } from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PI_TIMEOUT_MS = 180_000;
function mapPiAcpError(
  operation: AcpTextGenerationOperation,
  detail: string,
  cause: unknown,
): TextGenerationError {
  return new TextGenerationError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runPiJson = makeAcpStructuredOutputRunner({
    providerName: "Pi",
    timeoutMs: PI_TIMEOUT_MS,
    makeRuntime: (cwd) =>
      makePiAcpRuntime({
        piSettings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
    configure: (runtime, modelSelection, operation) =>
      applyPiAcpModelSelection({
        runtime,
        model: modelSelection.model,
        selections: modelSelection.options,
        mapError: ({ cause, configId, step }) =>
          mapPiAcpError(
            operation,
            step === "set-config-option"
              ? `Failed to set Pi ACP config option "${configId}" for text generation.`
              : "Failed to set the Pi ACP model for text generation.",
            cause,
          ),
      }),
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "PiTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runPiJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "PiTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt(input);
    const generated = yield* runPiJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "PiTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt(input);
    const generated = yield* runPiJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return { branch: sanitizeBranchFragment(generated.branch) };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "PiTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt(input);
    const generated = yield* runPiJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return { title: sanitizeThreadTitle(generated.title) } satisfies ThreadTitleGenerationResult;
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
