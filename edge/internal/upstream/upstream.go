// Package upstream performs one upstream HTTP attempt described by an ExecutionStep.
//
// Mirrors ProxyForwarder.doForwardPrepared transport behavior: headers are sent
// exactly as planned by the control plane, redirects are not followed, a gzip
// response body is decoded transparently (content-encoding / content-length are
// dropped), outbound proxies (http, https, socks5) may fall back to a direct
// connection, and HTTP/2 protocol failures are retried once over HTTP/1.1.
package upstream

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/ding113/claude-code-hub/edge/internal/contract"
)

// hop-by-hop and framing headers the transport computes itself.
var skippedRequestHeaders = map[string]bool{
	"connection": true, "keep-alive": true, "transfer-encoding": true, "te": true,
	"upgrade": true, "content-length": true, "proxy-connection": true, "host": true,
}

type transportKey struct {
	proxyURL string
	http2    bool
	connect  time.Duration
	headers  time.Duration
	direct   bool
}

// Client caches transports per (proxy, protocol, timeout) combination.
type Client struct {
	mu           sync.Mutex
	transports   map[transportKey]*http.Transport
	h2Quarantine sync.Map // host -> time.Time until which HTTP/2 is avoided
}

func NewClient() *Client {
	return &Client{transports: make(map[transportKey]*http.Transport)}
}

func (c *Client) transport(key transportKey) (*http.Transport, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.transports[key]; ok {
		return existing, nil
	}
	dialer := &net.Dialer{Timeout: key.connect, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: key.headers,
		DisableCompression:    true,
		MaxIdleConns:          512,
		MaxIdleConnsPerHost:   64,
		IdleConnTimeout:       90 * time.Second,
		ForceAttemptHTTP2:     key.http2,
	}
	if !key.http2 {
		transport.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	}
	if key.proxyURL != "" && !key.direct {
		proxyURL, err := url.Parse(key.proxyURL)
		if err != nil {
			return nil, err
		}
		transport.Proxy = http.ProxyURL(proxyURL)
	}
	c.transports[key] = transport
	return transport, nil
}

// Result of a single round trip.
type Result struct {
	Response      *http.Response
	HTTP2Fallback bool
	ProxyFallback bool
}

// Do sends the request. The response body is owned by the caller.
func (c *Client) Do(ctx context.Context, step *contract.ExecutionStep, body []byte, onDispatch func()) (*Result, error) {
	proxy := ""
	if step.Transport.ProxyURL != nil {
		proxy = *step.Transport.ProxyURL
	}
	key := transportKey{
		proxyURL: proxy,
		http2:    step.Transport.HTTP2,
		connect:  time.Duration(step.Timeouts.ConnectMs) * time.Millisecond,
		headers:  time.Duration(step.Timeouts.HeadersMs) * time.Millisecond,
	}
	host := hostOf(step.URL)
	if key.http2 && c.isQuarantined(host) {
		key.http2 = false
	}

	result := &Result{}
	resp, err := c.roundTrip(ctx, key, step, body, onDispatch)
	if err != nil && key.http2 && IsHTTP2Error(err) && ctx.Err() == nil {
		c.h2Quarantine.Store(host, time.Now().Add(10*time.Minute))
		key.http2 = false
		result.HTTP2Fallback = true
		resp, err = c.roundTrip(ctx, key, step, body, nil)
	}
	if err != nil && proxy != "" && step.Transport.ProxyFallbackToDirect && isProxyConnectError(err) && ctx.Err() == nil {
		key.direct = true
		result.ProxyFallback = true
		resp, err = c.roundTrip(ctx, key, step, body, nil)
	}
	if err != nil {
		return result, err
	}
	decodeGzip(resp)
	result.Response = resp
	return result, nil
}

func (c *Client) isQuarantined(host string) bool {
	value, ok := c.h2Quarantine.Load(host)
	if !ok {
		return false
	}
	if time.Now().After(value.(time.Time)) {
		c.h2Quarantine.Delete(host)
		return false
	}
	return true
}

func (c *Client) roundTrip(ctx context.Context, key transportKey, step *contract.ExecutionStep, body []byte, onDispatch func()) (*http.Response, error) {
	transport, err := c.transport(key)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, step.Method, step.URL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.ContentLength = int64(len(body))
	req.Header = make(http.Header, len(step.Headers))
	for _, pair := range step.Headers {
		name := strings.ToLower(pair[0])
		if name == "host" {
			req.Host = pair[1]
			continue
		}
		if skippedRequestHeaders[name] {
			continue
		}
		// Keep the header name exactly as planned (no canonicalization).
		req.Header[pair[0]] = append(req.Header[pair[0]], pair[1])
	}
	if onDispatch != nil {
		onDispatch()
	}
	return transport.RoundTrip(req)
}

func hostOf(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return parsed.Host
}

type gzipBody struct {
	reader *gzip.Reader
	raw    io.ReadCloser
}

func (g *gzipBody) Read(p []byte) (int, error) {
	n, err := g.reader.Read(p)
	// Tolerate a truncated gzip trailer like zlib Z_SYNC_FLUSH: keep decoded bytes.
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return n, io.EOF
	}
	return n, err
}

func (g *gzipBody) Close() error { return g.raw.Close() }

type lazyGzipBody struct {
	raw    io.ReadCloser
	body   io.ReadCloser
	err    error
	opened bool
}

func (l *lazyGzipBody) Read(p []byte) (int, error) {
	if !l.opened {
		l.opened = true
		reader, err := gzip.NewReader(l.raw)
		if err != nil {
			if errors.Is(err, io.EOF) {
				l.err = io.EOF
			} else {
				l.err = err
			}
		} else {
			l.body = &gzipBody{reader: reader, raw: l.raw}
		}
	}
	if l.err != nil {
		return 0, l.err
	}
	return l.body.Read(p)
}

func (l *lazyGzipBody) Close() error { return l.raw.Close() }

func decodeGzip(resp *http.Response) {
	encoding := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding")))
	if encoding != "gzip" && encoding != "x-gzip" {
		return
	}
	resp.Body = &lazyGzipBody{raw: resp.Body}
	resp.Header.Del("Content-Encoding")
	resp.Header.Del("Content-Length")
	resp.ContentLength = -1
}

// IsHTTP2Error reports HTTP/2 protocol level failures (ports errors.ts isHttp2Error).
func IsHTTP2Error(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	for _, marker := range []string{
		"http2:", "HTTP/2", "PROTOCOL_ERROR", "REFUSED_STREAM", "INTERNAL_ERROR",
		"GOAWAY", "stream error", "ERR_HTTP2",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

func isProxyConnectError(err error) bool {
	message := err.Error()
	if strings.Contains(message, "proxyconnect") || strings.Contains(message, "socks connect") {
		return true
	}
	var opErr *net.OpError
	return errors.As(err, &opErr) && opErr.Op == "dial"
}

// ClassifyError maps a transport error to the undici-style code the control plane
// categorizes (errors.ts isTransportError). Timeouts caused by the caller's own
// timers must be detected by the caller before calling this.
func ClassifyError(err error) (code string, message string) {
	message = redact(err.Error())
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		if dnsErr.IsNotFound {
			return "ENOTFOUND", message
		}
		return "EAI_AGAIN", message
	}
	if IsHTTP2Error(err) {
		return "ERR_HTTP2_STREAM_ERROR", message
	}
	lower := strings.ToLower(err.Error())
	switch {
	case strings.Contains(lower, "timeout awaiting response headers"):
		return "UND_ERR_HEADERS_TIMEOUT", message
	case strings.Contains(lower, "connection refused"):
		return "ECONNREFUSED", message
	case strings.Contains(lower, "connection reset"), strings.Contains(lower, "broken pipe"):
		return "ECONNRESET", message
	case strings.Contains(lower, "tls:"), strings.Contains(lower, "x509:"), strings.Contains(lower, "certificate"):
		return "EPROTO", message
	case errors.Is(err, io.ErrUnexpectedEOF), strings.Contains(lower, "unexpected eof"),
		strings.Contains(lower, "server closed"), errors.Is(err, io.EOF):
		return "UND_ERR_SOCKET", "other side closed: " + message
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		var opErr *net.OpError
		if errors.As(err, &opErr) && opErr.Op == "dial" {
			return "UND_ERR_CONNECT_TIMEOUT", message
		}
		return "ETIMEDOUT", message
	}
	return "UNKNOWN", message
}

// redact strips userinfo and query strings from URLs embedded in error text.
func redact(message string) string {
	fields := strings.Fields(message)
	for index, field := range fields {
		trimmed := strings.Trim(field, `"':,`)
		if !strings.Contains(trimmed, "://") {
			continue
		}
		parsed, err := url.Parse(trimmed)
		if err != nil {
			continue
		}
		parsed.User = nil
		parsed.RawQuery = ""
		fields[index] = strings.Replace(field, trimmed, parsed.String(), 1)
	}
	result := strings.Join(fields, " ")
	if len(result) > 1024 {
		result = result[:1024]
	}
	return result
}
