import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  isPiExtensionConfirm,
  makePiAssistantTextFilter,
  optionForPiApprovalDecision,
  sanitizePiAssistantTextDelta,
} from "./PiAdapter.ts";

const UPDATE_NOTICE =
  "New version available: v0.75.3 (installed v0.73.1). Run: npm i -g @mariozechner/pi-coding-agent ";

describe("Pi assistant text filtering", () => {
  it("removes a complete update notice while preserving assistant text", () => {
    expect(sanitizePiAssistantTextDelta(`${UPDATE_NOTICE}PI_OK`)).toBe("PI_OK");
  });

  it("removes update notices split across ACP deltas", () => {
    const filter = makePiAssistantTextFilter();
    expect(filter.push("New version avail")).toBe("");
    expect(filter.push("able: v0.75.3 (installed v0.73.1). Run: npm i -g ")).toBe("");
    expect(filter.push("@mariozechner/pi-coding-agent PI_OK")).toBe("PI_OK");
    expect(filter.flush()).toBe("");
  });

  it("does not delay ordinary assistant text", () => {
    const filter = makePiAssistantTextFilter();
    expect(filter.push("PI_OK")).toBe("PI_OK");
    expect(filter.flush()).toBe("");
  });

  it("removes ANSI styling emitted by Pi extensions across ACP deltas", () => {
    const filter = makePiAssistantTextFilter();
    expect(filter.push("Hi! What can I help you with?\u001b[38;2;80;250;123m✓\u001b[39m ")).toBe(
      "Hi! What can I help you with?✓ ",
    );
    expect(filter.push("\u001b[38;2;189;147;")).toBe("");
    expect(filter.push("249m15 tok/s\u001b[39m")).toBe("15 tok/s");
    expect(filter.flush()).toBe("");
  });
});

const confirmRequest = {
  sessionId: "session-1",
  options: [
    { optionId: "choice-0", name: "Yes", kind: "allow_once" },
    { optionId: "choice-1", name: "No", kind: "reject_once" },
  ],
  toolCall: {
    toolCallId: "tool-1",
    title: "Continue?",
    status: "pending",
    rawInput: { method: "confirm" },
  },
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("Pi extension confirmations", () => {
  it("distinguishes confirmation interactions from ordinary permissions", () => {
    expect(isPiExtensionConfirm(confirmRequest)).toBe(true);
    expect(
      isPiExtensionConfirm({
        ...confirmRequest,
        toolCall: { ...confirmRequest.toolCall, rawInput: { method: "bash" } },
      }),
    ).toBe(false);
  });

  it("maps approval decisions to the option ids advertised by pi-acp", () => {
    expect(optionForPiApprovalDecision(confirmRequest, "accept")).toBe("choice-0");
    expect(optionForPiApprovalDecision(confirmRequest, "decline")).toBe("choice-1");
    expect(optionForPiApprovalDecision(confirmRequest, "cancel")).toBeUndefined();
  });
});
