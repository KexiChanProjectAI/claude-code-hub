// Package state stores the last applied digest and target-owned secrets.
package state

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// File is mode 0600 because it contains the target proxy credential and local key.
type File struct {
	SourceDigest string `json:"source_digest"`
	PolicyDigest string `json:"policy_digest"`
	LocalKey     string `json:"local_key,omitempty"`
	ProxyURL     string `json:"proxy_url,omitempty"`
}

// Load returns an empty state when the file does not exist.
func Load(path string) (File, error) {
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return File{}, nil
	}
	if err != nil {
		return File{}, err
	}
	var file File
	if err := json.Unmarshal(body, &file); err != nil {
		return File{}, err
	}
	return file, nil
}

// Save atomically replaces the state file.
func Save(path string, file File) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	body, err := json.Marshal(file)
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, body, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}
