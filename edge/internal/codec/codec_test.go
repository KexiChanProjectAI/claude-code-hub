package codec

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"errors"
	"testing"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

var payload = []byte(`{"model":"claude","messages":[{"role":"user","content":"hello"}]}`)

func compress(t *testing.T, encoding string, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	switch encoding {
	case "gzip":
		w := gzip.NewWriter(&buf)
		_, _ = w.Write(data)
		_ = w.Close()
	case "deflate":
		w := zlib.NewWriter(&buf)
		_, _ = w.Write(data)
		_ = w.Close()
	case "raw-deflate":
		w, _ := flate.NewWriter(&buf, flate.DefaultCompression)
		_, _ = w.Write(data)
		_ = w.Close()
	case "br":
		w := brotli.NewWriter(&buf)
		_, _ = w.Write(data)
		_ = w.Close()
	case "zstd":
		w, _ := zstd.NewWriter(&buf)
		_, _ = w.Write(data)
		_ = w.Close()
	}
	return buf.Bytes()
}

func TestDecodeSupportedEncodings(t *testing.T) {
	for _, tc := range []struct{ header, kind string }{
		{"gzip", "gzip"},
		{"x-gzip", "gzip"},
		{" GZIP ", "gzip"},
		{"deflate", "deflate"},
		{"deflate", "raw-deflate"},
		{"br", "br"},
		{"zstd", "zstd"},
		{"identity, zstd", "zstd"},
	} {
		result, err := Decode(compress(t, tc.kind, payload), tc.header, 1<<20, 1<<20)
		if err != nil {
			t.Fatalf("%s/%s: %v", tc.header, tc.kind, err)
		}
		if !result.Decoded || !bytes.Equal(result.Body, payload) {
			t.Fatalf("%s/%s: unexpected result %+v", tc.header, tc.kind, result)
		}
	}
}

func TestDecodePassthrough(t *testing.T) {
	for _, header := range []string{"", "identity", " , "} {
		result, err := Decode(payload, header, 10, 10)
		if err != nil || result.Decoded || !bytes.Equal(result.Body, payload) {
			t.Fatalf("header %q: %+v %v", header, result, err)
		}
	}
	empty, err := Decode(nil, "gzip, br", 10, 10)
	if err != nil || empty.Decoded {
		t.Fatalf("empty body should pass through: %+v %v", empty, err)
	}
}

func TestDecodeErrors(t *testing.T) {
	cases := []struct {
		name     string
		input    []byte
		header   string
		maxOut   int64
		maxIn    int64
		expected error
	}{
		{"layers", []byte("x"), "gzip, br", 100, 100, ErrTooManyLayers},
		{"unsupported", []byte("x"), "compress", 100, 100, ErrUnsupportedEncoding},
		{"compressed too large", compress(t, "gzip", payload), "gzip", 1000, 5, ErrTooLarge},
		{"output too large", compress(t, "gzip", payload), "gzip", 10, 1000, ErrTooLarge},
		{"zstd bomb", compress(t, "zstd", bytes.Repeat([]byte("a"), 1<<16)), "zstd", 1024, 1 << 20, ErrTooLarge},
		{"corrupt gzip", []byte("not gzip"), "gzip", 100, 100, ErrCorrupt},
		{"corrupt deflate", []byte{0xff, 0xff, 0xff}, "deflate", 100, 100, ErrCorrupt},
	}
	for _, tc := range cases {
		_, err := Decode(tc.input, tc.header, tc.maxOut, tc.maxIn)
		if !errors.Is(err, tc.expected) {
			t.Errorf("%s: got %v, want %v", tc.name, err, tc.expected)
		}
	}
}
