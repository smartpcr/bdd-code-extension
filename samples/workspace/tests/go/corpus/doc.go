// Package corpus runs the conformance corpus's execute suites as go test
// tests, so the corpus proves the provider (docs/test-providers, DEC-T12).
package corpus

//go:generate go tool suiterun generate --config bddsuite.tests.yaml
