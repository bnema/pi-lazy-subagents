import type { CompletionPolicy, RunRecord } from "../types.js";

export interface CompletionRoutingContext {
  isIdle: boolean;
  hasPendingMessages: boolean;
}

export interface CompletionRoutingDecision {
  policy: CompletionPolicy;
  run: RunRecord;
  action: "follow_up" | "wake";
  deliverAs: "steer" | "followUp";
  triggerTurn: true;
}

export function decideCompletionRouting(run: RunRecord, context: CompletionRoutingContext): CompletionRoutingDecision {
  if (context.isIdle && !context.hasPendingMessages) {
    return {
      policy: "wake_if_idle",
      run,
      action: "wake",
      deliverAs: "steer",
      triggerTurn: true,
    };
  }

  return {
    policy: "wake_if_idle",
    run,
    action: "follow_up",
    deliverAs: "followUp",
    triggerTurn: true,
  };
}
