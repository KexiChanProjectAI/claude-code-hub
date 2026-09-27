package capture

import "testing"

type compactCase struct {
	Name               string `json:"name"`
	MaxBytes           int    `json:"maxBytes"`
	FullSseB64         string `json:"fullSseB64"`
	ExpectedText       string `json:"expectedText"`
	ExpectedTruncated  bool   `json:"expectedTruncated"`
	ExpectedEventCount int    `json:"expectedEventCount"`
}

func TestCompactCaptureFixtures(t *testing.T) {
	var cases []compactCase
	loadFixture(t, "compact.json", &cases)

	for _, c := range cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			full := mustB64(t, c.FullSseB64)

			cc := NewCompactCapture(c.MaxBytes)
			cc.Observe(full)
			text, truncated, eventCount := cc.Result()

			if text != c.ExpectedText {
				t.Errorf("text =\n%q\nwant:\n%q", text, c.ExpectedText)
			}
			if truncated != c.ExpectedTruncated {
				t.Errorf("truncated = %v, want %v", truncated, c.ExpectedTruncated)
			}
			if eventCount != c.ExpectedEventCount {
				t.Errorf("eventCount = %d, want %d", eventCount, c.ExpectedEventCount)
			}
		})
	}
}

// TestCompactCaptureSplitInvariance is a Go-only test (no TS fixture):
// feeding the same overall bytes through CompactCapture in different chunk
// splits must produce identical Result().
func TestCompactCaptureSplitInvariance(t *testing.T) {
	full := []byte(
		"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-x\"}}\n\n" +
			"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"signature_delta\",\"signature\":\"abc\"}}\n\n" +
			"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":5}}\n\n" +
			"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
	)

	splitPatterns := [][]int{
		{len(full)},
		splitEvery(full, 1),
		splitEvery(full, 5),
		splitEvery(full, 23),
	}

	var refText string
	var refTruncated bool
	var refCount int

	for i, sizes := range splitPatterns {
		cc := NewCompactCapture(64 * 1024)
		offset := 0
		for _, size := range sizes {
			if offset >= len(full) {
				break
			}
			end := offset + size
			if end > len(full) {
				end = len(full)
			}
			cc.Observe(full[offset:end])
			offset = end
		}
		text, truncated, count := cc.Result()
		if i == 0 {
			refText, refTruncated, refCount = text, truncated, count
			continue
		}
		if text != refText {
			t.Errorf("split %d: text differs.\ngot:  %q\nwant: %q", i, text, refText)
		}
		if truncated != refTruncated {
			t.Errorf("split %d: truncated = %v, want %v", i, truncated, refTruncated)
		}
		if count != refCount {
			t.Errorf("split %d: eventCount = %d, want %d", i, count, refCount)
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
