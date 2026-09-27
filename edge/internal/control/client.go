// Package control is the HTTP client for the control plane's /api/internal/edge API.
package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/ding113/claude-code-hub/edge/internal/contract"
)

const (
	SecretHeader = "x-cch-edge-secret"
	EdgeIDHeader = "x-cch-edge-id"
	maxResponse  = 8 << 20
)

// APIError is a non-2xx response from the control plane.
type APIError struct {
	Status int
	Code   string
	Body   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("control plane returned %d (%s)", e.Status, e.Code)
}

// IsStale reports control-plane rejections that mean the request state has moved on
// (already settled, stale step, unknown request). Retrying them is pointless.
func IsStale(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	return apiErr.Status == http.StatusConflict || apiErr.Status == http.StatusNotFound ||
		apiErr.Status == http.StatusForbidden
}

type Client struct {
	base             *url.URL
	secret           string
	edgeID           string
	http             *http.Client
	decideTimeout    time.Duration
	nextTimeout      time.Duration
	completeTimeout  time.Duration
	heartbeatTimeout time.Duration
}

type Options struct {
	BaseURL          *url.URL
	Secret           string
	EdgeID           string
	HTTPClient       *http.Client
	DecideTimeout    time.Duration
	NextTimeout      time.Duration
	CompleteTimeout  time.Duration
	HeartbeatTimeout time.Duration
}

func New(opts Options) *Client {
	httpClient := opts.HTTPClient
	if httpClient == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.MaxIdleConnsPerHost = 64
		httpClient = &http.Client{Transport: transport}
	}
	return &Client{
		base:             opts.BaseURL,
		secret:           opts.Secret,
		edgeID:           opts.EdgeID,
		http:             httpClient,
		decideTimeout:    opts.DecideTimeout,
		nextTimeout:      opts.NextTimeout,
		completeTimeout:  opts.CompleteTimeout,
		heartbeatTimeout: opts.HeartbeatTimeout,
	}
}

func (c *Client) post(ctx context.Context, path string, timeout time.Duration, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	endpoint := c.base.JoinPath("/api/internal/edge", path)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set(SecretHeader, c.secret)
	req.Header.Set(EdgeIDHeader, c.edgeID)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		apiErr := &APIError{Status: resp.StatusCode, Body: string(data)}
		var envelope struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &envelope) == nil {
			apiErr.Code = envelope.Error.Code
		}
		return apiErr
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

func (c *Client) Decide(ctx context.Context, digest *contract.RequestDigest) (*contract.DecideResponse, error) {
	var out contract.DecideResponse
	if err := c.post(ctx, "decide", c.decideTimeout, digest, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Next(ctx context.Context, request *contract.NextRequest) (*contract.NextResponse, error) {
	var out contract.NextResponse
	if err := c.post(ctx, "next", c.nextTimeout, request, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Complete(ctx context.Context, request *contract.CompleteRequest) error {
	return c.post(ctx, "complete", c.completeTimeout, request, nil)
}

// CompleteRaw posts an already serialized completion report (outbox replay).
func (c *Client) CompleteRaw(ctx context.Context, body json.RawMessage) error {
	return c.post(ctx, "complete", c.completeTimeout, body, nil)
}

func (c *Client) Heartbeat(ctx context.Context, request *contract.HeartbeatRequest) error {
	return c.post(ctx, "heartbeat", c.heartbeatTimeout, request, nil)
}

// Health probes the control plane (used for readiness).
func (c *Client) Health(ctx context.Context) error {
	endpoint := c.base.JoinPath("/api/internal/edge/health")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set(SecretHeader, c.secret)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return &APIError{Status: resp.StatusCode}
	}
	return nil
}
