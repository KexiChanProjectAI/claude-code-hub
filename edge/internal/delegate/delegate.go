// Package delegate reverse-proxies requests the edge does not execute to the
// control plane's regular /v1 proxy, streaming the response back untouched.
package delegate

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ReasonHeader tells operators (and tests) why the edge delegated a request.
const ReasonHeader = "x-cch-edge-delegated"

type Delegator struct {
	proxy *httputil.ReverseProxy
}

func New(target *url.URL, logger *slog.Logger) *Delegator {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = 128
	transport.DisableCompression = true
	transport.ResponseHeaderTimeout = 0
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = target.Host
			// Rewrite has already removed inbound Forwarded / X-Forwarded-* headers;
			// the control plane sees the client IP observed by the edge.
			pr.SetXForwarded()
			if ip := clientIP(pr.In); ip != "" {
				pr.Out.Header.Set("X-Real-Ip", ip)
			}
		},
		Transport:     transport,
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			logger.Warn("delegate upstream failed", "path", r.URL.Path, "error", err.Error())
			WriteError(w, http.StatusBadGateway, "edge delegate unavailable", "bad_gateway_error")
		},
	}
	return &Delegator{proxy: proxy}
}

// Serve proxies r. When body is non-nil it replaces the (already consumed)
// inbound body; the original Content-Encoding header is kept so the control plane
// decodes exactly what the client sent.
func (d *Delegator) Serve(w http.ResponseWriter, r *http.Request, body []byte, reason string) {
	if body != nil {
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
		r.Header.Set("Content-Length", strconv.Itoa(len(body)))
		r.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
	}
	if reason != "" {
		w.Header().Set(ReasonHeader, reason)
	}
	d.proxy.ServeHTTP(w, r)
}

func clientIP(r *http.Request) string {
	host := r.RemoteAddr
	if index := strings.LastIndexByte(host, ':'); index >= 0 && !strings.HasSuffix(host, "]") {
		host = host[:index]
	}
	return strings.Trim(host, "[]")
}

// WriteError writes the CCH proxy error envelope ({"error":{"message","type","code"}}).
func WriteError(w http.ResponseWriter, status int, message, errorType string) {
	type body struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    string `json:"code"`
	}
	payload, _ := json.Marshal(struct {
		Error body `json:"error"`
	}{Error: body{Message: message, Type: errorType, Code: errorType}})
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// Timeout used by callers when they buffer a delegated body.
const DefaultTimeout = 10 * time.Minute
