package contract

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const fixtureDir = "../../../tests/fixtures/edge/contract"

func int64Ptr(value int64) *int64 { return &value }
func strPtr(value string) *string { return &value }

// goSamples are Go-produced payloads validated by the TS zod schemas
// (tests/unit/edge/contract-fixtures.test.ts).
func goSamples() map[string]any {
	timing := &AttemptTiming{DispatchedAtMs: int64Ptr(1000), FirstByteAtMs: nil, EndedAtMs: 1500, HealthElapsedMs: 500}
	failures := []AttemptFailure{
		{Kind: "upstream_status", Status: 529, StatusText: "Overloaded", Headers: []HeaderPair{{"content-type", "application/json"}}, BodyText: `{"error":{}}`},
		{Kind: "transport", Code: "ECONNRESET", Message: "reset"},
		{Kind: "timeout", TimeoutType: "streaming_first_byte"},
		{Kind: "gate", Reason: "gate_error", FrameData: "{}", InferenceText: "{}", FramesSeen: 1, BufferedBytes: 10},
		{Kind: "empty_response", Reason: "empty_body"},
		{Kind: "client_abort"},
		{Kind: "local_capacity", Message: "full"},
		{Kind: "invalid_step", Message: "unknown op"},
	}
	samples := map[string]any{}
	for _, failure := range failures {
		copied := failure
		samples["next_failure_"+failure.Kind] = NextRequest{
			RequestID: 1, EdgeToken: "tttttttttttttttttttttttttttttttt", StepID: "1:1:1",
			Event: NextEvent{Type: "failure", Failure: &copied, Dispatched: true, Timing: timing,
				OpResults: &OpResults{BillingHeader: &BillingHeaderResult{RemovedCount: 1, ExtractedValues: []string{"x"}}}},
		}
	}
	samples["next_failure_client_abort_peers"] = NextRequest{RequestID: 1, EdgeToken: "tttttttttttttttttttttttttttttttt", StepID: "1:h1:1",
		Event: NextEvent{Type: "failure", Failure: &AttemptFailure{Kind: "client_abort"}, Dispatched: true, Timing: timing,
			Peers: []PeerTiming{{StepID: "1:h2:1", Dispatched: true, HealthElapsedMs: 40}}}}
	samples["next_hedge_threshold"] = NextRequest{RequestID: 1, EdgeToken: "tttttttttttttttttttttttttttttttt", StepID: "1:1:1",
		Event: NextEvent{Type: "hedge_threshold", OpResults: &OpResults{}}}
	samples["next_rectifier_not_applicable"] = NextRequest{RequestID: 1, EdgeToken: "tttttttttttttttttttttttttttttttt", StepID: "1:1:2",
		Event: NextEvent{Type: "rectifier_not_applicable", OpResults: &OpResults{ThinkingSignature: &ThinkingSignatureResult{}}}}
	samples["next_suspect_2xx"] = NextRequest{RequestID: 1, EdgeToken: "tttttttttttttttttttttttttttttttt", StepID: "1:1:1",
		Event: NextEvent{Type: "suspect_2xx", Status: 200, BodyText: "<html>"}}
	samples["complete"] = CompleteRequest{
		RequestID: 1, EdgeToken: "tttttttttttttttttttttttttttttttt",
		Winner: WinnerResult{
			StepID: "1:1:1", UpstreamStatus: 200, ResponseHeaders: []HeaderPair{{"content-type", "text/event-stream"}},
			IsStreaming: true, StreamEndedNormally: true, AbortReason: nil, FirstByteSeen: true,
			SSEEventCount: 3, CompactSSE: "event: message_stop\ndata: {}\n\n",
			Protocol:      &ProtocolObservation{SawContent: true, SawTerminal: true, Failure: &ProtocolFailure{Verdict: "error", EventName: strPtr("error")}},
			GateCommit:    &GateCommit{FrameIndex: 2, ChunkIndex: 1, EventName: strPtr("content_block_delta"), BufferedBytes: 10, GateWaitMs: 3},
			Fixer:         &FixerAudit{Hit: true, FixersApplied: []FixerApplied{{Fixer: "sse", Applied: true}}},
			Timing:        WinnerTiming{DispatchedAtMs: 1000, FirstByteAtMs: int64Ptr(1100), FirstTokenAtMs: int64Ptr(1200), EndedAtMs: 2000, HealthElapsedMs: 1000},
			BytesToClient: 42,
		},
		Losers: []LoserResult{},
	}
	samples["complete_non_stream"] = CompleteRequest{
		RequestID: 2, EdgeToken: "tttttttttttttttttttttttttttttttt",
		Winner: WinnerResult{
			StepID: "2:1:1", UpstreamStatus: 200, ResponseHeaders: []HeaderPair{},
			NonStreamBody: &NonStreamBody{Text: `{"usage":{}}`}, AbortReason: strPtr(AbortClientAborted),
			Timing: WinnerTiming{DispatchedAtMs: 1, EndedAtMs: 2},
		},
		Losers: []LoserResult{{StepID: "2:2:1", UpstreamStatus: 200, MeteringText: "", EndedAtMs: 3}},
	}
	samples["heartbeat"] = HeartbeatRequest{RequestID: 1, EdgeToken: "tttttttttttttttttttttttttttttttt", BytesForwarded: 10}
	return samples
}

func TestGoSamplesFixtureIsCurrent(t *testing.T) {
	encoded, err := json.MarshalIndent(goSamples(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	path := filepath.Join(fixtureDir, "go-samples.json")
	if os.Getenv("UPDATE_FIXTURES") != "" {
		if err := os.MkdirAll(fixtureDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	current, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing %s (run with UPDATE_FIXTURES=1): %v", path, err)
	}
	var want, got any
	_ = json.Unmarshal(current, &want)
	_ = json.Unmarshal(encoded, &got)
	wantJSON, _ := json.Marshal(want)
	gotJSON, _ := json.Marshal(got)
	if !bytes.Equal(wantJSON, gotJSON) {
		t.Fatalf("%s is stale; run with UPDATE_FIXTURES=1", path)
	}
}

func strictDecode(t *testing.T, raw json.RawMessage, target any) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		t.Fatalf("decode %T: %v\n%s", target, err, raw)
	}
}

// TS-produced responses (written by tests/unit/edge/contract-fixtures.test.ts)
// must decode into the Go types without unknown fields.
func TestTSSamplesDecodeStrictly(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(fixtureDir, "ts-samples.json"))
	if err != nil {
		t.Skipf("ts-samples.json not generated yet: %v", err)
	}
	var samples map[string]json.RawMessage
	if err := json.Unmarshal(data, &samples); err != nil {
		t.Fatal(err)
	}
	if len(samples) == 0 {
		t.Fatal("no TS samples")
	}
	for name, raw := range samples {
		switch {
		case len(name) >= 6 && name[:6] == "digest":
			var digest RequestDigest
			strictDecode(t, raw, &digest)
		case len(name) >= 6 && name[:6] == "decide":
			var response DecideResponse
			strictDecode(t, raw, &response)
			if response.Action == "execute" && (response.Step == nil || response.Step.StepID == "") {
				t.Fatalf("%s: execute without step", name)
			}
		case len(name) >= 4 && name[:4] == "next":
			var response NextResponse
			strictDecode(t, raw, &response)
		default:
			t.Fatalf("unknown TS sample %s", name)
		}
	}
}
