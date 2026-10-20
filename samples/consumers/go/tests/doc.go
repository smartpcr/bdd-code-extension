// Package tests runs the greeter's suites as go test tests: one TestSuite_<id>
// per suite, one subtest per case, generated from bddsuite.tests.yaml and
// committed, as Go generated code is.
package tests

//go:generate go tool suiterun generate --config bddsuite.tests.yaml
