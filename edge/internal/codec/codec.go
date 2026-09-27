// Package codec decodes inbound request bodies by Content-Encoding.
//
// Ports decodeRequestBody from src/app/v1/_lib/proxy/request-body-codec.ts:
// a single supported layer (zstd, gzip, x-gzip, deflate with raw-deflate fallback,
// br) is decoded with an output size cap. Anything the control plane would reject
// or pass through untouched is reported as an error so the caller delegates the
// original bytes and the control plane produces its usual response.
package codec

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

var (
	ErrUnsupportedEncoding = errors.New("unsupported content-encoding")
	ErrTooManyLayers       = errors.New("too many content-encoding layers")
	ErrTooLarge            = errors.New("request body exceeds the size limit")
	ErrCorrupt             = errors.New("corrupt compressed request body")
)

// Result describes a decoded body.
type Result struct {
	Body     []byte
	Decoded  bool
	Encoding string
}

// ParseContentEncoding ports parseContentEncoding: lowercase, trimmed, identity removed.
func ParseContentEncoding(header string) []string {
	var tokens []string
	for _, token := range strings.Split(header, ",") {
		token = strings.ToLower(strings.TrimSpace(token))
		if token != "" && token != "identity" {
			tokens = append(tokens, token)
		}
	}
	return tokens
}

func readLimited(reader io.Reader, maxOutput int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, maxOutput+1))
	if err != nil {
		if errors.Is(err, zstd.ErrDecoderSizeExceeded) {
			return nil, ErrTooLarge
		}
		return nil, fmt.Errorf("%w: %w", ErrCorrupt, err)
	}
	if int64(len(data)) > maxOutput {
		return nil, ErrTooLarge
	}
	return data, nil
}

func decodeOne(input []byte, encoding string, maxOutput int64) ([]byte, error) {
	switch encoding {
	case "zstd":
		decoder, err := zstd.NewReader(bytes.NewReader(input), zstd.WithDecoderMaxMemory(uint64(maxOutput)+1))
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrCorrupt, err)
		}
		defer decoder.Close()
		return readLimited(decoder, maxOutput)
	case "gzip", "x-gzip":
		reader, err := gzip.NewReader(bytes.NewReader(input))
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrCorrupt, err)
		}
		defer reader.Close()
		return readLimited(reader, maxOutput)
	case "br":
		return readLimited(brotli.NewReader(bytes.NewReader(input)), maxOutput)
	case "deflate":
		// HTTP deflate is nominally zlib-wrapped, but many clients send raw deflate.
		if reader, err := zlib.NewReader(bytes.NewReader(input)); err == nil {
			data, readErr := readLimited(reader, maxOutput)
			_ = reader.Close()
			if readErr == nil || errors.Is(readErr, ErrTooLarge) {
				return data, readErr
			}
		}
		raw := flate.NewReader(bytes.NewReader(input))
		defer raw.Close()
		return readLimited(raw, maxOutput)
	default:
		return nil, ErrUnsupportedEncoding
	}
}

// Decode returns the plaintext body for a Content-Encoding header value.
func Decode(input []byte, contentEncoding string, maxOutput, maxCompressed int64) (Result, error) {
	encodings := ParseContentEncoding(contentEncoding)
	if len(encodings) == 0 || len(input) == 0 {
		return Result{Body: input}, nil
	}
	if len(encodings) > 1 {
		return Result{}, ErrTooManyLayers
	}
	encoding := encodings[0]
	switch encoding {
	case "zstd", "gzip", "x-gzip", "deflate", "br":
	default:
		return Result{}, ErrUnsupportedEncoding
	}
	if int64(len(input)) > maxCompressed {
		return Result{}, ErrTooLarge
	}
	body, err := decodeOne(input, encoding, maxOutput)
	if err != nil {
		return Result{}, err
	}
	return Result{Body: body, Decoded: true, Encoding: encoding}, nil
}
