// Package bodyops applies contract.BodyOp mutations to a parsed request
// body, mirroring src/app/v1/_lib/edge/body-ops.ts applyBodyOps and the
// underlying rectifiers it calls (billing-header-rectifier.ts,
// forwarder.ts#applyCacheTtlOverrideToMessage/filterPrivateParameters,
// thinking-signature-rectifier.ts#rectifyAnthropicRequestMessage).
package bodyops

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/ding113/claude-code-hub/edge/internal/contract"
	"github.com/ding113/claude-code-hub/edge/internal/ojson"
)

// Apply clones body, applies ops in order and returns the resulting body plus
// the accumulated OpResults. body is never mutated.
func Apply(body *ojson.Value, ops []contract.BodyOp) (*ojson.Value, contract.OpResults, error) {
	message := body.Clone()
	if message == nil {
		message = ojson.NewObject()
	}
	var results contract.OpResults

	for _, op := range ops {
		switch op.Op {
		case contract.OpSetTopLevel:
			if !contract.MutableTopLevelKeys[op.Key] {
				return nil, contract.OpResults{}, fmt.Errorf("bodyops: key %q not mutable for set_top_level", op.Key)
			}
			val, err := ojson.Parse(op.Value, ojson.DefaultMaxDepth)
			if err != nil {
				return nil, contract.OpResults{}, fmt.Errorf("bodyops: invalid value for set_top_level: %w", err)
			}
			message.ObjectSet(op.Key, val)
		case contract.OpDeleteTopLevel:
			if !contract.MutableTopLevelKeys[op.Key] {
				return nil, contract.OpResults{}, fmt.Errorf("bodyops: key %q not mutable for delete_top_level", op.Key)
			}
			message.ObjectDelete(op.Key)
		case contract.OpRemoveSystemBillingHeader:
			result := rectifyBillingHeader(message)
			if result.applied {
				if results.BillingHeader == nil {
					results.BillingHeader = &contract.BillingHeaderResult{}
				}
				results.BillingHeader.RemovedCount += result.removedCount
				results.BillingHeader.ExtractedValues = append(results.BillingHeader.ExtractedValues, result.extractedValues...)
			}
		case contract.OpSetCacheControlTTL:
			if op.TTL != "5m" && op.TTL != "1h" {
				return nil, contract.OpResults{}, fmt.Errorf("bodyops: invalid ttl %q", op.TTL)
			}
			applyCacheTtlOverrideToMessage(message, op.TTL)
		case contract.OpApplyThinkingSignatureRectifier:
			hadThinking := message.ObjectHas("thinking")
			result := rectifyAnthropicRequestMessage(message)
			results.ThinkingSignature = &contract.ThinkingSignatureResult{
				Applied:                       result.applied,
				RemovedThinkingBlocks:         result.removedThinkingBlocks,
				RemovedRedactedThinkingBlocks: result.removedRedactedThinkingBlocks,
				RemovedSignatureFields:        result.removedSignatureFields,
				RemovedTopLevelThinking:       hadThinking && !message.ObjectHas("thinking"),
			}
		case contract.OpStripPrivateParams:
			message = filterPrivateParameters(message)
		case contract.OpNormalizeResponseInput:
			rectifyResponseInput(message)
		default:
			return nil, contract.OpResults{}, fmt.Errorf("bodyops: unknown op %q", op.Op)
		}
	}

	return message, results, nil
}

// ---- billing header rectifier (billing-header-rectifier.ts) ----

var billingHeaderPattern = regexp.MustCompile(`(?i)^\s*x-anthropic-billing-header\s*:`)

type billingHeaderResult struct {
	applied         bool
	removedCount    int
	extractedValues []string
}

func rectifyBillingHeader(message *ojson.Value) billingHeaderResult {
	system, ok := message.ObjectGet("system")
	if !ok || system.IsNull() {
		return billingHeaderResult{}
	}

	if system.IsString() {
		if billingHeaderPattern.MatchString(system.String()) {
			message.ObjectDelete("system")
			return billingHeaderResult{applied: true, removedCount: 1, extractedValues: []string{strings.TrimSpace(system.String())}}
		}
		return billingHeaderResult{}
	}

	if system.IsArray() {
		var extracted []string
		filtered := ojson.NewArray()
		for _, block := range system.ArrayItems() {
			if block.IsObject() {
				typ, _ := block.ObjectGet("type")
				textVal, hasText := block.ObjectGet("text")
				if typ.IsString() && typ.String() == "text" && hasText && textVal.IsString() &&
					billingHeaderPattern.MatchString(textVal.String()) {
					extracted = append(extracted, strings.TrimSpace(textVal.String()))
					continue
				}
			}
			filtered.ArrayAppend(block)
		}
		if len(extracted) > 0 {
			message.ObjectSet("system", filtered)
			return billingHeaderResult{applied: true, removedCount: len(extracted), extractedValues: extracted}
		}
		return billingHeaderResult{}
	}

	return billingHeaderResult{}
}

// ---- cache ttl override (forwarder.ts#applyCacheTtlOverrideToMessage) ----

func applyTtlToContentBlocks(blocks *ojson.Value, ttl string) bool {
	applied := false
	for _, item := range blocks.ArrayItems() {
		if !item.IsObject() {
			continue
		}
		cc, ok := item.ObjectGet("cache_control")
		if !ok || !cc.IsObject() {
			continue
		}
		typ, ok := cc.ObjectGet("type")
		if !ok || !typ.IsString() || typ.String() != "ephemeral" {
			continue
		}
		applied = true
		ttlVal := "5m"
		if ttl == "1h" {
			ttlVal = "1h"
		}
		cc.ObjectSet("ttl", ojson.NewString(ttlVal))
	}
	return applied
}

func applyCacheTtlOverrideToMessage(message *ojson.Value, ttl string) bool {
	applied := false

	if system, ok := message.ObjectGet("system"); ok && system.IsArray() {
		if applyTtlToContentBlocks(system, ttl) {
			applied = true
		}
	}

	if messages, ok := message.ObjectGet("messages"); ok && messages.IsArray() {
		for _, msg := range messages.ArrayItems() {
			if !msg.IsObject() {
				continue
			}
			content, ok := msg.ObjectGet("content")
			if !ok || !content.IsArray() {
				continue
			}
			if applyTtlToContentBlocks(content, ttl) {
				applied = true
			}
		}
	}

	return applied
}

// ---- thinking signature rectifier (thinking-signature-rectifier.ts) ----

type thinkingRectifierResult struct {
	applied                       bool
	removedThinkingBlocks         int
	removedRedactedThinkingBlocks int
	removedSignatureFields        int
}

func rectifyAnthropicRequestMessage(message *ojson.Value) thinkingRectifierResult {
	var result thinkingRectifierResult

	messages, ok := message.ObjectGet("messages")
	if !ok || !messages.IsArray() {
		return result
	}

	for _, msg := range messages.ArrayItems() {
		if !msg.IsObject() {
			continue
		}
		content, ok := msg.ObjectGet("content")
		if !ok || !content.IsArray() {
			continue
		}

		newContent := ojson.NewArray()
		contentWasModified := false

		for _, block := range content.ArrayItems() {
			if !block.IsObject() {
				newContent.ArrayAppend(block)
				continue
			}
			typ, _ := block.ObjectGet("type")
			typStr := ""
			if typ.IsString() {
				typStr = typ.String()
			}

			if typStr == "thinking" {
				result.removedThinkingBlocks++
				contentWasModified = true
				continue
			}
			if typStr == "redacted_thinking" {
				result.removedRedactedThinkingBlocks++
				contentWasModified = true
				continue
			}
			if block.ObjectHas("signature") {
				rest := ojson.NewObject()
				for _, k := range block.ObjectKeys() {
					if k == "signature" {
						continue
					}
					v, _ := block.ObjectGet(k)
					rest.ObjectSet(k, v)
				}
				result.removedSignatureFields++
				contentWasModified = true
				newContent.ArrayAppend(rest)
				continue
			}
			newContent.ArrayAppend(block)
		}

		if contentWasModified {
			result.applied = true
			msg.ObjectSet("content", newContent)
		}
	}

	thinking, hasThinking := message.ObjectGet("thinking")
	thinkingEnabled := false
	if hasThinking && thinking.IsObject() {
		if t, ok := thinking.ObjectGet("type"); ok && t.IsString() && t.String() == "enabled" {
			thinkingEnabled = true
		}
	}

	if thinkingEnabled {
		var lastAssistantContent *ojson.Value
		items := messages.ArrayItems()
		for i := len(items) - 1; i >= 0; i-- {
			msg := items[i]
			if !msg.IsObject() {
				continue
			}
			role, ok := msg.ObjectGet("role")
			if !ok || !role.IsString() || role.String() != "assistant" {
				continue
			}
			content, ok := msg.ObjectGet("content")
			if !ok || !content.IsArray() {
				continue
			}
			lastAssistantContent = content
			break
		}

		if lastAssistantContent != nil && lastAssistantContent.ArrayLen() > 0 {
			firstBlock := lastAssistantContent.ArrayGet(0)
			firstBlockType := ""
			if firstBlock.IsObject() {
				if t, ok := firstBlock.ObjectGet("type"); ok && t.IsString() {
					firstBlockType = t.String()
				}
			}
			missingThinkingPrefix := firstBlockType != "thinking" && firstBlockType != "redacted_thinking"

			if missingThinkingPrefix {
				hasToolUse := false
				for _, block := range lastAssistantContent.ArrayItems() {
					if !block.IsObject() {
						continue
					}
					if t, ok := block.ObjectGet("type"); ok && t.IsString() && t.String() == "tool_use" {
						hasToolUse = true
						break
					}
				}
				if hasToolUse {
					message.ObjectDelete("thinking")
					result.applied = true
				}
			}
		}
	}

	return result
}

// ---- response input rectifier (response-input-rectifier.ts#rectifyResponseInput) ----
//
// Mutates message.input in place, matching applyBodyOps' `case "normalize_response_input":
// rectifyResponseInput(message);` (the op result is not tracked in OpResults; only the
// digest's separate responseInputRectify field records the action/originalType).
func rectifyResponseInput(message *ojson.Value) {
	input, hasInput := message.ObjectGet("input")

	// Case 1: array -- passthrough.
	if hasInput && input.IsArray() {
		return
	}

	// Case 2: string.
	if hasInput && input.IsString() {
		if input.String() == "" {
			message.ObjectSet("input", ojson.NewArray())
			return
		}
		wrapped := ojson.NewArray()
		item := ojson.NewObject()
		item.ObjectSet("role", ojson.NewString("user"))
		contentArr := ojson.NewArray()
		contentBlock := ojson.NewObject()
		contentBlock.ObjectSet("type", ojson.NewString("input_text"))
		contentBlock.ObjectSet("text", ojson.NewString(input.String()))
		contentArr.ArrayAppend(contentBlock)
		item.ObjectSet("content", contentArr)
		wrapped.ArrayAppend(item)
		message.ObjectSet("input", wrapped)
		return
	}

	// Case 3: single object (MessageInput has role, ToolOutputsInput has type).
	if hasInput && input.IsObject() {
		if input.ObjectHas("role") || input.ObjectHas("type") {
			wrapped := ojson.NewArray()
			wrapped.ArrayAppend(input)
			message.ObjectSet("input", wrapped)
			return
		}
	}

	// Case 4: undefined/null/other -- passthrough, let downstream handle the error.
}

// ---- private parameter filtering (forwarder.ts#filterPrivateParameters) ----

func filterPrivateParameters(v *ojson.Value) *ojson.Value {
	if v == nil {
		return v
	}
	switch {
	case v.IsArray():
		out := ojson.NewArray()
		for _, item := range v.ArrayItems() {
			out.ArrayAppend(filterPrivateParameters(item))
		}
		return out
	case v.IsObject():
		out := ojson.NewObject()
		for _, k := range v.ObjectKeys() {
			if strings.HasPrefix(k, "_") {
				continue
			}
			child, _ := v.ObjectGet(k)
			out.ObjectSet(k, filterPrivateParameters(child))
		}
		return out
	default:
		return v
	}
}
