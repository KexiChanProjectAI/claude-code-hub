package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ding113/claude-code-hub/edge/internal/contract"
)

const responsesStream = "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"object\":\"response\",\"model\":\"gpt-5-codex\",\"status\":\"in_progress\",\"usage\":null}}\n\n" +
	"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"m1\",\"delta\":\"hello\"}\n\n" +
	"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"object\":\"response\",\"model\":\"gpt-5-codex\",\"status\":\"completed\",\"prompt_cache_key\":\"pck\",\"usage\":{\"input_tokens\":10,\"output_tokens\":4,\"total_tokens\":14}}}\n\n"

const chatStream = "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-4.1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n" +
	"data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-4.1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\n" +
	"data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-4.1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
	"data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-4.1\",\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\n" +
	"data: [DONE]\n\n"

func streamingUpstream(t *testing.T, contentType, stream string, gotBody *string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		if gotBody != nil {
			*gotBody = string(data)
		}
		w.Header().Set("Content-Type", contentType)
		flusher := w.(http.Flusher)
		for _, frame := range strings.SplitAfter(stream, "\n\n") {
			_, _ = w.Write([]byte(frame))
			flusher.Flush()
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestResponsesForcedStreamIsRelayedAsSSE(t *testing.T) {
	var upstreamBody string
	upstreamSrv := streamingUpstream(t, "application/octet-stream", responsesStream, &upstreamBody)
	step := baseStep(upstreamSrv.URL+"/v1/responses", true)
	step.Provider.Type = "codex"
	step.ClientFormat = contract.FormatResponse
	step.ForceStreamHandling = true
	step.BodyOps = []contract.BodyOp{{Op: contract.OpNormalizeResponseInput}}

	control := &fakeControl{decide: executeDecision(step)}
	h := newHarness(t, control)
	resp := h.post(t, "/responses", `{"model":"gpt-5-codex","stream":true,"input":"hi"}`, nil)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != responsesStream {
		t.Fatalf("status=%d body=%q", resp.StatusCode, body)
	}
	if resp.Header.Get("Content-Type") != "text/event-stream; charset=utf-8" {
		t.Fatalf("content type %q", resp.Header.Get("Content-Type"))
	}
	if upstreamBody != `{"model":"gpt-5-codex","stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}]}` {
		t.Fatalf("input not normalized: %s", upstreamBody)
	}
	digest := control.digests[0]
	if digest.Format != contract.FormatResponse || digest.InputCount == nil || *digest.InputCount != 1 {
		t.Fatalf("unexpected digest format=%s input=%v", digest.Format, digest.InputCount)
	}

	winner := h.reporter.waitComplete(t).Winner
	if !strings.Contains(winner.CompactSSE, "response.completed") || strings.Contains(winner.CompactSSE, "output_text.delta") {
		t.Fatalf("unexpected compact sse %q", winner.CompactSSE)
	}
	if winner.Protocol == nil || !winner.Protocol.SawTerminal || winner.Fixer != nil {
		t.Fatalf("unexpected observation %+v fixer %+v", winner.Protocol, winner.Fixer)
	}
}

func TestChatCompletionsStreamCompactKeepsUsageAndDone(t *testing.T) {
	upstreamSrv := streamingUpstream(t, "text/event-stream", chatStream, nil)
	step := baseStep(upstreamSrv.URL+"/v1/chat/completions", true)
	step.Provider.Type = "openai-compatible"
	step.ClientFormat = contract.FormatOpenAI
	step.BodyOps = []contract.BodyOp{{Op: contract.OpSetTopLevel, Key: "stream_options", Value: []byte(`{"include_usage":true}`)}}

	control := &fakeControl{decide: executeDecision(step)}
	h := newHarness(t, control)
	resp := h.post(t, "/v1/chat/completions", `{"model":"gpt-4.1","stream":true,"messages":[{"role":"user","content":"hi"}]}`, nil)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != chatStream {
		t.Fatalf("status=%d body=%q", resp.StatusCode, body)
	}
	if digest := control.digests[0]; digest.Format != contract.FormatOpenAI {
		t.Fatalf("digest format %s", digest.Format)
	}
	winner := h.reporter.waitComplete(t).Winner
	for _, want := range []string{`"completion_tokens":2`, "[DONE]", `"finish_reason":"stop"`} {
		if !strings.Contains(winner.CompactSSE, want) {
			t.Fatalf("compact sse missing %s: %q", want, winner.CompactSSE)
		}
	}
	if strings.Contains(winner.CompactSSE, "event:") {
		t.Fatalf("chat compact must not synthesize event lines: %q", winner.CompactSSE)
	}
	if winner.Protocol == nil || !winner.Protocol.SawTerminal {
		t.Fatalf("protocol %+v", winner.Protocol)
	}
}

func TestResponsesNonStreamOutputIsNormalized(t *testing.T) {
	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp_1","object":"response","output":null,"usage":{"input_tokens":3,"output_tokens":1}}`))
	}))
	defer upstreamSrv.Close()
	step := baseStep(upstreamSrv.URL+"/v1/responses", false)
	step.Provider.Type = "codex"
	step.ClientFormat = contract.FormatResponse
	step.BodyOps = nil

	h := newHarness(t, &fakeControl{decide: executeDecision(step)})
	resp := h.post(t, "/v1/responses", `{"model":"gpt-5-codex","input":[]}`, nil)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	want := `{"id":"resp_1","object":"response","output":[],"usage":{"input_tokens":3,"output_tokens":1}}`
	if string(body) != want {
		t.Fatalf("client body %s", body)
	}
	winner := h.reporter.waitComplete(t).Winner
	if winner.NonStreamBody == nil || winner.NonStreamBody.Text != want {
		t.Fatalf("reported body %+v", winner.NonStreamBody)
	}
}
