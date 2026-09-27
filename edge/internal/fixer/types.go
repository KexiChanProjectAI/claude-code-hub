// Package fixer ports the TypeScript response-fixer pipeline
// (src/app/v1/_lib/proxy/response-fixer/*) to Go, stdlib only.
package fixer

// FixResult mirrors the TS FixResult<Uint8Array> shape. Details == "" means
// "no details" (the TS field was omitted).
type FixResult struct {
	Data    []byte
	Applied bool
	Details string
}

// Config mirrors ResponseFixerConfig in src/types/system-config.ts, plus a
// Format field (not part of the TS config type) that selects the
// format-specific extra steps ResponseFixer.process applies based on
// session.originalFormat. Format == "" or "claude" is the original,
// format-agnostic behaviour; Format == "response" additionally applies
// filterInertResponsesChatCompletionChunks to streamed chunks (see
// StreamFixer.applyStreamFixers / filterInertResponsesChatCompletionChunks
// in response-fixer/index.ts).
type Config struct {
	FixTruncatedJSON bool
	FixSseFormat     bool
	FixEncoding      bool
	MaxJSONDepth     int
	MaxFixSize       int
	Format           string
}
