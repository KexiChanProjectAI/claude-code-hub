package capture

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

// compactFormatsCase mirrors one entry of
// tests/fixtures/edge/capture/compact-formats.json: {name, format,
// providerType, full, compact}. `full` and `compact` are plain SSE/JSON
// text (no base64 needed -- these fixtures are ASCII/JSON only).
type compactFormatsCase struct {
	Name         string `json:"name"`
	Format       string `json:"format"`
	ProviderType string `json:"providerType"`
	Full         string `json:"full"`
	Compact      string `json:"compact"`
}

const compactFormatsFixturePath = "../../../tests/fixtures/edge/capture/compact-formats.json"

// buildCompactFormatsCases constructs realistic full SSE (and one bare-JSON)
// streams for the "response" (OpenAI Responses) and "openai" (OpenAI Chat
// Completions) client formats, and computes the compact text
// NewCompactCaptureForFormat produces for each. These pairs are the fixture
// tests/unit/edge/compact-formats.test.ts cross-checks the real TS
// settlement parsers against (full vs compact must agree).
func buildCompactFormatsCases() []compactFormatsCase {
	var cases []compactFormatsCase
	add := func(name, format, providerType, full string) {
		cc := NewCompactCaptureForFormat(format, 64*1024)
		cc.Observe([]byte(full))
		compact, _, _ := cc.Result()
		cases = append(cases, compactFormatsCase{
			Name: name, Format: format, ProviderType: providerType,
			Full: full, Compact: compact,
		})
	}

	// -----------------------------------------------------------------
	// response (codex / OpenAI Responses API)
	// -----------------------------------------------------------------

	respCreated := frame("response.created", obj{
		"type": "response.created",
		"response": obj{
			"id": "resp_1", "object": "response", "status": "in_progress",
			"model": "gpt-5-codex", "prompt_cache_key": "cache-key-1",
			"service_tier": "auto",
		},
	})
	respInProgress := frame("response.in_progress", obj{
		"type": "response.in_progress",
		"response": obj{
			"id": "resp_1", "status": "in_progress", "model": "gpt-5-codex",
		},
	})
	outputItemAdded := frame("response.output_item.added", obj{
		"type": "response.output_item.added", "output_index": 0,
		"item": obj{"id": "msg_1", "type": "message", "role": "assistant"},
	})
	contentPartAdded := frame("response.content_part.added", obj{
		"type": "response.content_part.added", "output_index": 0, "content_index": 0,
		"part": obj{"type": "output_text", "text": ""},
	})
	var deltas []string
	for i, word := range []string{"Hello", ",", " world", "!"} {
		deltas = append(deltas, frame("response.output_text.delta", obj{
			"type": "response.output_text.delta", "output_index": 0, "content_index": 0,
			"item_id": "msg_1", "delta": word,
		}))
		_ = i
	}
	outputTextDone := frame("response.output_text.done", obj{
		"type": "response.output_text.done", "output_index": 0, "content_index": 0,
		"item_id": "msg_1", "text": "Hello, world!",
	})
	outputItemDone := frame("response.output_item.done", obj{
		"type": "response.output_item.done", "output_index": 0,
		"item": obj{"id": "msg_1", "type": "message", "role": "assistant"},
	})
	respCompleted := frame("response.completed", obj{
		"type": "response.completed",
		"response": obj{
			"id": "resp_1", "object": "response", "status": "completed",
			"model": "gpt-5-codex", "prompt_cache_key": "cache-key-1",
			"service_tier": "default",
			"usage": obj{
				"input_tokens": 120, "output_tokens": 42, "total_tokens": 162,
				"input_tokens_details":  obj{"cached_tokens": 30},
				"output_tokens_details": obj{"reasoning_tokens": 8},
			},
		},
	})

	full := respCreated + respInProgress + outputItemAdded + contentPartAdded +
		strings.Join(deltas, "") + outputTextDone + outputItemDone + respCompleted
	add("response_normal_complete", "response", "codex", full)

	// service_tier changes on a frame that is otherwise not kept for any
	// other reason (not first, no usage, not terminal/error): the
	// last-service_tier-wins rule must still surface it.
	respInProgressWithTier := frame("response.in_progress", obj{
		"type": "response.in_progress",
		"response": obj{
			"id": "resp_1", "status": "in_progress", "model": "gpt-5-codex",
			"service_tier": "priority_only_here",
		},
	})
	respCompletedNoTier := frame("response.completed", obj{
		"type": "response.completed",
		"response": obj{
			"id": "resp_1", "object": "response", "status": "completed",
			"model": "gpt-5-codex",
			"usage": obj{"input_tokens": 12, "output_tokens": 4},
		},
	})
	fullMidStreamTier := respCreated + respInProgressWithTier + outputItemAdded +
		strings.Join(deltas[:2], "") + respCompletedNoTier
	add("response_service_tier_only_on_middle_frame", "response", "codex", fullMidStreamTier)

	// More usage-bearing frames than compactUsageFrameCap, and the true last
	// usage-bearing frame is NOT the terminal frame: only the first N
	// deltas and the true last usage frame should be retained (plus the
	// terminal frame itself, which carries no usage of its own here).
	var manyUsageDeltas []string
	for i := 0; i < 8; i++ {
		manyUsageDeltas = append(manyUsageDeltas, frame("response.output_text.delta", obj{
			"type": "response.output_text.delta", "output_index": 0, "content_index": 0,
			"item_id": "msg_1", "delta": "x",
			"usage": obj{"input_tokens": 100, "output_tokens": i + 1},
		}))
	}
	respCompletedNoUsageNoTier := frame("response.completed", obj{
		"type": "response.completed",
		"response": obj{
			"id": "resp_1", "object": "response", "status": "completed", "model": "gpt-5-codex",
		},
	})
	fullManyUsage := respCreated + strings.Join(manyUsageDeltas, "") + respCompletedNoUsageNoTier
	add("response_many_usage_frames_exceed_cap", "response", "codex", fullManyUsage)

	respIncomplete := frame("response.incomplete", obj{
		"type": "response.incomplete",
		"response": obj{
			"id": "resp_2", "status": "incomplete", "model": "gpt-5-codex",
			"incomplete_details": obj{"reason": "max_output_tokens"},
			"usage":              obj{"input_tokens": 50, "output_tokens": 10},
		},
	})
	fullIncomplete := respCreated + respInProgress + outputItemAdded +
		strings.Join(deltas[:2], "") + respIncomplete
	add("response_incomplete", "response", "codex", fullIncomplete)

	respFailed := frame("response.failed", obj{
		"type": "response.failed",
		"response": obj{
			"id": "resp_3", "status": "failed",
			"error": obj{"code": "server_error", "message": "internal error"},
		},
	})
	fullFailed := respCreated + respInProgress + respFailed
	add("response_failed", "response", "codex", fullFailed)

	errorEvent := frame("error", obj{
		"type": "error", "code": "rate_limit_exceeded", "message": "too many requests",
	})
	fullErrorEvent := respCreated + respInProgress + errorEvent
	add("response_error_event", "response", "codex", fullErrorEvent)

	fullMissingTerminal := respCreated + respInProgress + outputItemAdded + contentPartAdded +
		strings.Join(deltas[:2], "") // client aborted mid-stream, no terminal frame at all
	add("response_missing_terminal", "response", "codex", fullMissingTerminal)

	// Forced-stream codex response that is not actually SSE: a single raw
	// JSON body (no "data:"/"event:" framing at all).
	nonSSE, _ := json.Marshal(obj{
		"id": "resp_4", "object": "response", "status": "completed",
		"model": "gpt-5-codex",
		"usage": obj{"input_tokens": 5, "output_tokens": 3},
	})
	add("response_non_sse_forced_stream", "response", "codex", string(nonSSE))

	// -----------------------------------------------------------------
	// openai (OpenAI-compatible Chat Completions)
	// -----------------------------------------------------------------

	chatID := "chatcmpl-1"
	roleChunk := dataFrame(obj{
		"id": chatID, "object": "chat.completion.chunk", "model": "gpt-4o-mini",
		"choices": []obj{{"index": 0, "delta": obj{"role": "assistant", "content": ""}, "finish_reason": nil}},
	})
	var contentChunks []string
	for _, word := range []string{"Hello", ",", " world", "!"} {
		contentChunks = append(contentChunks, dataFrame(obj{
			"id": chatID, "object": "chat.completion.chunk", "model": "gpt-4o-mini",
			"choices": []obj{{"index": 0, "delta": obj{"content": word}, "finish_reason": nil}},
		}))
	}
	finishChunk := dataFrame(obj{
		"id": chatID, "object": "chat.completion.chunk", "model": "gpt-4o-mini",
		"choices": []obj{{"index": 0, "delta": obj{}, "finish_reason": "stop"}},
	})
	usageChunk := dataFrame(obj{
		"id": chatID, "object": "chat.completion.chunk", "model": "gpt-4o-mini",
		"choices": []interface{}{},
		"usage":   obj{"prompt_tokens": 20, "completion_tokens": 6, "total_tokens": 26},
	})
	done := "data: [DONE]\n\n"

	fullChat := roleChunk + strings.Join(contentChunks, "") + finishChunk + usageChunk + done
	add("openai_normal_complete", "openai", "openai-compatible", fullChat)

	// Provider variant: usage present in every chunk (cumulative), and no
	// separate empty-choices usage chunk.
	var everyChunkUsage []string
	everyChunkUsage = append(everyChunkUsage, dataFrame(obj{
		"id": chatID, "object": "chat.completion.chunk", "model": "gpt-4o-mini",
		"choices": []obj{{"index": 0, "delta": obj{"role": "assistant", "content": "Hi"}, "finish_reason": nil}},
		"usage":   obj{"prompt_tokens": 20, "completion_tokens": 1, "total_tokens": 21},
	}))
	everyChunkUsage = append(everyChunkUsage, dataFrame(obj{
		"id": chatID, "object": "chat.completion.chunk", "model": "gpt-4o-mini",
		"choices": []obj{{"index": 0, "delta": obj{"content": " there"}, "finish_reason": nil}},
		"usage":   obj{"prompt_tokens": 20, "completion_tokens": 2, "total_tokens": 22},
	}))
	everyChunkUsage = append(everyChunkUsage, dataFrame(obj{
		"id": chatID, "object": "chat.completion.chunk", "model": "gpt-4o-mini",
		"choices": []obj{{"index": 0, "delta": obj{}, "finish_reason": "stop"}},
		"usage":   obj{"prompt_tokens": 20, "completion_tokens": 3, "total_tokens": 23},
	}))
	fullEveryChunkUsage := strings.Join(everyChunkUsage, "") + done
	add("openai_usage_in_every_chunk", "openai", "openai-compatible", fullEveryChunkUsage)

	// Mid-stream error object (no choices at all).
	errChunk := dataFrame(obj{
		"error": obj{"message": "internal error occurred", "type": "server_error", "code": "internal"},
	})
	fullErrorMidStream := roleChunk + contentChunks[0] + errChunk
	add("openai_error_object_mid_stream", "openai", "openai-compatible", fullErrorMidStream)

	// Same logical stream with explicit `event: message` lines vs none
	// (real OpenAI chat streams never send `event:`, but some
	// OpenAI-compatible relays do; parseSSEData treats both identically).
	fullNoEventLines := roleChunk + strings.Join(contentChunks, "") + finishChunk + usageChunk + done
	add("openai_no_event_lines", "openai", "openai-compatible", fullNoEventLines)

	withEventLines := eventFrame("message", obj{
		"id": chatID, "object": "chat.completion.chunk", "model": "gpt-4o-mini",
		"choices": []obj{{"index": 0, "delta": obj{"role": "assistant", "content": ""}, "finish_reason": nil}},
	})
	var withEventContentChunks []string
	for _, word := range []string{"Hello", ",", " world", "!"} {
		withEventContentChunks = append(withEventContentChunks, eventFrame("message", obj{
			"id": chatID, "object": "chat.completion.chunk", "model": "gpt-4o-mini",
			"choices": []obj{{"index": 0, "delta": obj{"content": word}, "finish_reason": nil}},
		}))
	}
	withEventFinish := eventFrame("message", obj{
		"id": chatID, "object": "chat.completion.chunk", "model": "gpt-4o-mini",
		"choices": []obj{{"index": 0, "delta": obj{}, "finish_reason": "stop"}},
	})
	withEventUsage := eventFrame("message", obj{
		"id": chatID, "object": "chat.completion.chunk", "model": "gpt-4o-mini",
		"choices": []interface{}{},
		"usage":   obj{"prompt_tokens": 20, "completion_tokens": 6, "total_tokens": 26},
	})
	fullWithEventLines := withEventLines + strings.Join(withEventContentChunks, "") + withEventFinish + withEventUsage + done
	add("openai_with_event_lines", "openai", "openai-compatible", fullWithEventLines)

	return cases
}

type obj = map[string]interface{}

func frame(event string, data obj) string {
	b, err := json.Marshal(data)
	if err != nil {
		panic(err)
	}
	return fmt.Sprintf("event: %s\ndata: %s\n\n", event, string(b))
}

func eventFrame(event string, data obj) string {
	return frame(event, data)
}

func dataFrame(data interface{}) string {
	b, err := json.Marshal(data)
	if err != nil {
		panic(err)
	}
	return fmt.Sprintf("data: %s\n\n", string(b))
}

func TestCompactCaptureFormatsFixtures(t *testing.T) {
	cases := buildCompactFormatsCases()

	if os.Getenv("UPDATE_FIXTURES") == "1" {
		out, err := json.MarshalIndent(cases, "", "  ")
		if err != nil {
			t.Fatalf("marshal fixtures: %v", err)
		}
		out = append(out, '\n')
		if err := os.WriteFile(compactFormatsFixturePath, out, 0o644); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
		t.Logf("wrote %s (%d cases)", compactFormatsFixturePath, len(cases))
		return
	}

	var want []compactFormatsCase
	loadFixture(t, "compact-formats.json", &want)

	if len(want) != len(cases) {
		t.Fatalf("fixture has %d cases, generator produced %d -- run with UPDATE_FIXTURES=1", len(want), len(cases))
	}

	for i, c := range cases {
		w := want[i]
		if c.Name != w.Name {
			t.Fatalf("case %d name = %q, fixture has %q (order changed?) -- run with UPDATE_FIXTURES=1", i, c.Name, w.Name)
		}
		t.Run(c.Name, func(t *testing.T) {
			if c.Full != w.Full {
				t.Errorf("full stream changed for %q -- run with UPDATE_FIXTURES=1", c.Name)
			}
			if c.Compact != w.Compact {
				t.Errorf("compact output changed for %q:\ngot:  %q\nwant: %q", c.Name, c.Compact, w.Compact)
			}
		})
	}
}

// TestCompactCaptureFormatsSplitInvariance feeds each full stream through
// NewCompactCaptureForFormat in different chunk splits and checks the
// compact output is identical regardless of how bytes arrived.
func TestCompactCaptureFormatsSplitInvariance(t *testing.T) {
	for _, c := range buildCompactFormatsCases() {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			full := []byte(c.Full)
			splits := [][]int{{len(full)}, splitEvery(full, 1), splitEvery(full, 7)}

			var ref string
			for i, sizes := range splits {
				cc := NewCompactCaptureForFormat(c.Format, 64*1024)
				offset := 0
				for _, size := range sizes {
					if offset >= len(full) {
						break
					}
					end := offset + size
					if end > len(full) {
						end = len(full)
					}
					cc.Observe(full[offset:end])
					offset = end
				}
				got, _, _ := cc.Result()
				if i == 0 {
					ref = got
					continue
				}
				if got != ref {
					t.Errorf("split %d differs.\ngot:  %q\nwant: %q", i, got, ref)
				}
			}
		})
	}
}
