package route

import "testing"

func TestDecide(t *testing.T) {
	cases := []struct {
		method, path string
		want         Decision
	}{
		{"POST", "/v1/messages", Execute},
		{"POST", "/v1/messages/", Execute},
		{"POST", "/V1/Messages", Execute},
		{"POST", "/v1/messages?beta=true", Execute},
		{"POST", "/messages", Execute},
		{"POST", "/messages/", Execute},
		{"POST", "/Messages", Delegate},
		{"POST", "/v1/messages/count_tokens", Delegate},
		{"POST", "/messages/count_tokens", Delegate},
		{"POST", "/v1/chat/completions", Delegate},
		{"POST", "/v1/responses", Delegate},
		{"GET", "/v1/messages", Delegate},
		{"GET", "/v1/models", Delegate},
		{"POST", "/v1/messages//", Execute},
		{"POST", "", Delegate},
	}
	for _, tc := range cases {
		if got := Decide(tc.method, tc.path); got != tc.want {
			t.Errorf("Decide(%q, %q) = %v, want %v", tc.method, tc.path, got, tc.want)
		}
	}
}

func TestCanonicalRequestPath(t *testing.T) {
	cases := map[string]string{
		"/messages?beta=true": "/v1/messages?beta=true",
		"/v1/messages":        "/v1/messages",
		"/messages/":          "/v1/messages",
		"/chat/completions?x": "/v1/chat/completions?x",
		"/other/path":         "/other/path",
		"/v1/messages/?a=1&b": "/v1/messages?a=1&b",
	}
	for input, want := range cases {
		if got := CanonicalRequestPath(input); got != want {
			t.Errorf("CanonicalRequestPath(%q) = %q, want %q", input, got, want)
		}
	}
}
