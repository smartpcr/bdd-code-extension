// Package generate is suiterun generate for Go (spec/test-plan.md): it reads a
// test project's bddsuite.tests.yaml, builds the test plan every runtime
// builds alike (conformance/generate/), and writes Go test code that runs each
// suite case as a subtest of go test, through package suitetest.
package generate

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// Providers are the providers a config may name (spec/tests.config.schema.json).
var Providers = []string{"mstest", "nunit", "xunit", "go", "rust", "node", "vitest", "jest", "mocha", "pester"}

var configKeys = map[string]bool{
	"suites": true, "exclude": true, "schemaRoot": true, "provider": true, "extensions": true,
	"offlineActions": true, "contextKeys": true, "output": true,
}

var outputKeys = map[string]bool{"folder": true, "namespace": true, "package": true}

// Config is one bddsuite.tests.yaml, with its paths made absolute against its
// own folder.
type Config struct {
	File       string
	Suites     []string
	Exclude    []string
	SchemaRoot string
	Provider   string
	Extensions []string
	// OfflineActions is nil when the config has none, which guards nothing.
	OfflineActions []string
	ContextKeys    []string
	OutputFolder   string
	Namespace      string
	Package        string
}

// Directory is the folder the config's paths are relative to.
func (config *Config) Directory() string { return filepath.Dir(config.File) }

// LoadConfig reads one config file, refusing what the schema refuses.
func LoadConfig(path string) (*Config, error) {
	full, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	text, err := os.ReadFile(full)
	if err != nil {
		return nil, fmt.Errorf("%s cannot be read: %w", path, err)
	}
	document, err := model.Load(string(text))
	if err != nil {
		return nil, fmt.Errorf("%s is not valid YAML: %w", path, err)
	}
	held, ok := document.Value.(*model.Map)
	if !ok {
		return nil, fmt.Errorf("%s does not hold a YAML mapping", path)
	}
	refuse := func(format string, values ...any) error {
		return fmt.Errorf("%s: %s", path, fmt.Sprintf(format, values...))
	}
	for _, key := range held.Keys() {
		if !configKeys[key] {
			return nil, refuse("%s is not a config key (spec/tests.config.schema.json).", key)
		}
	}
	texts := func(key string, required bool) ([]string, error) {
		raw, present := held.Get(key)
		if !present {
			if required {
				return nil, refuse("%s is required.", key)
			}
			return nil, nil
		}
		items, ok := raw.([]any)
		if !ok {
			return nil, refuse("%s is a list of non-empty strings.", key)
		}
		out := []string{}
		for _, item := range items {
			text, ok := item.(string)
			if !ok || text == "" {
				return nil, refuse("%s is a list of non-empty strings.", key)
			}
			out = append(out, text)
		}
		return out, nil
	}
	forwardSlashes := func(paths []string) error {
		for _, one := range paths {
			if strings.Contains(one, `\`) {
				return refuse("%s uses a backslash; paths use forward slashes.", one)
			}
		}
		return nil
	}
	config := &Config{File: full}
	if config.Suites, err = texts("suites", true); err != nil {
		return nil, err
	}
	if len(config.Suites) == 0 {
		return nil, refuse("suites names no glob.")
	}
	if config.Exclude, err = texts("exclude", false); err != nil {
		return nil, err
	}
	if err := forwardSlashes(append(append([]string{}, config.Suites...), config.Exclude...)); err != nil {
		return nil, err
	}
	schemaRoot := walk.Text(held, "schemaRoot")
	if schemaRoot == "" {
		return nil, refuse("schemaRoot is required.")
	}
	if err := forwardSlashes([]string{schemaRoot}); err != nil {
		return nil, err
	}
	config.SchemaRoot = filepath.Clean(filepath.Join(config.Directory(), filepath.FromSlash(schemaRoot)))
	if held.Has("provider") {
		config.Provider = walk.Text(held, "provider")
		known := false
		for _, one := range Providers {
			known = known || one == config.Provider
		}
		if !known {
			return nil, refuse("provider is one of %s, not %s.", strings.Join(Providers, ", "), config.Provider)
		}
	}
	if config.Extensions, err = texts("extensions", false); err != nil {
		return nil, err
	}
	if held.Has("offlineActions") {
		if config.OfflineActions, err = texts("offlineActions", false); err != nil {
			return nil, err
		}
		if config.OfflineActions == nil {
			config.OfflineActions = []string{}
		}
		for _, pattern := range config.OfflineActions {
			if star := strings.Index(pattern, "*"); star >= 0 && (!strings.HasSuffix(pattern, ".*") || star != len(pattern)-1) {
				return nil, refuse("offlineActions: %s is a name or prefix.*, with no other star.", pattern)
			}
		}
	}
	if config.ContextKeys, err = texts("contextKeys", false); err != nil {
		return nil, err
	}
	if raw, present := held.Get("output"); present {
		output, ok := raw.(*model.Map)
		if !ok {
			return nil, refuse("output is a mapping.")
		}
		for _, key := range output.Keys() {
			if !outputKeys[key] {
				return nil, refuse("output.%s is not an output key.", key)
			}
		}
		config.OutputFolder = walk.Text(output, "folder")
		config.Namespace = walk.Text(output, "namespace")
		config.Package = walk.Text(output, "package")
	}
	return config, nil
}
