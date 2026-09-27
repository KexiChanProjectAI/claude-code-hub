// Package ojson implements an order-preserving JSON value tree, mirroring the
// semantics JavaScript's JSON.parse/JSON.stringify give when applied to a
// plain object: object key insertion order is preserved (duplicate keys keep
// the position of their first occurrence and the value of their last
// occurrence), and numeric literals are read as raw text so callers can
// choose whether to preserve them verbatim or re-derive a JS-compatible
// float64 form.
package ojson

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"unicode/utf8"
)

// Kind identifies the JSON type held by a Value.
type Kind int

const (
	KindNull Kind = iota
	KindBool
	KindNumber
	KindString
	KindArray
	KindObject
)

// DefaultMaxDepth is used when callers do not need a specific limit.
const DefaultMaxDepth = 512

// Value is an immutable-shaped JSON tree node. Zero value is JSON null.
type Value struct {
	kind Kind
	b    bool
	num  string // raw numeric literal, exactly as it appeared in the source
	str  string
	arr  []*Value
	obj  *object
}

// object is an order-preserving string -> *Value map.
type object struct {
	keys []string
	m    map[string]*Value
}

func newObject() *object {
	return &object{m: make(map[string]*Value)}
}

func (o *object) set(key string, v *Value) {
	if _, ok := o.m[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.m[key] = v
}

func (o *object) get(key string) (*Value, bool) {
	v, ok := o.m[key]
	return v, ok
}

func (o *object) delete(key string) {
	if _, ok := o.m[key]; !ok {
		return
	}
	delete(o.m, key)
	for i, k := range o.keys {
		if k == key {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

// ---- constructors ----

func NewNull() *Value { return &Value{kind: KindNull} }

func NewBool(b bool) *Value { return &Value{kind: KindBool, b: b} }

func NewString(s string) *Value { return &Value{kind: KindString, str: s} }

// NewNumberLiteral builds a number Value from a raw JSON numeric literal.
// The literal is not validated; callers are expected to pass valid JSON
// number text (e.g. from json.Number).
func NewNumberLiteral(raw string) *Value { return &Value{kind: KindNumber, num: raw} }

// NewNumberFromFloat builds a number Value using the JS Number::toString
// textual form of f.
func NewNumberFromFloat(f float64) *Value {
	return &Value{kind: KindNumber, num: FormatJSNumber(f)}
}

func NewArray() *Value { return &Value{kind: KindArray} }

func NewObject() *Value { return &Value{kind: KindObject, obj: newObject()} }

// ---- accessors ----

func (v *Value) Kind() Kind {
	if v == nil {
		return KindNull
	}
	return v.kind
}

func (v *Value) IsNull() bool   { return v == nil || v.kind == KindNull }
func (v *Value) IsBool() bool   { return v != nil && v.kind == KindBool }
func (v *Value) IsNumber() bool { return v != nil && v.kind == KindNumber }
func (v *Value) IsString() bool { return v != nil && v.kind == KindString }
func (v *Value) IsArray() bool  { return v != nil && v.kind == KindArray }
func (v *Value) IsObject() bool { return v != nil && v.kind == KindObject }

func (v *Value) Bool() bool {
	if v == nil {
		return false
	}
	return v.b
}

// Number returns the raw numeric literal text.
func (v *Value) Number() string {
	if v == nil {
		return ""
	}
	return v.num
}

// Float64 parses the numeric literal as float64.
func (v *Value) Float64() (float64, error) {
	if v == nil || v.kind != KindNumber {
		return 0, fmt.Errorf("ojson: not a number")
	}
	return strconv.ParseFloat(v.num, 64)
}

func (v *Value) String() string {
	if v == nil {
		return ""
	}
	return v.str
}

func (v *Value) ArrayItems() []*Value {
	if v == nil || v.kind != KindArray {
		return nil
	}
	return v.arr
}

func (v *Value) ArrayLen() int {
	if v == nil || v.kind != KindArray {
		return 0
	}
	return len(v.arr)
}

func (v *Value) ArrayGet(i int) *Value {
	if v == nil || v.kind != KindArray || i < 0 || i >= len(v.arr) {
		return nil
	}
	return v.arr[i]
}

func (v *Value) ArrayAppend(item *Value) {
	if v == nil || v.kind != KindArray {
		return
	}
	v.arr = append(v.arr, item)
}

// ObjectKeys returns object keys in insertion order. Nil for non-objects.
func (v *Value) ObjectKeys() []string {
	if v == nil || v.kind != KindObject || v.obj == nil {
		return nil
	}
	return v.obj.keys
}

func (v *Value) ObjectLen() int {
	if v == nil || v.kind != KindObject || v.obj == nil {
		return 0
	}
	return len(v.obj.keys)
}

// ObjectGet returns the value for key and whether it was present.
func (v *Value) ObjectGet(key string) (*Value, bool) {
	if v == nil || v.kind != KindObject || v.obj == nil {
		return nil, false
	}
	return v.obj.get(key)
}

// ObjectHas reports whether key is an own key of the object.
func (v *Value) ObjectHas(key string) bool {
	_, ok := v.ObjectGet(key)
	return ok
}

// ObjectSet sets key to val. An existing key keeps its position; a new key
// is appended at the end (matches JS assignment semantics).
func (v *Value) ObjectSet(key string, val *Value) {
	if v == nil || v.kind != KindObject {
		return
	}
	if v.obj == nil {
		v.obj = newObject()
	}
	v.obj.set(key, val)
}

// ObjectDelete removes key if present.
func (v *Value) ObjectDelete(key string) {
	if v == nil || v.kind != KindObject || v.obj == nil {
		return
	}
	v.obj.delete(key)
}

// Clone deep-copies the value.
func (v *Value) Clone() *Value {
	if v == nil {
		return nil
	}
	switch v.kind {
	case KindArray:
		items := make([]*Value, len(v.arr))
		for i, item := range v.arr {
			items[i] = item.Clone()
		}
		return &Value{kind: KindArray, arr: items}
	case KindObject:
		out := &Value{kind: KindObject, obj: newObject()}
		if v.obj != nil {
			for _, k := range v.obj.keys {
				val, _ := v.obj.get(k)
				out.obj.set(k, val.Clone())
			}
		}
		return out
	default:
		cp := *v
		return &cp
	}
}

// ---- parsing ----

// Parse decodes data into an order-preserving Value tree. maxDepth <= 0 uses
// DefaultMaxDepth. Duplicate object keys: the position of the first
// occurrence is kept, the value of the last occurrence wins (matches
// JSON.parse assignment semantics).
func Parse(data []byte, maxDepth int) (*Value, error) {
	if maxDepth <= 0 {
		maxDepth = DefaultMaxDepth
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()

	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	v, err := buildFromToken(dec, tok, 1, maxDepth)
	if err != nil {
		return nil, err
	}
	// Reject trailing garbage after the top-level value.
	if _, err := dec.Token(); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("ojson: unexpected trailing data")
		}
		return nil, err
	}
	return v, nil
}

func parseValue(dec *json.Decoder, depth, maxDepth int) (*Value, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return buildFromToken(dec, tok, depth, maxDepth)
}

func buildFromToken(dec *json.Decoder, tok json.Token, depth, maxDepth int) (*Value, error) {
	switch t := tok.(type) {
	case json.Delim:
		if depth > maxDepth {
			return nil, fmt.Errorf("ojson: max depth %d exceeded", maxDepth)
		}
		switch t {
		case '{':
			obj := newObject()
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyTok.(string)
				if !ok {
					return nil, fmt.Errorf("ojson: expected object key")
				}
				val, err := parseValue(dec, depth+1, maxDepth)
				if err != nil {
					return nil, err
				}
				obj.set(key, val)
			}
			if _, err := dec.Token(); err != nil { // consume '}'
				return nil, err
			}
			return &Value{kind: KindObject, obj: obj}, nil
		case '[':
			var arr []*Value
			for dec.More() {
				val, err := parseValue(dec, depth+1, maxDepth)
				if err != nil {
					return nil, err
				}
				arr = append(arr, val)
			}
			if _, err := dec.Token(); err != nil { // consume ']'
				return nil, err
			}
			return &Value{kind: KindArray, arr: arr}, nil
		default:
			return nil, fmt.Errorf("ojson: unexpected delimiter %v", t)
		}
	case bool:
		return &Value{kind: KindBool, b: t}, nil
	case json.Number:
		return &Value{kind: KindNumber, num: string(t)}, nil
	case string:
		return &Value{kind: KindString, str: t}, nil
	case nil:
		return &Value{kind: KindNull}, nil
	default:
		return nil, fmt.Errorf("ojson: unexpected token %T", tok)
	}
}

// ---- serialization ----

// Marshal serializes the value compactly (no whitespace), preserving object
// key order and original numeric literals, and escaping strings the way
// JSON.stringify does.
func (v *Value) Marshal() []byte {
	var buf bytes.Buffer
	v.writeTo(&buf)
	return buf.Bytes()
}

func (v *Value) writeTo(buf *bytes.Buffer) {
	if v == nil {
		buf.WriteString("null")
		return
	}
	switch v.kind {
	case KindNull:
		buf.WriteString("null")
	case KindBool:
		if v.b {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case KindNumber:
		if v.num == "" {
			buf.WriteString("0")
		} else {
			buf.WriteString(v.num)
		}
	case KindString:
		writeJSONString(buf, v.str)
	case KindArray:
		buf.WriteByte('[')
		for i, item := range v.arr {
			if i > 0 {
				buf.WriteByte(',')
			}
			item.writeTo(buf)
		}
		buf.WriteByte(']')
	case KindObject:
		buf.WriteByte('{')
		if v.obj != nil {
			for i, k := range v.obj.keys {
				if i > 0 {
					buf.WriteByte(',')
				}
				writeJSONString(buf, k)
				buf.WriteByte(':')
				val, _ := v.obj.get(k)
				val.writeTo(buf)
			}
		}
		buf.WriteByte('}')
	}
}

// writeJSONString escapes s exactly the way JSON.stringify does: escape `"`,
// `\`, and control characters (<0x20) using the short escapes where
// available (\b \f \n \r \t) or \u00XX otherwise. `<`, `>`, `&` and
// non-ASCII characters are emitted verbatim. Invalid UTF-8 bytes are
// replaced with U+FFFD.
func writeJSONString(buf *bytes.Buffer, s string) {
	buf.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			buf.WriteRune(utf8.RuneError)
			i++
			continue
		}
		switch r {
		case '"':
			buf.WriteString(`\"`)
		case '\\':
			buf.WriteString(`\\`)
		case '\b':
			buf.WriteString(`\b`)
		case '\f':
			buf.WriteString(`\f`)
		case '\n':
			buf.WriteString(`\n`)
		case '\r':
			buf.WriteString(`\r`)
		case '\t':
			buf.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(buf, `\u%04x`, r)
			} else {
				buf.WriteRune(r)
			}
		}
		i += size
	}
	buf.WriteByte('"')
}
