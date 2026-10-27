package snapshot

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
)

const digestSuffixMark = `,"digest":"`

// Assembler writes one canonical snapshot document. Row maps exist only while
// that row is canonicalized; the buffer is the retained copy.
type Assembler struct {
	buf        bytes.Buffer
	names      []string
	tableIndex int
	rowIndex   int
	inTable    bool
}

// NewAssembler starts {"schema":...,"tables":{ . names are emitted in sorted order.
func NewAssembler(schema []Column, tables []string) (*Assembler, error) {
	schemaJSON, err := json.Marshal(schema)
	if err != nil {
		return nil, err
	}
	names := append([]string(nil), tables...)
	sort.Strings(names)
	assembler := &Assembler{names: names}
	assembler.buf.WriteString(`{"schema":`)
	assembler.buf.Write(schemaJSON)
	assembler.buf.WriteString(`,"tables":{`)
	return assembler, nil
}

// BeginTable opens the next sorted table key.
func (a *Assembler) BeginTable(name string) error {
	if a.tableIndex >= len(a.names) || a.names[a.tableIndex] != name || a.inTable {
		return errDigest
	}
	if a.tableIndex > 0 {
		a.buf.WriteByte(',')
	}
	key, err := json.Marshal(name)
	if err != nil {
		return err
	}
	a.buf.Write(key)
	a.buf.WriteString(`:[`)
	a.inTable = true
	a.rowIndex = 0
	return nil
}

// WriteRow canonicalizes one Postgres row_to_json value into the open table.
func (a *Assembler) WriteRow(raw string) error {
	if !a.inTable {
		return errDigest
	}
	canonical, err := canonicalJSON(raw)
	if err != nil {
		return err
	}
	if a.rowIndex > 0 {
		a.buf.WriteByte(',')
	}
	a.buf.Write(canonical)
	a.rowIndex++
	return nil
}

// EndTable closes the open table array.
func (a *Assembler) EndTable() error {
	if !a.inTable {
		return errDigest
	}
	a.buf.WriteByte(']')
	a.inTable = false
	a.tableIndex++
	return nil
}

// Finish hashes {"schema":...,"tables":...} and appends the digest in place.
func (a *Assembler) Finish() ([]byte, error) {
	if a.inTable || a.tableIndex != len(a.names) {
		return nil, errDigest
	}
	a.buf.WriteString(`}}`)
	sum := sha256.Sum256(a.buf.Bytes())
	digest := hex.EncodeToString(sum[:])
	a.buf.Truncate(a.buf.Len() - 1)
	a.buf.WriteString(digestSuffixMark)
	a.buf.WriteString(digest)
	a.buf.WriteString(`"}`)
	return a.buf.Bytes(), nil
}

func canonicalJSON(raw string) ([]byte, error) {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return json.Marshal(value)
}

// VerifyWire checks the trailing digest against the canonical prefix.
// It does not decode rows.
func VerifyWire(wire []byte) (string, error) {
	const hexLen = 64
	mark := len(digestSuffixMark)
	if len(wire) < mark+hexLen+2 || wire[len(wire)-1] != '}' || wire[len(wire)-2] != '"' {
		return "", errDigest
	}
	hexStart := len(wire) - 2 - hexLen
	if string(wire[hexStart-mark:hexStart]) != digestSuffixMark {
		return "", errDigest
	}
	digest := string(wire[hexStart : hexStart+hexLen])
	for _, char := range digest {
		switch {
		case char >= '0' && char <= '9', char >= 'a' && char <= 'f':
		default:
			return "", errDigest
		}
	}
	hasher := sha256.New()
	hasher.Write(wire[:hexStart-mark])
	hasher.Write([]byte{'}'})
	if hex.EncodeToString(hasher.Sum(nil)) != digest {
		return "", errDigest
	}
	return digest, nil
}

// SchemaOf decodes the leading schema array and does not retain table rows.
func SchemaOf(wire []byte) ([]Column, error) {
	decoder := json.NewDecoder(bytes.NewReader(wire))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, errDigest
	}
	key, err := decoder.Token()
	if err != nil || key != "schema" {
		return nil, errDigest
	}
	var schema []Column
	if err = decoder.Decode(&schema); err != nil {
		return nil, err
	}
	return schema, nil
}
