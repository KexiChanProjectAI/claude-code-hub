package upstream

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ding113/claude-code-hub/edge/internal/contract"
)

func step(url string, headers ...contract.HeaderPair) *contract.ExecutionStep {
	return &contract.ExecutionStep{
		Method:   "POST",
		URL:      url,
		Headers:  headers,
		Timeouts: contract.StepTimeouts{ConnectMs: 2000, HeadersMs: 5000},
	}
}

func TestDoSendsPlannedHeadersAndBody(t *testing.T) {
	var gotHost, gotAuth, gotLength, gotBody string
	var rawHeaderNames []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		gotAuth = r.Header.Get("Authorization")
		gotLength = r.Header.Get("Content-Length")
		for name := range r.Header {
			rawHeaderNames = append(rawHeaderNames, name)
		}
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.WriteHeader(201)
	}))
	defer srv.Close()

	client := NewClient()
	dispatched := false
	result, err := client.Do(context.Background(), step(srv.URL+"/v1/messages?beta=true",
		contract.HeaderPair{"host", "api.example.com"},
		contract.HeaderPair{"Authorization", "Bearer k"},
		contract.HeaderPair{"content-length", "999"},
		contract.HeaderPair{"transfer-encoding", "chunked"},
		contract.HeaderPair{"anthropic-version", "2023-06-01"},
	), []byte(`{"a":1}`), func() { dispatched = true })
	if err != nil {
		t.Fatal(err)
	}
	defer result.Response.Body.Close()
	if !dispatched || result.Response.StatusCode != 201 {
		t.Fatalf("unexpected result %+v", result)
	}
	if gotHost != "api.example.com" || gotAuth != "Bearer k" || gotBody != `{"a":1}` || gotLength != "7" {
		t.Fatalf("host=%q auth=%q body=%q length=%q", gotHost, gotAuth, gotBody, gotLength)
	}
}

func TestDoDecodesGzipResponses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		_, _ = zw.Write([]byte("hello gzip"))
		_ = zw.Close()
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(buf.Bytes())
	}))
	defer srv.Close()
	result, err := NewClient().Do(context.Background(), step(srv.URL), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(result.Response.Body)
	if string(body) != "hello gzip" || result.Response.Header.Get("Content-Encoding") != "" {
		t.Fatalf("body=%q headers=%v", body, result.Response.Header)
	}
}

func TestDoDoesNotFollowRedirects(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	}))
	defer srv.Close()
	result, err := NewClient().Do(context.Background(), step(srv.URL), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Response.StatusCode != http.StatusFound {
		t.Fatalf("status %d", result.Response.StatusCode)
	}
}

func TestProxyFallbackToDirect(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("direct"))
	}))
	defer srv.Close()
	listener, _ := net.Listen("tcp", "127.0.0.1:0")
	deadProxy := "http://" + listener.Addr().String()
	_ = listener.Close()

	s := step(srv.URL)
	s.Transport.ProxyURL = &deadProxy
	s.Transport.ProxyFallbackToDirect = true
	result, err := NewClient().Do(context.Background(), s, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(result.Response.Body)
	if !result.ProxyFallback || string(body) != "direct" {
		t.Fatalf("fallback=%v body=%q", result.ProxyFallback, body)
	}

	s.Transport.ProxyFallbackToDirect = false
	if _, err := NewClient().Do(context.Background(), s, nil, nil); err == nil {
		t.Fatal("expected proxy failure without fallback")
	}
}

func TestClassifyError(t *testing.T) {
	listener, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := listener.Addr().String()
	_ = listener.Close()
	_, err := NewClient().Do(context.Background(), step("http://"+addr), nil, nil)
	if code, _ := ClassifyError(err); code != "ECONNREFUSED" {
		t.Fatalf("refused: %s (%v)", code, err)
	}

	cases := map[string]error{
		"ENOTFOUND":               &net.DNSError{Err: "no such host", Name: "x.invalid", IsNotFound: true},
		"EAI_AGAIN":               &net.DNSError{Err: "temporary", Name: "x", IsTemporary: true},
		"UND_ERR_HEADERS_TIMEOUT": errors.New("net/http: timeout awaiting response headers"),
		"ECONNRESET":              errors.New("read tcp: connection reset by peer"),
		"UND_ERR_SOCKET":          io.ErrUnexpectedEOF,
		"ERR_HTTP2_STREAM_ERROR":  errors.New("http2: stream error: PROTOCOL_ERROR"),
		"EPROTO":                  errors.New("tls: handshake failure"),
		"UNKNOWN":                 errors.New("something else"),
	}
	for want, input := range cases {
		if got, _ := ClassifyError(input); got != want {
			t.Errorf("ClassifyError(%v) = %s, want %s", input, got, want)
		}
	}
}

func TestHeadersTimeoutAndRedaction(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
	}))
	defer srv.Close()
	s := step(srv.URL + "/path?key=secret")
	s.Timeouts.HeadersMs = 50
	_, err := NewClient().Do(context.Background(), s, nil, nil)
	code, message := ClassifyError(err)
	if code != "UND_ERR_HEADERS_TIMEOUT" {
		t.Fatalf("code %s (%v)", code, err)
	}
	if strings.Contains(message, "secret") {
		t.Fatalf("message not redacted: %s", message)
	}
}
