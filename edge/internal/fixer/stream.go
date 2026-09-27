package fixer

import (
	"time"

	"github.com/ding113/claude-code-hub/edge/internal/contract"
)

// chunkBuffer ports the TS ChunkBuffer class: it accumulates chunks and
// tracks the index up to which the buffered bytes end on a complete line
// (LF, or CRLF split across chunk boundaries).
type chunkBuffer struct {
	buf            []byte
	pendingCR      bool
	processableEnd int
}

func (b *chunkBuffer) length() int { return len(b.buf) }

func (b *chunkBuffer) push(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	prevTotal := len(b.buf)
	b.buf = append(b.buf, chunk...)

	if b.pendingCR {
		if chunk[0] == lfByte {
			b.processableEnd = prevTotal + 1
		} else {
			b.processableEnd = prevTotal
		}
		b.pendingCR = false
	}

	for i := 0; i < len(chunk); i++ {
		c := chunk[i]
		if c == lfByte {
			b.processableEnd = prevTotal + i + 1
			continue
		}
		if c != crByte {
			continue
		}
		if i+1 < len(chunk) {
			if chunk[i+1] != lfByte {
				b.processableEnd = prevTotal + i + 1
			}
			continue
		}
		b.pendingCR = true
	}
}

func (b *chunkBuffer) findProcessableEnd() int {
	if len(b.buf) == 0 {
		return 0
	}
	if b.pendingCR {
		return 0
	}
	return b.processableEnd
}

func (b *chunkBuffer) take(size int) []byte {
	if size <= 0 {
		return nil
	}
	if size > len(b.buf) {
		panic("chunkBuffer.take size exceeds buffered length")
	}
	out := make([]byte, size)
	copy(out, b.buf[:size])
	b.buf = b.buf[size:]
	b.processableEnd -= size
	if b.processableEnd < 0 {
		b.processableEnd = 0
	}
	return out
}

func (b *chunkBuffer) drain() []byte {
	out := b.take(len(b.buf))
	b.clear()
	return out
}

func (b *chunkBuffer) clear() {
	b.buf = nil
	b.pendingCR = false
	b.processableEnd = 0
}

// StreamFixer ports ResponseFixer.processStream's TransformStream pipeline
// (minus filterInertResponsesChatCompletionChunks and
// normalizeResponseOutput, which are Responses-API-only / out of scope).
type StreamFixer struct {
	cfg Config

	encodingFixer *EncodingFixer
	sseFixer      *SseFixer
	jsonFixer     *JsonFixer

	buf         chunkBuffer
	passthrough bool

	totalBytesProcessed int64

	appliedEncoding bool
	encodingDetails string
	appliedSse      bool
	sseDetails      string
	appliedJSON     bool
	jsonDetails     string

	start time.Time
}

func NewStreamFixer(cfg Config) *StreamFixer {
	f := &StreamFixer{cfg: cfg, start: time.Now()}
	if cfg.FixEncoding {
		f.encodingFixer = NewEncodingFixer()
	}
	if cfg.FixSseFormat {
		f.sseFixer = NewSseFixer()
	}
	if cfg.FixTruncatedJSON {
		f.jsonFixer = NewJsonFixer(cfg.MaxJSONDepth, cfg.MaxFixSize)
	}
	return f
}

// Write mirrors the transform() step: bytes ready for the client (may be nil/empty).
func (f *StreamFixer) Write(chunk []byte) []byte {
	f.totalBytesProcessed += int64(len(chunk))

	if f.passthrough {
		return chunk
	}

	if f.buf.length()+len(chunk) > f.cfg.MaxFixSize {
		f.passthrough = true
		out := f.buf.drain()
		out = append(out, chunk...)
		return out
	}

	f.buf.push(chunk)

	end := f.buf.findProcessableEnd()
	if end <= 0 {
		return nil
	}

	return f.applyStreamFixers(f.buf.take(end))
}

// Flush mirrors the flush() step: call once at upstream EOF.
func (f *StreamFixer) Flush() []byte {
	if f.buf.length() > 0 {
		return f.applyStreamFixers(f.buf.drain())
	}
	return nil
}

func (f *StreamFixer) applyStreamFixers(input []byte) []byte {
	data := input

	if f.encodingFixer != nil {
		res := f.encodingFixer.Fix(data)
		if res.Applied {
			f.appliedEncoding = true
			if f.encodingDetails == "" {
				f.encodingDetails = res.Details
			}
			data = res.Data
		}
	}

	if f.sseFixer != nil {
		res := f.sseFixer.Fix(data)
		if res.Applied {
			f.appliedSse = true
			if f.sseDetails == "" {
				f.sseDetails = res.Details
			}
			data = res.Data
		}
	}

	if f.jsonFixer != nil {
		fixed, applied, details := fixSseJSONLines(data, f.jsonFixer)
		if applied {
			f.appliedJSON = true
			if f.jsonDetails == "" {
				f.jsonDetails = details
			}
			data = fixed
		}
	}

	return data
}

func detailsPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Audit mirrors buildFixersApplied(applied, includeSse=true) plus hit /
// totalBytesProcessed / processingTimeMs bookkeeping.
func (f *StreamFixer) Audit() contract.FixerAudit {
	hit := f.appliedEncoding || f.appliedSse || f.appliedJSON
	fa := []contract.FixerApplied{
		{Fixer: "encoding", Applied: f.appliedEncoding, Details: detailsPtr(f.encodingDetails)},
		{Fixer: "sse", Applied: f.appliedSse, Details: detailsPtr(f.sseDetails)},
		{Fixer: "json", Applied: f.appliedJSON, Details: detailsPtr(f.jsonDetails)},
	}
	ms := time.Since(f.start).Milliseconds()
	if ms < 0 {
		ms = 0
	}
	return contract.FixerAudit{
		Hit:                 hit,
		FixersApplied:       fa,
		TotalBytesProcessed: f.totalBytesProcessed,
		ProcessingTimeMs:    ms,
	}
}

// fixSseJSONLines ports ResponseFixer.fixSseJsonLines: applies the JSON
// fixer only to (LF-terminated) lines that look like an SSE `data:` line.
func fixSseJSONLines(data []byte, jsonFixer *JsonFixer) (out []byte, applied bool, details string) {
	var chunks [][]byte
	cursor := 0
	lineStart := 0

	for i := 0; i < len(data); i++ {
		if data[i] != lfByte {
			continue
		}
		line := data[lineStart:i]
		fixedLine, lineApplied := fixMaybeDataJSONLine(line, jsonFixer)

		if !lineApplied {
			if chunks != nil {
				chunks = append(chunks, data[cursor:i+1])
				cursor = i + 1
			}
			lineStart = i + 1
			continue
		}

		applied = true
		if chunks == nil {
			chunks = [][]byte{}
		}
		if cursor < lineStart {
			chunks = append(chunks, data[cursor:lineStart])
		}
		chunks = append(chunks, fixedLine)
		chunks = append(chunks, []byte{lfByte})
		cursor = i + 1
		lineStart = i + 1
	}

	if lineStart < len(data) {
		line := data[lineStart:]
		fixedLine, lineApplied := fixMaybeDataJSONLine(line, jsonFixer)

		if !lineApplied {
			if chunks != nil {
				chunks = append(chunks, data[cursor:])
			}
		} else {
			applied = true
			if chunks == nil {
				chunks = [][]byte{}
			}
			if cursor < lineStart {
				chunks = append(chunks, data[cursor:lineStart])
			}
			chunks = append(chunks, fixedLine)
		}
	}

	if chunks == nil {
		return data, false, ""
	}
	return concatBytes(chunks), applied, ""
}

var sseDataPrefixWithSpace = []byte("data: ")

func fixMaybeDataJSONLine(line []byte, jsonFixer *JsonFixer) ([]byte, bool) {
	prefix := dataColon
	if len(line) < len(prefix) {
		return line, false
	}
	if !startsWithBytes(line, prefix) {
		return line, false
	}

	payloadStart := len(prefix)
	if payloadStart < len(line) && line[payloadStart] == 0x20 {
		payloadStart++
	}

	payload := line[payloadStart:]
	res := jsonFixer.Fix(payload)
	if !res.Applied {
		return line, false
	}

	out := make([]byte, 0, len(sseDataPrefixWithSpace)+len(res.Data))
	out = append(out, sseDataPrefixWithSpace...)
	out = append(out, res.Data...)
	return out, true
}

// FixNonStream mirrors ResponseFixer.processNonStream's fixer sequence
// (encoding -> json, applied once to the whole body).
func FixNonStream(body []byte, cfg Config) ([]byte, contract.FixerAudit) {
	start := time.Now()

	data := body
	appliedEncoding, encodingDetails := false, ""
	appliedJSON, jsonDetails := false, ""

	if cfg.FixEncoding {
		res := NewEncodingFixer().Fix(data)
		if res.Applied {
			appliedEncoding = true
			encodingDetails = res.Details
			data = res.Data
		}
	}

	if cfg.FixTruncatedJSON {
		res := NewJsonFixer(cfg.MaxJSONDepth, cfg.MaxFixSize).Fix(data)
		if res.Applied {
			appliedJSON = true
			jsonDetails = res.Details
			data = res.Data
		}
	}

	hit := appliedEncoding || appliedJSON
	fa := []contract.FixerApplied{
		{Fixer: "encoding", Applied: appliedEncoding, Details: detailsPtr(encodingDetails)},
		{Fixer: "json", Applied: appliedJSON, Details: detailsPtr(jsonDetails)},
	}
	ms := time.Since(start).Milliseconds()
	if ms < 0 {
		ms = 0
	}

	return data, contract.FixerAudit{
		Hit:                 hit,
		FixersApplied:       fa,
		TotalBytesProcessed: int64(len(body)),
		ProcessingTimeMs:    ms,
	}
}
