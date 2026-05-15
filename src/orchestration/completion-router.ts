import type { CompletionPolicy, RunRecord } from "../types.js";

export interface CompletionRoutingContext {
  isIdle: boolean;
  hasPendingMessages: boolean;
}

export interface CompletionRoutingDecision {
  policy: CompletionPolicy;
  run: RunRecord;
  action: "notify" | "follow_up" | "wake" | "manual";
  deliverAs?: "steer" | "followUp";
  triggerTurn?: boolean;
}

export function decideCompletionRouting(run: RunRecord, context: CompletionRoutingContext): CompletionRoutingDecision {
  switch (run.completionPolicy) {
    case "notify_only":
      return { policy: run.completionPolicy, run, action: "notify" };
    case "manual_pickup":
      return { policy: run.completionPolicy, run, action: "manual" };
    case "follow_up_when_idle":
      return {
        policy: run.completionPolicy,
        run,
        action: "follow_up",
        deliverAs: "followUp",
        triggerTurn: true,
      };
    case "wake_if_idle":
      if (context.isIdle && !context.hasPendingMessages) {
        return {
          policy: run.completionPolicy,
          run,
          action: "wake",
          deliverAs: "steer",
          triggerTurn: true,
        };
      }

      return {
        policy: run.completionPolicy,
        run,
        action: "follow_up",
        deliverAs: "followUp",
        triggerTurn: true,
      };
  }
}
