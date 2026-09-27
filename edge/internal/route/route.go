// Package route decides which requests the edge may execute itself.
//
// Mirrors src/app/v1/_lib/unprefixed-v1-alias.ts (alias mapping) followed by
// src/app/v1/_lib/proxy/endpoint-paths.ts normalizeEndpointPath. Only POST
// /v1/messages, /v1/responses and /v1/chat/completions (or their unprefixed
// aliases) are executed at the edge; every other request is reverse-proxied to
// the control plane untouched.
package route

import "strings"

type Decision int

const (
	Delegate Decision = iota
	Execute
)

// executablePaths are the normalized endpoints the edge executes itself.
var executablePaths = map[string]bool{
	"/v1/messages":         true,
	"/v1/responses":        true,
	"/v1/chat/completions": true,
}

var unprefixedAliases = []string{"/chat/completions", "/responses", "/models", "/messages"}

func stripQuery(path string) string {
	if index := strings.IndexByte(path, '?'); index >= 0 {
		return path[:index]
	}
	return path
}

// MapUnprefixed ports mapUnprefixedV1Path: case-sensitive alias match on the
// path without query and without one trailing slash.
func MapUnprefixed(path string) string {
	pathname := stripQuery(path)
	if pathname == "" {
		pathname = "/"
	}
	if len(pathname) > 1 && strings.HasSuffix(pathname, "/") {
		pathname = strings.TrimSuffix(pathname, "/")
	}
	for _, alias := range unprefixedAliases {
		if pathname == alias || strings.HasPrefix(pathname, alias+"/") {
			return "/v1" + pathname
		}
	}
	return pathname
}

// Normalize ports normalizeEndpointPath: strip query and trailing slash, lowercase.
func Normalize(path string) string {
	pathname := stripQuery(path)
	if len(pathname) > 1 && strings.HasSuffix(pathname, "/") {
		pathname = strings.TrimSuffix(pathname, "/")
	}
	return strings.ToLower(pathname)
}

// CanonicalRequestPath returns the alias-mapped path with the original query, the
// form the control plane sees after rewriteUnprefixedV1Request.
func CanonicalRequestPath(rawPath string) string {
	mapped := MapUnprefixed(rawPath)
	if index := strings.IndexByte(rawPath, '?'); index >= 0 {
		return mapped + rawPath[index:]
	}
	return mapped
}

// Decide returns Execute only for POST requests to an executable endpoint.
func Decide(method, rawPath string) Decision {
	if method != "POST" {
		return Delegate
	}
	if executablePaths[Normalize(MapUnprefixed(rawPath))] {
		return Execute
	}
	return Delegate
}
