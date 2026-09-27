package report

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	outboxPrefix  = "complete-"
	outboxSuffix  = ".jsonl"
	rotateAtBytes = 64 << 20
)

// Outbox is an append-only on-disk queue of completion reports that could not be
// delivered. Each line is one serialized CompleteRequest.
type Outbox struct {
	dir      string
	maxBytes int64
	mu       sync.Mutex
	current  string
}

func NewOutbox(dir string, maxBytes int64) (*Outbox, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Outbox{dir: dir, maxBytes: maxBytes}, nil
}

func (o *Outbox) files() ([]string, error) {
	entries, err := os.ReadDir(o.dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && strings.HasPrefix(name, outboxPrefix) && strings.HasSuffix(name, outboxSuffix) {
			names = append(names, filepath.Join(o.dir, name))
		}
	}
	sort.Strings(names)
	return names, nil
}

// PendingBytes returns the total size of queued reports.
func (o *Outbox) PendingBytes() int64 {
	o.mu.Lock()
	defer o.mu.Unlock()
	names, err := o.files()
	if err != nil {
		return 0
	}
	var total int64
	for _, name := range names {
		if info, statErr := os.Stat(name); statErr == nil {
			total += info.Size()
		}
	}
	return total
}

// Append durably queues one report, dropping the oldest files when over budget.
func (o *Outbox) Append(report []byte) error {
	if bytes.ContainsRune(report, '\n') {
		return errors.New("outbox report must be a single line")
	}
	o.mu.Lock()
	defer o.mu.Unlock()

	if o.current != "" {
		if info, err := os.Stat(o.current); err != nil || info.Size() >= rotateAtBytes {
			o.current = ""
		}
	}
	if o.current == "" {
		o.current = filepath.Join(o.dir, fmt.Sprintf("%s%020d%s", outboxPrefix, time.Now().UnixNano(), outboxSuffix))
	}
	file, err := os.OpenFile(o.current, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err = file.Write(append(report, '\n')); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	o.enforceBudgetLocked()
	return nil
}

func (o *Outbox) enforceBudgetLocked() {
	names, err := o.files()
	if err != nil {
		return
	}
	var total int64
	sizes := make([]int64, len(names))
	for index, name := range names {
		if info, statErr := os.Stat(name); statErr == nil {
			sizes[index] = info.Size()
			total += info.Size()
		}
	}
	for index := 0; total > o.maxBytes && index < len(names)-1; index++ {
		if os.Remove(names[index]) == nil {
			total -= sizes[index]
		}
	}
}

// Drain sends queued reports oldest first. It stops at the first delivery error,
// keeping the undelivered remainder on disk. send returning ErrDrop discards a line.
func (o *Outbox) Drain(send func(json.RawMessage) error) (delivered int, err error) {
	o.mu.Lock()
	names, err := o.files()
	o.current = ""
	o.mu.Unlock()
	if err != nil {
		return 0, err
	}
	for _, name := range names {
		count, drainErr := o.drainFile(name, send)
		delivered += count
		if drainErr != nil {
			return delivered, drainErr
		}
	}
	return delivered, nil
}

// ErrDrop tells Drain to discard a report that can never be delivered.
var ErrDrop = errors.New("drop report")

func (o *Outbox) drainFile(name string, send func(json.RawMessage) error) (int, error) {
	o.mu.Lock()
	data, err := os.ReadFile(name)
	o.mu.Unlock()
	if err != nil {
		return 0, err
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 0, 64<<10), 16<<20)
	var remaining [][]byte
	delivered := 0
	var sendErr error
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		if sendErr != nil {
			remaining = append(remaining, line)
			continue
		}
		if err := send(line); err != nil && !errors.Is(err, ErrDrop) {
			sendErr = err
			remaining = append(remaining, line)
			continue
		}
		delivered++
	}

	o.mu.Lock()
	defer o.mu.Unlock()
	if len(remaining) == 0 {
		_ = os.Remove(name)
		return delivered, sendErr
	}
	tmp := name + ".tmp"
	if err := os.WriteFile(tmp, append(bytes.Join(remaining, []byte("\n")), '\n'), 0o600); err != nil {
		return delivered, err
	}
	if err := os.Rename(tmp, name); err != nil {
		return delivered, err
	}
	return delivered, sendErr
}
