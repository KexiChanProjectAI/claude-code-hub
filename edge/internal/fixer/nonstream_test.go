package fixer

import (
	"bytes"
	"encoding/json"
	"testing"
)

type nonStreamCfg struct {
	FixEncoding      bool `json:"fixEncoding"`
	FixTruncatedJSON bool `json:"fixTruncatedJson"`
	MaxJSONDepth     int  `json:"maxJsonDepth"`
	MaxFixSize       int  `json:"maxFixSize"`
}

type nonStreamCase struct {
	Name                          string       `json:"name"`
	InputB64                      string       `json:"inputB64"`
	Cfg                           nonStreamCfg `json:"cfg"`
	ExpectedEncodingApplied       bool         `json:"expectedEncodingApplied"`
	ExpectedJSONApplied           bool         `json:"expectedJsonApplied"`
	ExpectedHit                   bool         `json:"expectedHit"`
	ExpectedDataParsesAsJSON      bool         `json:"expectedDataParsesAsJson"`
	ExpectedDataB64ForNonJSONCase *string      `json:"expectedDataB64ForNonJsonCase"`
}

func TestFixNonStreamFixtures(t *testing.T) {
	var cases []nonStreamCase
	loadFixture(t, "nonstream.json", &cases)

	for _, c := range cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			input := mustB64(t, c.InputB64)
			cfg := Config{
				FixEncoding:      c.Cfg.FixEncoding,
				FixTruncatedJSON: c.Cfg.FixTruncatedJSON,
				MaxJSONDepth:     c.Cfg.MaxJSONDepth,
				MaxFixSize:       c.Cfg.MaxFixSize,
			}

			data, audit := FixNonStream(input, cfg)

			if audit.TotalBytesProcessed != int64(len(input)) {
				t.Errorf("TotalBytesProcessed = %d, want %d", audit.TotalBytesProcessed, len(input))
			}
			if audit.ProcessingTimeMs < 0 {
				t.Errorf("ProcessingTimeMs = %d, want >= 0", audit.ProcessingTimeMs)
			}
			if len(audit.FixersApplied) != 2 {
				t.Fatalf("FixersApplied len = %d, want 2 (encoding, json)", len(audit.FixersApplied))
			}
			if audit.FixersApplied[0].Fixer != "encoding" || audit.FixersApplied[1].Fixer != "json" {
				t.Errorf("FixersApplied order = %v", audit.FixersApplied)
			}
			if audit.FixersApplied[0].Applied != c.ExpectedEncodingApplied {
				t.Errorf("encoding.Applied = %v, want %v", audit.FixersApplied[0].Applied, c.ExpectedEncodingApplied)
			}
			if audit.FixersApplied[1].Applied != c.ExpectedJSONApplied {
				t.Errorf("json.Applied = %v, want %v", audit.FixersApplied[1].Applied, c.ExpectedJSONApplied)
			}
			if audit.Hit != c.ExpectedHit {
				t.Errorf("Hit = %v, want %v", audit.Hit, c.ExpectedHit)
			}

			if c.ExpectedDataParsesAsJSON {
				if !json.Valid(data) {
					t.Errorf("output data is not valid JSON: %s", data)
				}
			} else if c.ExpectedDataB64ForNonJSONCase != nil {
				want := mustB64(t, *c.ExpectedDataB64ForNonJSONCase)
				if !bytes.Equal(data, want) {
					t.Errorf("Data = %q, want %q", data, want)
				}
			}
		})
	}
}
