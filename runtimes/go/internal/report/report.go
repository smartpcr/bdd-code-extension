// Package report is the two reports a run writes.
//
// The same documents the PowerShell binding writes, so that the two
// canonicalise equal by the rules in
// conformance/report/canonicalise.md. The timestamps and durations
// stay in the shipped output: a report a person reads wants them, and the
// canonical form is what drops them for a comparison.
package report

import (
	"fmt"
	"strings"
	"time"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/exec"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
)

// escape is XML text with the five characters that cannot appear raw replaced.
func escape(text string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	)
	return replacer.Replace(text)
}

func counts(cases []exec.CaseResult) (total, passed, failed, skipped int) {
	total = len(cases)
	for _, held := range cases {
		switch held.Status {
		case trace.Passed:
			passed++
		case trace.Failed, trace.Error:
			failed++
		case trace.Skipped:
			skipped++
		}
	}
	return
}

func resultWord(status trace.Status) string {
	switch status {
	case trace.Passed:
		return "Passed"
	case trace.Skipped:
		return "Skipped"
	default:
		return "Failed"
	}
}

// stamp is the time a report stamps itself with. Dropped by the canonical form,
// so its only job is to be a legal timestamp.
func stamp() string {
	return time.Now().UTC().Format("2006-01-02 15:04:05Z")
}

// redacted is escape after every redaction an extension supplies
// (extension.RunState.Redact): every text a report carries passes through it.
func redacted(redact []func(string) string) func(string) string {
	return func(text string) string {
		for _, one := range redact {
			if one != nil {
				text = one(text)
			}
		}
		return escape(text)
	}
}

// NUnit3 writes the NUnit 3 document.
func NUnit3(suites []exec.SuiteResult, redact ...func(string) string) string {
	x := redacted(redact)
	all := []exec.CaseResult{}
	for _, one := range suites {
		all = append(all, one.Cases...)
	}
	total, passed, failed, skipped := counts(all)
	duration := 0.0
	for _, held := range all {
		duration += held.DurationSec
	}
	now := stamp()
	overall := "Passed"
	if failed > 0 {
		overall = "Failed"
	}

	var out strings.Builder
	out.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	fmt.Fprintf(&out,
		"<test-run id=\"2\" testcasecount=\"%d\" result=\"%s\" total=\"%d\" passed=\"%d\" failed=\"%d\" inconclusive=\"0\" skipped=\"%d\" asserts=\"0\" engine-version=\"1.0\" clr-version=\"go\" start-time=\"%s\" end-time=\"%s\" duration=\"%.3f\">\n",
		total, overall, total, passed, failed, skipped, now, now, duration)
	suiteID := 1000
	caseID := 2000
	for _, one := range suites {
		suiteID++
		total, passed, failed, skipped := counts(one.Cases)
		duration := 0.0
		for _, held := range one.Cases {
			duration += held.DurationSec
		}
		result := "Passed"
		if failed > 0 {
			result = "Failed"
		}
		name := x(one.Name)
		fmt.Fprintf(&out,
			"  <test-suite type=\"TestFixture\" id=\"0-%d\" name=\"%s\" fullname=\"%s\" classname=\"%s\" runstate=\"Runnable\" testcasecount=\"%d\" result=\"%s\" start-time=\"%s\" end-time=\"%s\" duration=\"%.3f\" total=\"%d\" passed=\"%d\" failed=\"%d\" inconclusive=\"0\" skipped=\"%d\" asserts=\"0\">\n",
			suiteID, name, name, name, total, result, now, now, duration, total, passed, failed, skipped)
		for _, held := range one.Cases {
			caseID++
			caseName := x(held.Name)
			fmt.Fprintf(&out,
				"    <test-case id=\"0-%d\" name=\"%s\" fullname=\"%s.%s\" methodname=\"%s\" classname=\"%s\" runstate=\"Runnable\" result=\"%s\" start-time=\"%s\" end-time=\"%s\" duration=\"%.3f\" asserts=\"0\">\n",
				caseID, caseName, name, caseName, caseName, name, resultWord(held.Status), now, now, held.DurationSec)
			switch held.Status {
			case trace.Failed, trace.Error:
				out.WriteString("      <failure>\n")
				fmt.Fprintf(&out, "        <message>%s</message>\n", x(held.Message))
				out.WriteString("      </failure>\n")
			case trace.Skipped:
				out.WriteString("      <reason>\n")
				fmt.Fprintf(&out, "        <message>%s</message>\n", x(held.Message))
				out.WriteString("      </reason>\n")
			}
			if held.Output != "" {
				fmt.Fprintf(&out, "      <output>%s</output>\n", x(strings.TrimRight(held.Output, "\n\r\t ")))
			}
			out.WriteString("    </test-case>\n")
		}
		out.WriteString("  </test-suite>\n")
	}
	out.WriteString("</test-run>\n")
	return out.String()
}

// JUnit writes the JUnit document.
func JUnit(suites []exec.SuiteResult, redact ...func(string) string) string {
	x := redacted(redact)
	var out strings.Builder
	out.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuites>\n")
	for _, one := range suites {
		total, _, failed, skipped := counts(one.Cases)
		name := x(one.Name)
		fmt.Fprintf(&out, "  <testsuite name=\"%s\" tests=\"%d\" failures=\"%d\" skipped=\"%d\">\n",
			name, total, failed, skipped)
		for _, held := range one.Cases {
			caseName := x(held.Name)
			fmt.Fprintf(&out, "    <testcase name=\"%s\" classname=\"%s\" time=\"%.3f\">\n",
				caseName, name, held.DurationSec)
			switch held.Status {
			case trace.Failed, trace.Error:
				fmt.Fprintf(&out, "      <failure message=\"%s\"></failure>\n", x(held.Message))
			case trace.Skipped:
				fmt.Fprintf(&out, "      <skipped message=\"%s\"></skipped>\n", x(held.Message))
			}
			fmt.Fprintf(&out, "      <system-out>%s</system-out>\n",
				x(strings.TrimRight(held.Output, "\n\r\t ")))
			out.WriteString("    </testcase>\n")
		}
		out.WriteString("  </testsuite>\n")
	}
	out.WriteString("</testsuites>\n")
	return out.String()
}
