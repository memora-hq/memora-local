import { normalizeToolCall, type RawToolCall } from "./normalize.js";
import { evaluateAction } from "./engine.js";
import type { Rule, RuleSet } from "./schema.js";
import { requestApproval } from "../dialog/approvalDialog.js";

export type GuardrailOutcome = "allow" | "hard_block" | "ask_approved" | "ask_denied";

export interface GuardrailDecision {
  outcome: GuardrailOutcome;
  rule?: Rule;
  denyReason?: string;
}

export function isGuardrailApplicable(
  provider: string,
  payload: { hook_event_name?: unknown },
  disabled: boolean,
): boolean {
  if (disabled) return false;
  if (provider !== "codex" && provider !== "claude") return false;
  return payload.hook_event_name === "PreToolUse";
}

const SEVERITY: Record<"allow" | "ask" | "hard_block", number> = { allow: 0, ask: 1, hard_block: 2 };

export async function evaluateGuardrail(
  payload: RawToolCall,
  ruleSet: RuleSet,
  requestApprovalFn: typeof requestApproval = requestApproval,
): Promise<GuardrailDecision> {
  const actions = normalizeToolCall(payload);
  let best: { tier: "allow" | "ask" | "hard_block"; rule?: Rule; subject?: string } = { tier: "allow" };
  for (const action of actions) {
    const decision = evaluateAction(ruleSet, action);
    if (SEVERITY[decision.tier] > SEVERITY[best.tier]) {
      best = { tier: decision.tier, rule: decision.rule, subject: action.subject };
    }
  }
  if (best.tier === "allow") return { outcome: "allow" };
  if (best.tier === "hard_block") {
    return { outcome: "hard_block", rule: best.rule, denyReason: best.rule!.reason };
  }
  const approval = await requestApprovalFn({
    category: best.rule!.category,
    subject: best.subject!,
    reason: best.rule!.reason,
  });
  if (approval.approved) return { outcome: "ask_approved", rule: best.rule };
  const denyReason = approval.reason === "denied"
    ? "Denied by user"
    : approval.reason === "timeout"
      ? "Approval request timed out"
      : "No display available to show approval prompt";
  return { outcome: "ask_denied", rule: best.rule, denyReason };
}
