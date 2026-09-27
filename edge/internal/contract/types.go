// Package contract mirrors the TypeScript wire contract in
// src/app/v1/_lib/edge/contract.ts (schemaVersion 1). Field names and JSON tags
// must stay identical to the TS zod schemas.
package contract

import "encoding/json"

const SchemaVersion = 1

// HeaderPair is a [name, value] tuple; names are lowercase and duplicates are kept.
type HeaderPair [2]string

// FingerprintBoundary mirrors FingerprintBoundary in affinity/fingerprint.ts.
type FingerprintBoundary struct {
	Depth           int    `json:"depth"`
	FP              string `json:"fp"`
	PrefixBytes     int    `json:"prefixBytes"`
	HasCacheControl bool   `json:"hasCacheControl,omitempty"`
}

// FingerprintChain mirrors FingerprintChain (sys + tail, tail is shallow -> deep).
type FingerprintChain struct {
	Sys  FingerprintBoundary   `json:"sys"`
	Tail []FingerprintBoundary `json:"tail"`
}

// RequestDigest is the body of POST /api/internal/edge/decide.
type RequestDigest struct {
	SchemaVersion  int          `json:"schemaVersion"`
	EdgeID         string       `json:"edgeId"`
	EdgeRequestID  string       `json:"edgeRequestId"`
	ReceivedAtMs   int64        `json:"receivedAtMs"`
	Method         string       `json:"method"`
	Path           string       `json:"path"`
	Headers        []HeaderPair `json:"headers"`
	ClientIP       *string      `json:"clientIp"`
	BodyBytes      int          `json:"bodyBytes"`
	BodyParseError *string      `json:"bodyParseError"`
	// Format is the client format resolved from the normalized path:
	// claude | response | openai (unsupported paths resolve to claude).
	Format   string                     `json:"format"`
	TopLevel map[string]json.RawMessage `json:"topLevel"`
	// MessagesCount / InputCount are the lengths of messages / input when they
	// are arrays (response format: after input normalization), otherwise null.
	MessagesCount        *int                  `json:"messagesCount"`
	InputCount           *int                  `json:"inputCount"`
	ResponseInputRectify *ResponseInputRectify `json:"responseInputRectify"`
	IsRemoteCompactionV2 bool                  `json:"isRemoteCompactionV2"`
	CodexInitialTextHash *string               `json:"codexInitialTextHash"`
	SystemKind           string                `json:"systemKind"`
	HasPrivateParams     bool                  `json:"hasPrivateParams"`
	IsProbe              bool                  `json:"isProbe"`
	IsWarmup             bool                  `json:"isWarmup"`
	MessagesHash         *string               `json:"messagesHash"`
	Fingerprint          *FingerprintChain     `json:"fingerprint"`
}

// ResponseInputRectify mirrors rectifyResponseInput's result (response format only).
type ResponseInputRectify struct {
	Action       string `json:"action"`
	OriginalType string `json:"originalType"`
}

// Client formats (RequestDigest.Format / ExecutionStep.ClientFormat).
const (
	FormatClaude   = "claude"
	FormatResponse = "response"
	FormatOpenAI   = "openai"
)

// TopLevelKeys are the body fields carried in RequestDigest.TopLevel
// (EDGE_TOP_LEVEL_KEYS in contract.ts, same order).
var TopLevelKeys = []string{
	"model", "stream", "stream_options", "max_tokens", "thinking", "output_config",
	"reasoning_effort", "reasoning", "text", "service_tier", "parallel_tool_calls",
	"prompt_cache_key", "previous_response_id", "metadata",
}

// BodyOp is a typed body transformation. Only the fields relevant to Op are set.
type BodyOp struct {
	Op    string          `json:"op"`
	Key   string          `json:"key,omitempty"`
	Value json.RawMessage `json:"value,omitempty"`
	TTL   string          `json:"ttl,omitempty"`
}

const (
	OpSetTopLevel                     = "set_top_level"
	OpDeleteTopLevel                  = "delete_top_level"
	OpRemoveSystemBillingHeader       = "remove_system_billing_header"
	OpSetCacheControlTTL              = "set_cache_control_ttl"
	OpApplyThinkingSignatureRectifier = "apply_thinking_signature_rectifier"
	OpStripPrivateParams              = "strip_private_params"
	OpNormalizeResponseInput          = "normalize_response_input"
)

// MutableTopLevelKeys lists the keys set_top_level / delete_top_level may touch.
var MutableTopLevelKeys = map[string]bool{
	"model": true, "max_tokens": true, "thinking": true,
	"output_config": true, "reasoning_effort": true, "reasoning": true,
	"text": true, "service_tier": true, "parallel_tool_calls": true,
	"prompt_cache_key": true, "stream_options": true, "metadata": true,
}

type StepProvider struct {
	ID       int64   `json:"id"`
	Name     string  `json:"name"`
	Priority float64 `json:"priority"`
	Type     string  `json:"type"`
}

type StepEndpoint struct {
	ID  *int64 `json:"id"`
	URL string `json:"url"`
}

type StepTimeouts struct {
	ConnectMs        int64 `json:"connectMs"`
	FirstByteMs      int64 `json:"firstByteMs"`
	NonStreamTotalMs int64 `json:"nonStreamTotalMs"`
	IdleMs           int64 `json:"idleMs"`
	HeadersMs        int64 `json:"headersMs"`
	BodyMs           int64 `json:"bodyMs"`
}

type StepTransport struct {
	ProxyURL              *string `json:"proxyUrl"`
	ProxyFallbackToDirect bool    `json:"proxyFallbackToDirect"`
	HTTP2                 bool    `json:"http2"`
}

type StepGate struct {
	Mode                string `json:"mode"` // off | shadow | enforce
	HighConcurrency     bool   `json:"highConcurrency"`
	IdleMs              int64  `json:"idleMs"`
	EventCap            int    `json:"eventCap"`
	ByteCap             int    `json:"byteCap"`
	CaptureCommitMarker bool   `json:"captureCommitMarker"`
}

type StepFixer struct {
	Enabled          bool `json:"enabled"`
	FixTruncatedJSON bool `json:"fixTruncatedJson"`
	FixSseFormat     bool `json:"fixSseFormat"`
	FixEncoding      bool `json:"fixEncoding"`
	MaxJSONDepth     int  `json:"maxJsonDepth"`
	MaxFixSize       int  `json:"maxFixSize"`
}

type StepHedge struct {
	ThresholdMs  int64 `json:"thresholdMs"`
	MaxInFlight  int   `json:"maxInFlight"`
	BillLosers   bool  `json:"billLosers"`
	LoserDrainMs int64 `json:"loserDrainMs"`
}

type StepReporting struct {
	MaxCompactBytes       int   `json:"maxCompactBytes"`
	MaxHeadBytes          int   `json:"maxHeadBytes"`
	MaxNonStreamBodyBytes int   `json:"maxNonStreamBodyBytes"`
	MaxErrorBodyBytes     int   `json:"maxErrorBodyBytes"`
	HeartbeatIntervalMs   int64 `json:"heartbeatIntervalMs"`
}

// ExecutionStep describes exactly one upstream attempt.
type ExecutionStep struct {
	StepID                  string       `json:"stepId"`
	AttemptNumber           int          `json:"attemptNumber"`
	TotalProvidersAttempted int          `json:"totalProvidersAttempted"`
	AttemptKind             string       `json:"attemptKind"`
	Provider                StepProvider `json:"provider"`
	// ClientFormat selects the gate protocol family, compact capture and metering rules.
	ClientFormat string `json:"clientFormat"`
	// ForceStreamHandling treats a 2xx non-SSE/HTML/JSON body as a stream (codex).
	ForceStreamHandling bool          `json:"forceStreamHandling"`
	Endpoint            StepEndpoint  `json:"endpoint"`
	Method              string        `json:"method"`
	URL                 string        `json:"url"`
	Headers             []HeaderPair  `json:"headers"`
	BodyOps             []BodyOp      `json:"bodyOps"`
	DelayMs             int64         `json:"delayMs"`
	IsStreaming         bool          `json:"isStreaming"`
	Timeouts            StepTimeouts  `json:"timeouts"`
	Transport           StepTransport `json:"transport"`
	Gate                StepGate      `json:"gate"`
	Fixer               StepFixer     `json:"fixer"`
	Hedge               *StepHedge    `json:"hedge"`
	Reporting           StepReporting `json:"reporting"`
	ClientAbortDrainMs  int64         `json:"clientAbortDrainMs"`
}

// FailResponse is relayed to the client verbatim.
type FailResponse struct {
	Status   int          `json:"status"`
	Headers  []HeaderPair `json:"headers"`
	BodyText string       `json:"bodyText"`
}

type BillingHeaderResult struct {
	RemovedCount    int      `json:"removedCount"`
	ExtractedValues []string `json:"extractedValues"`
}

type ThinkingSignatureResult struct {
	Applied                       bool `json:"applied"`
	RemovedThinkingBlocks         int  `json:"removedThinkingBlocks"`
	RemovedRedactedThinkingBlocks int  `json:"removedRedactedThinkingBlocks"`
	RemovedSignatureFields        int  `json:"removedSignatureFields"`
	RemovedTopLevelThinking       bool `json:"removedTopLevelThinking"`
}

// OpResults reports the outcome of content body ops executed for an attempt.
type OpResults struct {
	BillingHeader     *BillingHeaderResult     `json:"billingHeader,omitempty"`
	ThinkingSignature *ThinkingSignatureResult `json:"thinkingSignature,omitempty"`
}

type AttemptTiming struct {
	DispatchedAtMs  *int64 `json:"dispatchedAtMs"`
	FirstByteAtMs   *int64 `json:"firstByteAtMs"`
	EndedAtMs       int64  `json:"endedAtMs"`
	HealthElapsedMs int64  `json:"healthElapsedMs"`
}

// AttemptFailure is a discriminated union keyed by Kind.
type AttemptFailure struct {
	Kind string `json:"kind"`
	// upstream_status
	Status        int          `json:"status,omitempty"`
	StatusText    string       `json:"statusText,omitempty"`
	Headers       []HeaderPair `json:"headers,omitempty"`
	BodyText      string       `json:"bodyText,omitempty"`
	BodyTruncated bool         `json:"bodyTruncated,omitempty"`
	// transport
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
	// timeout
	TimeoutType string `json:"timeoutType,omitempty"`
	// gate
	Reason                string `json:"reason,omitempty"`
	FrameData             string `json:"frameData,omitempty"`
	InferenceText         string `json:"inferenceText,omitempty"`
	TerminalBeforeContent bool   `json:"terminalBeforeContent,omitempty"`
	FramesSeen            int    `json:"framesSeen,omitempty"`
	BufferedBytes         int    `json:"bufferedBytes,omitempty"`
	EchoExcludedBytes     int    `json:"echoExcludedBytes,omitempty"`
}

// MarshalJSON emits only the fields that belong to the failure kind so the
// TS discriminated union validates (required fields present, no strays).
func (f AttemptFailure) MarshalJSON() ([]byte, error) {
	out := map[string]any{"kind": f.Kind}
	switch f.Kind {
	case "upstream_status":
		headers := f.Headers
		if headers == nil {
			headers = []HeaderPair{}
		}
		out["status"] = f.Status
		out["statusText"] = f.StatusText
		out["headers"] = headers
		out["bodyText"] = f.BodyText
		out["bodyTruncated"] = f.BodyTruncated
	case "transport":
		out["code"] = f.Code
		out["message"] = f.Message
	case "timeout":
		out["timeoutType"] = f.TimeoutType
	case "gate":
		out["reason"] = f.Reason
		out["frameData"] = f.FrameData
		out["inferenceText"] = f.InferenceText
		out["terminalBeforeContent"] = f.TerminalBeforeContent
		out["framesSeen"] = f.FramesSeen
		out["bufferedBytes"] = f.BufferedBytes
		out["echoExcludedBytes"] = f.EchoExcludedBytes
	case "empty_response":
		out["reason"] = f.Reason
	case "local_capacity", "invalid_step":
		out["message"] = f.Message
	}
	return json.Marshal(out)
}

// NextEvent is a discriminated union keyed by Type.
type NextEvent struct {
	Type string `json:"type"`
	// failure
	Failure       *AttemptFailure `json:"failure,omitempty"`
	Dispatched    bool            `json:"dispatched"`
	FirstByteSeen bool            `json:"firstByteSeen"`
	Timing        *AttemptTiming  `json:"timing,omitempty"`
	// Peers carries the other in-flight hedge attempts on a pre-commit client abort.
	Peers []PeerTiming `json:"peers,omitempty"`
	// suspect_2xx
	Status        int          `json:"status,omitempty"`
	Headers       []HeaderPair `json:"headers,omitempty"`
	BodyText      string       `json:"bodyText,omitempty"`
	BodyTruncated bool         `json:"bodyTruncated,omitempty"`
	OpResults     *OpResults   `json:"opResults,omitempty"`
}

// MarshalJSON emits the fields of the event type only.
func (e NextEvent) MarshalJSON() ([]byte, error) {
	out := map[string]any{"type": e.Type}
	switch e.Type {
	case "failure":
		out["failure"] = e.Failure
		out["dispatched"] = e.Dispatched
		out["firstByteSeen"] = e.FirstByteSeen
		out["timing"] = e.Timing
		if len(e.Peers) > 0 {
			out["peers"] = e.Peers
		}
	case "suspect_2xx":
		headers := e.Headers
		if headers == nil {
			headers = []HeaderPair{}
		}
		out["status"] = e.Status
		out["headers"] = headers
		out["bodyText"] = e.BodyText
		out["bodyTruncated"] = e.BodyTruncated
	}
	if e.OpResults != nil && e.Type != "hedge_threshold" {
		out["opResults"] = e.OpResults
	}
	return json.Marshal(out)
}

// PeerTiming is the dispatch/first-byte state of another in-flight hedge attempt.
type PeerTiming struct {
	StepID          string `json:"stepId"`
	Dispatched      bool   `json:"dispatched"`
	FirstByteSeen   bool   `json:"firstByteSeen"`
	HealthElapsedMs int64  `json:"healthElapsedMs"`
}

type NextRequest struct {
	RequestID int64     `json:"requestId"`
	EdgeToken string    `json:"edgeToken"`
	StepID    string    `json:"stepId"`
	Event     NextEvent `json:"event"`
}

// NextResponse: action is retry | launch | wait | none | commit | fail | delegate.
type NextResponse struct {
	Action   string         `json:"action"`
	Step     *ExecutionStep `json:"step,omitempty"`
	Response *FailResponse  `json:"response,omitempty"`
	Reason   string         `json:"reason,omitempty"`
}

// DecideResponse: action is delegate | fail | execute.
type DecideResponse struct {
	Action    string         `json:"action"`
	Reason    string         `json:"reason,omitempty"`
	Response  *FailResponse  `json:"response,omitempty"`
	RequestID int64          `json:"requestId,omitempty"`
	EdgeToken string         `json:"edgeToken,omitempty"`
	Step      *ExecutionStep `json:"step,omitempty"`
}

type ProtocolFailure struct {
	Verdict      string  `json:"verdict"`
	EventName    *string `json:"eventName"`
	AfterContent bool    `json:"afterContent"`
	SawMalformed bool    `json:"sawMalformed"`
}

type ProtocolObservation struct {
	SawContent            bool             `json:"sawContent"`
	SawTerminal           bool             `json:"sawTerminal"`
	SawIncomplete         bool             `json:"sawIncomplete"`
	ObservationIncomplete bool             `json:"observationIncomplete"`
	Failure               *ProtocolFailure `json:"failure"`
}

type GateCommit struct {
	FrameIndex        int     `json:"frameIndex"`
	ChunkIndex        int     `json:"chunkIndex"`
	EventName         *string `json:"eventName"`
	BufferedBytes     int     `json:"bufferedBytes"`
	EchoExcludedBytes int     `json:"echoExcludedBytes"`
	GateWaitMs        int64   `json:"gateWaitMs"`
}

type FixerApplied struct {
	Fixer   string  `json:"fixer"`
	Applied bool    `json:"applied"`
	Details *string `json:"details,omitempty"`
}

type FixerAudit struct {
	Hit                 bool           `json:"hit"`
	FixersApplied       []FixerApplied `json:"fixersApplied"`
	TotalBytesProcessed int64          `json:"totalBytesProcessed"`
	ProcessingTimeMs    int64          `json:"processingTimeMs"`
}

type NonStreamBody struct {
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

type WinnerTiming struct {
	DispatchedAtMs  int64  `json:"dispatchedAtMs"`
	FirstByteAtMs   *int64 `json:"firstByteAtMs"`
	FirstTokenAtMs  *int64 `json:"firstTokenAtMs"`
	EndedAtMs       int64  `json:"endedAtMs"`
	HealthElapsedMs int64  `json:"healthElapsedMs"`
}

type WinnerResult struct {
	StepID              string               `json:"stepId"`
	UpstreamStatus      int                  `json:"upstreamStatus"`
	ResponseHeaders     []HeaderPair         `json:"responseHeaders"`
	IsStreaming         bool                 `json:"isStreaming"`
	StreamEndedNormally bool                 `json:"streamEndedNormally"`
	ClientAborted       bool                 `json:"clientAborted"`
	AbortReason         *string              `json:"abortReason"`
	FirstByteSeen       bool                 `json:"firstByteSeen"`
	SSEEventCount       int                  `json:"sseEventCount"`
	CompactSSE          string               `json:"compactSse"`
	CompactTruncated    bool                 `json:"compactTruncated"`
	NonStreamBody       *NonStreamBody       `json:"nonStreamBody"`
	Protocol            *ProtocolObservation `json:"protocol"`
	GateCommit          *GateCommit          `json:"gateCommit"`
	Fixer               *FixerAudit          `json:"fixer"`
	Timing              WinnerTiming         `json:"timing"`
	BytesToClient       int64                `json:"bytesToClient"`
	OpResults           *OpResults           `json:"opResults,omitempty"`
}

type LoserResult struct {
	StepID         string `json:"stepId"`
	UpstreamStatus int    `json:"upstreamStatus"`
	DrainComplete  bool   `json:"drainComplete"`
	MeteringText   string `json:"meteringText"`
	EndedAtMs      int64  `json:"endedAtMs"`
}

type CompleteRequest struct {
	RequestID int64         `json:"requestId"`
	EdgeToken string        `json:"edgeToken"`
	Winner    WinnerResult  `json:"winner"`
	Losers    []LoserResult `json:"losers"`
}

type HeartbeatRequest struct {
	RequestID      int64  `json:"requestId"`
	EdgeToken      string `json:"edgeToken"`
	BytesForwarded int64  `json:"bytesForwarded"`
}

// Abort reasons reported in WinnerResult.AbortReason.
const (
	AbortStreamResponseTimeout = "STREAM_RESPONSE_TIMEOUT"
	AbortStreamIdleTimeout     = "STREAM_IDLE_TIMEOUT"
	AbortClientAborted         = "CLIENT_ABORTED"
	AbortStreamUpstreamAborted = "STREAM_UPSTREAM_ABORTED"
	AbortStreamProcessingError = "STREAM_PROCESSING_ERROR"
)
