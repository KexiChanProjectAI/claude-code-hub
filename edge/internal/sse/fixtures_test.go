package sse

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

type frameJSON struct {
	EventName *string `json:"eventName"`
	Data      string  `json:"data"`
}

type sseFrameCaseJSON struct {
	Name               string      `json:"name"`
	Chunks             []string    `json:"chunks"`
	Binary             bool        `json:"binary"`
	MaxBufferedBytes   *int        `json:"maxBufferedBytes"`
	ExemptionEventName *string     `json:"exemptionEventName"`
	ExpectedFrames     []frameJSON `json:"expectedFrames"`
	ExpectedError      bool        `json:"expectedError"`
}

// chunkBytes decodes one fixture chunk to raw wire bytes: base64 when the
// case is marked binary (required for mid-UTF-8-codepoint splits, see the
// generator's doc comment on SseFrameCase.binary), plain UTF-8 otherwise.
func (c sseFrameCaseJSON) chunkBytes(chunk string) []byte {
	if !c.Binary {
		return []byte(chunk)
	}
	b, err := base64.StdEncoding.DecodeString(chunk)
	if err != nil {
		panic("fixture: invalid base64 chunk: " + err.Error())
	}
	return b
}

func loadFixture(t *testing.T, name string, v any) {
	t.Helper()
	path := "../../../tests/fixtures/edge/gate/" + name
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s: %v", path, err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("parse fixture %s: %v", path, err)
	}
}

func TestSseFramesFixtures(t *testing.T) {
	var cases []sseFrameCaseJSON
	loadFixture(t, "sse-frames.json", &cases)
	if len(cases) == 0 {
		t.Fatal("no fixture cases loaded")
	}

	for _, c := range cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			maxBuffered := 0
			if c.MaxBufferedBytes != nil {
				maxBuffered = *c.MaxBufferedBytes
			}
			var exemption func(*string) bool
			if c.ExemptionEventName != nil {
				want := *c.ExemptionEventName
				exemption = func(pending *string) bool {
					return pending != nil && *pending == want
				}
			}
			p := NewParser(maxBuffered, exemption)

			var frames []Frame
			var gotErr error
			for _, chunk := range c.Chunks {
				fs, err := p.Push(c.chunkBytes(chunk))
				if err != nil {
					gotErr = err
					break
				}
				frames = append(frames, fs...)
			}
			if gotErr == nil {
				fs, err := p.Finish()
				if err != nil {
					gotErr = err
				} else {
					frames = append(frames, fs...)
				}
			}

			if c.ExpectedError {
				if gotErr == nil {
					t.Fatalf("expected buffer-limit error, got frames=%v", frames)
				}
				return
			}
			if gotErr != nil {
				t.Fatalf("unexpected error: %v", gotErr)
			}
			assertFramesEqual(t, c.ExpectedFrames, frames)
		})
	}
}

func assertFramesEqual(t *testing.T, expected []frameJSON, actual []Frame) {
	t.Helper()
	if len(expected) != len(actual) {
		t.Fatalf("frame count mismatch: want %d, got %d\nwant=%+v\ngot=%+v", len(expected), len(actual), expected, actual)
	}
	for i := range expected {
		we, wd := expected[i].EventName, expected[i].Data
		ge, gd := actual[i].EventName, actual[i].Data
		if (we == nil) != (ge == nil) || (we != nil && ge != nil && *we != *ge) {
			t.Fatalf("frame[%d] eventName mismatch: want %v, got %v", i, ptrStr(we), ptrStr(ge))
		}
		if wd != gd {
			t.Fatalf("frame[%d] data mismatch: want %q, got %q", i, wd, gd)
		}
	}
}

func ptrStr(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

// TestSplitInvariance is a Go-only companion to the fixtures: it verifies
// that splitting a representative body at every possible byte offset
// produces identical frames, exercising the CR/LF/UTF-8-boundary handling
// beyond what the fixture's fixed split points cover.
func TestSplitInvariance(t *testing.T) {
	body := "event: content_block_delta\r\n" +
		`data: {"type":"content_block_delta","delta":{"text":"你好"}}` + "\r\n\r\n" +
		": comment\n" +
		"data: part1\ndata: part2\n\n" +
		"event: message_stop\ndata: {}\n\n" +
		"data: [DONE]\n\n"
	bytes := []byte(body)

	expected, err := ParseBody(bytes)
	if err != nil {
		t.Fatalf("ParseBody: %v", err)
	}

	for split := 1; split < len(bytes); split++ {
		p := NewParser(0, nil)
		var frames []Frame
		fs, err := p.Push(bytes[:split])
		if err != nil {
			t.Fatalf("split=%d push1: %v", split, err)
		}
		frames = append(frames, fs...)
		fs, err = p.Push(bytes[split:])
		if err != nil {
			t.Fatalf("split=%d push2: %v", split, err)
		}
		frames = append(frames, fs...)
		fs, err = p.Finish()
		if err != nil {
			t.Fatalf("split=%d finish: %v", split, err)
		}
		frames = append(frames, fs...)

		if len(frames) != len(expected) {
			t.Fatalf("split=%d: frame count mismatch: want %d got %d", split, len(expected), len(frames))
		}
		for i := range expected {
			if !eqPtr(expected[i].EventName, frames[i].EventName) || expected[i].Data != frames[i].Data {
				t.Fatalf("split=%d frame[%d] mismatch: want %+v got %+v", split, i, expected[i], frames[i])
			}
		}
	}
}

func eqPtr(a, b *string) bool {
	if (a == nil) != (b == nil) {
		return false
	}
	return a == nil || *a == *b
}
