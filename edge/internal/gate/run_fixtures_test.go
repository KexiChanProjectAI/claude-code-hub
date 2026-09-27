package gate

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"
)

type gateCaseJSON struct {
	Name     string   `json:"name"`
	Family   string   `json:"family"`
	Chunks   []string `json:"chunks"`
	EventCap int      `json:"eventCap"`
	ByteCap  int      `json:"byteCap"`
	Expected struct {
		Committed             bool   `json:"committed"`
		Reason                string `json:"reason"`
		FramesSeen            int    `json:"framesSeen"`
		PrefixBytes           int    `json:"prefixBytes"`
		ReaderDone            bool   `json:"readerDone"`
		TerminalBeforeContent bool   `json:"terminalBeforeContent"`
		EchoExcludedBytes     int    `json:"echoExcludedBytes"`
		CommitMarker          *struct {
			FrameIndex        int     `json:"frameIndex"`
			ChunkIndex        int     `json:"chunkIndex"`
			EventName         *string `json:"eventName"`
			BufferedBytes     int     `json:"bufferedBytes"`
			EchoExcludedBytes int     `json:"echoExcludedBytes"`
		} `json:"commitMarker"`
	} `json:"expected"`
}

// chunkedReader replays a fixed sequence of byte chunks, one per Read call,
// then returns io.EOF, mirroring the fixture's ReadableStream-per-chunk
// producer.
type chunkedReader struct {
	chunks [][]byte
	idx    int
}

func newChunkedReader(chunks []string) *chunkedReader {
	cr := &chunkedReader{}
	for _, c := range chunks {
		cr.chunks = append(cr.chunks, []byte(c))
	}
	return cr
}

func (r *chunkedReader) Read(p []byte) (int, error) {
	if r.idx >= len(r.chunks) {
		return 0, io.EOF
	}
	chunk := r.chunks[r.idx]
	r.idx++
	n := copy(p, chunk)
	if n < len(chunk) {
		// Should not happen with our 32KiB read buffer and small fixture
		// chunks, but guard against silent truncation.
		panic("chunkedReader: read buffer too small for fixture chunk")
	}
	return n, nil
}

func TestGateCasesFixtures(t *testing.T) {
	var cases []gateCaseJSON
	loadFixture(t, "gate-cases.json", &cases)
	if len(cases) == 0 {
		t.Fatal("no fixture cases loaded")
	}

	for _, c := range cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			r := newChunkedReader(c.Chunks)
			res := Run(context.Background(), r, Options{
				Family:              Family(c.Family),
				EventCap:            c.EventCap,
				ByteCap:             c.ByteCap,
				CaptureCommitMarker: true,
			})

			if res.ReadErr != nil {
				t.Fatalf("unexpected ReadErr: %v", res.ReadErr)
			}
			if res.Committed != c.Expected.Committed {
				t.Fatalf("Committed = %v, want %v (failure=%+v)", res.Committed, c.Expected.Committed, res.Failure)
			}

			if !c.Expected.Committed {
				if res.Failure == nil {
					t.Fatal("expected Failure, got nil")
				}
				if res.Failure.Reason != c.Expected.Reason {
					t.Errorf("Reason = %q, want %q", res.Failure.Reason, c.Expected.Reason)
				}
				if res.Failure.TerminalBeforeContent != c.Expected.TerminalBeforeContent {
					t.Errorf("TerminalBeforeContent = %v, want %v", res.Failure.TerminalBeforeContent, c.Expected.TerminalBeforeContent)
				}
				return
			}

			var prefixBytes int
			for _, chunk := range res.Prefix {
				prefixBytes += len(chunk)
			}
			if prefixBytes != c.Expected.PrefixBytes {
				t.Errorf("prefixBytes = %d, want %d", prefixBytes, c.Expected.PrefixBytes)
			}
			if res.ReaderDone != c.Expected.ReaderDone {
				t.Errorf("ReaderDone = %v, want %v", res.ReaderDone, c.Expected.ReaderDone)
			}
			if c.Expected.CommitMarker != nil {
				if res.CommitMarker == nil {
					t.Fatal("expected CommitMarker, got nil")
				}
				wm := c.Expected.CommitMarker
				if res.CommitMarker.FrameIndex != wm.FrameIndex {
					t.Errorf("CommitMarker.FrameIndex = %d, want %d", res.CommitMarker.FrameIndex, wm.FrameIndex)
				}
				if res.CommitMarker.ChunkIndex != wm.ChunkIndex {
					t.Errorf("CommitMarker.ChunkIndex = %d, want %d", res.CommitMarker.ChunkIndex, wm.ChunkIndex)
				}
				if !eqPtrStr(res.CommitMarker.EventName, wm.EventName) {
					t.Errorf("CommitMarker.EventName = %v, want %v", ptrStr(res.CommitMarker.EventName), ptrStr(wm.EventName))
				}
				if res.CommitMarker.BufferedBytes != wm.BufferedBytes {
					t.Errorf("CommitMarker.BufferedBytes = %d, want %d", res.CommitMarker.BufferedBytes, wm.BufferedBytes)
				}
				if res.CommitMarker.EchoExcludedBytes != wm.EchoExcludedBytes {
					t.Errorf("CommitMarker.EchoExcludedBytes = %d, want %d", res.CommitMarker.EchoExcludedBytes, wm.EchoExcludedBytes)
				}
			}

			// Verify the prefix bytes are exactly the concatenation of the
			// committed chunks in order (sanity check beyond byte count).
			var buf bytes.Buffer
			for _, chunk := range res.Prefix {
				buf.Write(chunk)
			}
			joined := strings.Join(c.Chunks, "")
			if !strings.HasPrefix(joined, buf.String()) {
				t.Errorf("prefix is not a prefix of the concatenated input chunks")
			}
		})
	}
}
