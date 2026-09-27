/**
 * Body op 的 TS 参考实现。
 *
 * 每个 op 都直接调用本地转发路径使用的同一个函数，因此「原始请求体 + op 日志」重放的结果
 * 与本地 doForwardPrepared 对 session.request.message 的累计改写完全一致。
 * Go 执行器（edge/internal/bodyops）以本实现为准，由共享 fixture 约束两侧一致。
 */
import { rectifyBillingHeader } from "../proxy/billing-header-rectifier";
import { applyCacheTtlOverrideToMessage, filterPrivateParameters } from "../proxy/forwarder";
import { rectifyResponseInput } from "../proxy/response-input-rectifier";
import { rectifyAnthropicRequestMessage } from "../proxy/thinking-signature-rectifier";
import type { BodyOp, OpResults } from "./contract";

export interface BodyOpsApplication {
  message: Record<string, unknown>;
  opResults: OpResults;
}

export function applyBodyOps(
  original: Record<string, unknown>,
  ops: readonly BodyOp[]
): BodyOpsApplication {
  let message = structuredClone(original);
  const opResults: OpResults = {};

  for (const op of ops) {
    switch (op.op) {
      case "set_top_level":
        // 已存在的键原位覆盖、不存在的键追加到末尾（与 JS 对象赋值语义一致）
        message[op.key] = structuredClone(op.value);
        break;
      case "delete_top_level":
        delete message[op.key];
        break;
      case "remove_system_billing_header": {
        const result = rectifyBillingHeader(message);
        if (result.applied) {
          const previous = opResults.billingHeader;
          opResults.billingHeader = {
            removedCount: (previous?.removedCount ?? 0) + result.removedCount,
            extractedValues: [...(previous?.extractedValues ?? []), ...result.extractedValues],
          };
        }
        break;
      }
      case "set_cache_control_ttl":
        applyCacheTtlOverrideToMessage(message, op.ttl);
        break;
      case "apply_thinking_signature_rectifier": {
        const hadThinking = Object.hasOwn(message, "thinking");
        const result = rectifyAnthropicRequestMessage(message);
        opResults.thinkingSignature = {
          applied: result.applied,
          removedThinkingBlocks: result.removedThinkingBlocks,
          removedRedactedThinkingBlocks: result.removedRedactedThinkingBlocks,
          removedSignatureFields: result.removedSignatureFields,
          removedTopLevelThinking: hadThinking && !Object.hasOwn(message, "thinking"),
        };
        break;
      }
      case "strip_private_params":
        message = filterPrivateParameters(message) as Record<string, unknown>;
        break;
      case "normalize_response_input":
        rectifyResponseInput(message);
        break;
    }
  }

  return { message, opResults };
}
