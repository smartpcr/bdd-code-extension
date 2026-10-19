// Package shop runs the sample workspace's suites as go test tests: one
// TestSuite_<id> per suite, one subtest per case and examples row, generated
// from bddsuite.tests.yaml.
package shop

//go:generate go tool suiterun generate --config bddsuite.tests.yaml
