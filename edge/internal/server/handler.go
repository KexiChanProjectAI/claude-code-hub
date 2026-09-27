// Package server implements the edge executor HTTP front end.
//
// Request flow (see docs in src/app/v1/_lib/edge/contract.ts):
//
//	static route -> not POST /v1/messages: reverse proxy to the control plane
//	read + decode body -> digest -> POST /decide
//	  delegate -> reverse proxy the original bytes
//	  fail     -> relay the prepared error response
//	  execute  -> run ExecutionSteps until one commits:
//	              pre-commit failures -> POST /next (retry | fail | delegate)
//	              commit -> stream to the client, heartbeat, POST /complete
//
// Invariants: no byte reaches the client before commit; /next is only called
// before commit; /complete is sent at most once per request.
package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/ding113/claude-code-hub/edge/internal/codec"
	"github.com/ding113/claude-code-hub/edge/internal/config"
	"github.com/ding113/claude-code-hub/edge/internal/contract"
	"github.com/ding113/claude-code-hub/edge/internal/delegate"
	"github.com/ding113/claude-code-hub/edge/internal/digest"
	"github.com/ding113/claude-code-hub/edge/internal/gate"
	"github.com/ding113/claude-code-hub/edge/internal/ojson"
	"github.com/ding113/claude-code-hub/edge/internal/route"
	"github.com/ding113/claude-code-hub/edge/internal/upstream"
)

// Controller abstracts the control plane client (replaceable in tests).
type Controller interface {
	Decide(ctx context.Context, digest *contract.RequestDigest) (*contract.DecideResponse, error)
	Next(ctx context.Context, request *contract.NextRequest) (*contract.NextResponse, error)
}

// Reporter abstracts completion/heartbeat delivery (replaceable in tests).
type Reporter interface {
	Complete(ctx context.Context, request *contract.CompleteRequest)
	Heartbeat(ctx context.Context, request *contract.HeartbeatRequest) error
}

type Handler struct {
	cfg        *config.Config
	control    Controller
	reporter   Reporter
	delegator  *delegate.Delegator
	upstream   *upstream.Client
	budget     *gate.Budget
	logger     *slog.Logger
	sem        chan struct{}
	requestSeq atomic.Uint64
	metrics    *Metrics
	// baseCtx outlives individual requests (used for background reporting).
	baseCtx context.Context
}

type Deps struct {
	Config    *config.Config
	Control   Controller
	Reporter  Reporter
	Delegator *delegate.Delegator
	Upstream  *upstream.Client
	Budget    *gate.Budget
	Logger    *slog.Logger
	Metrics   *Metrics
	BaseCtx   context.Context
}

func NewHandler(deps Deps) *Handler {
	metrics := deps.Metrics
	if metrics == nil {
		metrics = NewMetrics()
	}
	baseCtx := deps.BaseCtx
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	return &Handler{
		cfg:       deps.Config,
		control:   deps.Control,
		reporter:  deps.Reporter,
		delegator: deps.Delegator,
		upstream:  deps.Upstream,
		budget:    deps.Budget,
		logger:    deps.Logger,
		sem:       make(chan struct{}, deps.Config.MaxConcurrency),
		metrics:   metrics,
		baseCtx:   baseCtx,
	}
}

// ServeHTTP is the entry point for client traffic.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	stripInternalHeaders(r.Header)

	if route.Decide(r.Method, r.URL.RequestURI()) != route.Execute {
		h.metrics.requests.Add("static_delegate", 1)
		h.delegator.Serve(w, r, nil, "static_route")
		return
	}

	select {
	case h.sem <- struct{}{}:
		defer func() { <-h.sem }()
	default:
		h.metrics.requests.Add("overflow", 1)
		if h.cfg.OverflowToDelegate {
			h.delegator.Serve(w, r, nil, "edge_overloaded")
			return
		}
		delegate.WriteError(w, http.StatusServiceUnavailable, "edge executor overloaded", "service_unavailable_error")
		return
	}

	receivedAt := time.Now()
	raw, err := readBody(r.Body, h.cfg.MaxCompressedBodyBytes)
	if err != nil {
		if errors.Is(err, errBodyTooLarge) {
			delegate.WriteError(w, http.StatusRequestEntityTooLarge, "Request body exceeds the maximum allowed size.", "invalid_request_error")
			return
		}
		h.logger.Debug("failed to read request body", "error", err)
		return
	}

	decoded, err := codec.Decode(raw, r.Header.Get("Content-Encoding"), h.cfg.MaxBodyBytes, h.cfg.MaxCompressedBodyBytes)
	if err != nil {
		h.metrics.requests.Add("delegate_codec", 1)
		h.delegator.Serve(w, r, raw, "body_encoding")
		return
	}

	body, parseErr := ojson.Parse(decoded.Body, h.cfg.MaxJSONDepth)
	if parseErr != nil || body == nil || !body.IsObject() {
		h.metrics.requests.Add("delegate_parse", 1)
		h.delegator.Serve(w, r, raw, "body_parse")
		return
	}

	digestHeaders := h.digestHeaders(r, decoded.Decoded)
	requestDigest := digest.Build(digest.Input{
		EdgeID:        h.cfg.EdgeID,
		EdgeRequestID: h.nextRequestID(),
		ReceivedAtMs:  receivedAt.UnixMilli(),
		Method:        r.Method,
		Path:          route.CanonicalRequestPath(r.URL.RequestURI()),
		Headers:       digestHeaders,
		ClientIP:      h.clientIPPtr(r),
		Body:          body,
		BodyBytes:     len(decoded.Body),
	})

	decideStarted := time.Now()
	decision, err := h.control.Decide(r.Context(), &requestDigest)
	h.metrics.observeDecide(time.Since(decideStarted), err)
	if err != nil {
		h.logger.Warn("decide failed", "error", err)
		h.metrics.requests.Add("control_unreachable", 1)
		if h.cfg.FallbackToDelegate {
			h.delegator.Serve(w, r, raw, "control_unreachable")
			return
		}
		delegate.WriteError(w, http.StatusServiceUnavailable, "edge control plane unavailable", "service_unavailable_error")
		return
	}

	switch decision.Action {
	case "delegate":
		h.metrics.requests.Add("delegate", 1)
		h.delegator.Serve(w, r, raw, decision.Reason)
	case "fail":
		h.metrics.requests.Add("fail", 1)
		writeFailResponse(w, decision.Response)
	case "execute":
		if decision.Step == nil {
			h.delegator.Serve(w, r, raw, "invalid_decide_response")
			return
		}
		h.metrics.requests.Add("execute", 1)
		exec := &execution{
			h:         h,
			w:         w,
			r:         r,
			raw:       raw,
			body:      body,
			requestID: decision.RequestID,
			edgeToken: decision.EdgeToken,
			startedAt: receivedAt,
		}
		exec.run(decision.Step)
	default:
		h.delegator.Serve(w, r, raw, "unknown_decide_action")
	}
}

func (h *Handler) nextRequestID() string {
	return h.cfg.EdgeID + "-" + uint64String(uint64(time.Now().UnixNano())) + "-" + uint64String(h.requestSeq.Add(1))
}

// digestHeaders returns the client headers as the control plane should see them.
// Forwarding headers are replaced with the client IP observed here (the edge is
// the first hop unless EDGE_TRUSTED_PROXY_CIDRS says otherwise), and
// content-encoding is dropped when the edge already decoded the body.
func (h *Handler) digestHeaders(r *http.Request, decoded bool) []contract.HeaderPair {
	trusted := h.isTrustedPeer(r)
	pairs := make([]contract.HeaderPair, 0, len(r.Header)+2)
	for name, values := range r.Header {
		lower := strings.ToLower(name)
		if !trusted && (lower == "x-forwarded-for" || lower == "x-real-ip" || lower == "forwarded") {
			continue
		}
		if decoded && lower == "content-encoding" {
			continue
		}
		for _, value := range values {
			pairs = append(pairs, contract.HeaderPair{lower, value})
		}
	}
	if !trusted {
		if ip := peerIP(r); ip != "" {
			pairs = append(pairs, contract.HeaderPair{"x-forwarded-for", ip}, contract.HeaderPair{"x-real-ip", ip})
		}
	}
	return pairs
}

func (h *Handler) isTrustedPeer(r *http.Request) bool {
	if len(h.cfg.TrustedProxyCIDRs) == 0 {
		return false
	}
	ip := net.ParseIP(peerIP(r))
	if ip == nil {
		return false
	}
	for _, cidr := range h.cfg.TrustedProxyCIDRs {
		if _, network, err := net.ParseCIDR(cidr); err == nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

func (h *Handler) clientIPPtr(r *http.Request) *string {
	ip := peerIP(r)
	if ip == "" {
		return nil
	}
	return &ip
}

func peerIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func stripInternalHeaders(header http.Header) {
	for name := range header {
		if strings.HasPrefix(strings.ToLower(name), "x-cch-") {
			header.Del(name)
		}
	}
}

var errBodyTooLarge = errors.New("request body too large")

func readBody(body io.ReadCloser, limit int64) ([]byte, error) {
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errBodyTooLarge
	}
	return data, nil
}

func writeFailResponse(w http.ResponseWriter, response *contract.FailResponse) {
	if response == nil {
		delegate.WriteError(w, http.StatusBadGateway, "invalid control plane response", "bad_gateway_error")
		return
	}
	header := w.Header()
	for _, pair := range response.Headers {
		header.Add(pair[0], pair[1])
	}
	w.WriteHeader(response.Status)
	_, _ = io.WriteString(w, response.BodyText)
}

func uint64String(value uint64) string {
	if value == 0 {
		return "0"
	}
	var buf [20]byte
	index := len(buf)
	for value > 0 {
		index--
		buf[index] = byte('0' + value%10)
		value /= 10
	}
	return string(buf[index:])
}
