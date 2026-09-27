package fixer

import (
	"bytes"
	"testing"
)

type streamFixtureCfg struct {
	FixEncoding      bool   `json:"fixEncoding"`
	FixSseFormat     bool   `json:"fixSseFormat"`
	FixTruncatedJSON bool   `json:"fixTruncatedJson"`
	MaxJSONDepth     int    `json:"maxJsonDepth"`
	MaxFixSize       int    `json:"maxFixSize"`
	Format           string `json:"format"`
}

type streamCase struct {
	Name              string           `json:"name"`
	FullInputB64      string           `json:"fullInputB64"`
	SplitPattern      string           `json:"splitPattern"`
	ChunksB64         []string         `json:"chunksB64"`
	Cfg               streamFixtureCfg `json:"cfg"`
	ExpectedOutputB64 string           `json:"expectedOutputB64"`
}

func TestStreamFixerFixtures(t *testing.T) {
	var cases []streamCase
	loadFixture(t, "stream.json", &cases)

	for _, c := range cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			cfg := Config{
				FixEncoding:      c.Cfg.FixEncoding,
				FixSseFormat:     c.Cfg.FixSseFormat,
				FixTruncatedJSON: c.Cfg.FixTruncatedJSON,
				MaxJSONDepth:     c.Cfg.MaxJSONDepth,
				MaxFixSize:       c.Cfg.MaxFixSize,
				Format:           c.Cfg.Format,
			}

			sf := NewStreamFixer(cfg)
			var out []byte
			for _, chunkB64 := range c.ChunksB64 {
				chunk := mustB64(t, chunkB64)
				out = append(out, sf.Write(chunk)...)
			}
			out = append(out, sf.Flush()...)

			expected := mustB64(t, c.ExpectedOutputB64)
			if !bytes.Equal(out, expected) {
				t.Errorf("output = %q, want %q", out, expected)
			}

			audit := sf.Audit()
			var totalIn int
			for _, chunkB64 := range c.ChunksB64 {
				totalIn += len(mustB64(t, chunkB64))
			}
			if audit.TotalBytesProcessed != int64(totalIn) {
				t.Errorf("TotalBytesProcessed = %d, want %d", audit.TotalBytesProcessed, totalIn)
			}
			if audit.ProcessingTimeMs < 0 {
				t.Errorf("ProcessingTimeMs = %d, want >= 0", audit.ProcessingTimeMs)
			}
			if len(audit.FixersApplied) != 3 {
				t.Fatalf("FixersApplied len = %d, want 3", len(audit.FixersApplied))
			}
			names := []string{"encoding", "sse", "json"}
			for i, n := range names {
				if audit.FixersApplied[i].Fixer != n {
					t.Errorf("FixersApplied[%d].Fixer = %q, want %q", i, audit.FixersApplied[i].Fixer, n)
				}
			}
		})
	}
}

// TestStreamFixerSplitInvariance is a Go-only test (no TS fixture): feeding
// the same overall bytes through the stream pipeline in different chunk
// splits must produce identical final output and audit.
func TestStreamFixerSplitInvariance(t *testing.T) {
	full := []byte(
		"event: message_start\ndata: {\"type\":\"message_start\"}\n\n" +
			"event: content_block_delta\ndata:{\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hello world\"}}\n\n" +
			"event: message_stop\ndata: {\"type\":\"message_stop\"\n\n", // intentionally truncated JSON
	)

	cfg := Config{
		FixEncoding:      true,
		FixSseFormat:     true,
		FixTruncatedJSON: true,
		MaxJSONDepth:     200,
		MaxFixSize:       1024 * 1024,
	}

	splits := [][]int{
		{len(full)},         // single chunk
		splitEvery(full, 1), // byte at a time
		splitEvery(full, 3),
		splitEvery(full, 17),
		{10, 25, 40, len(full)},
	}

	var referenceOut []byte
	var referenceAudit []string

	for i, sizes := range splits {
		sf := NewStreamFixer(cfg)
		var out []byte
		offset := 0
		for _, size := range sizes {
			if offset >= len(full) {
				break
			}
			end := offset + size
			if end > len(full) {
				end = len(full)
			}
			out = append(out, sf.Write(full[offset:end])...)
			offset = end
		}
		out = append(out, sf.Flush()...)

		audit := sf.Audit()
		auditSig := []string{}
		for _, fa := range audit.FixersApplied {
			details := ""
			if fa.Details != nil {
				details = *fa.Details
			}
			auditSig = append(auditSig, fa.Fixer+"="+boolStr(fa.Applied)+":"+details)
		}

		if i == 0 {
			referenceOut = out
			referenceAudit = auditSig
			continue
		}

		if !bytes.Equal(out, referenceOut) {
			t.Errorf("split %d: output differs from reference.\ngot:  %q\nwant: %q", i, out, referenceOut)
		}
		if len(auditSig) != len(referenceAudit) {
			t.Fatalf("split %d: audit signature length differs", i)
		}
		for j := range auditSig {
			if auditSig[j] != referenceAudit[j] {
				t.Errorf("split %d: audit[%d] = %q, want %q", i, j, auditSig[j], referenceAudit[j])
			}
		}
	}
}

func splitEvery(data []byte, n int) []int {
	var out []int
	for i := 0; i < len(data); i += n {
		out = append(out, n)
	}
	return out
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
