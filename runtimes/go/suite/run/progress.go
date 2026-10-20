package run

import (
	"fmt"
	"io"
	"math"
	"os"
	"strings"
	"sync"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/exec"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
)

// ProgressWriter is where --progress writes its live lines: standard output
// (spec/progress.md). A test may point it elsewhere.
var ProgressWriter io.Writer = os.Stdout

// ProgressPrinter is the observer behind run --progress (spec/progress.md).
//
// A run of many lab suites takes hours, and the people and tools watching it
// need to know which case is running and how the finished ones went before the
// report is written at the end. The lines use the shape TAEF's console output
// has, because existing lab tooling already parses it:
//
//	    suite-setup   step 1 (core.record) passed
//	StartGroup: orders::place-an-order
//	    step          when the order is placed (shop.order) passed
//	EndGroup: orders::place-an-order [Passed] (3s)
//	Summary: Total=1, Passed=1, Failed=0, Blocked=0, Not Run=0, Skipped=0
//
// Only selected cases are counted: a case the tag or name filter left out was
// never part of this run.
type ProgressPrinter struct {
	writer                  io.Writer
	gate                    sync.Mutex
	passed, failed, skipped int
}

// NewProgressPrinter prints to writer.
func NewProgressPrinter(writer io.Writer) *ProgressPrinter {
	return &ProgressPrinter{writer: writer}
}

// CaseStarted prints StartGroup.
func (printer *ProgressPrinter) CaseStarted(suite, caseName string) {
	printer.write(fmt.Sprintf("StartGroup: %s::%s", suite, caseName))
}

// CaseFinished counts the case and prints its failure, when it has one, and
// EndGroup.
func (printer *ProgressPrinter) CaseFinished(suite string, result exec.CaseResult) {
	verdict := "Failed"
	switch result.Status {
	case trace.Passed:
		verdict = "Passed"
	case trace.Skipped:
		verdict = "Skipped"
	}
	printer.gate.Lock()
	switch verdict {
	case "Passed":
		printer.passed++
	case "Skipped":
		printer.skipped++
	default:
		printer.failed++
	}
	printer.gate.Unlock()
	if verdict == "Failed" && result.Message != "" {
		message := strings.ReplaceAll(strings.ReplaceAll(result.Message, "\r\n", " "), "\n", " ")
		printer.write("    failure: " + strings.ReplaceAll(message, "\r", " "))
	}
	// Rounded half away from zero, as the other runtimes round.
	printer.write(fmt.Sprintf("EndGroup: %s::%s [%s] (%.0fs)", suite, result.Name, verdict, math.Round(result.DurationSec)))
}

// Entry prints one line per trace entry other than a case's result, so the
// last line of a log says what a long case is doing.
func (printer *ProgressPrinter) Entry(entry trace.Entry) {
	if entry.Phase == trace.Case {
		return
	}
	// A step label written with a Gherkin keyword already ends in "(action)".
	action := ""
	if entry.Action != "" && !strings.Contains(entry.Step, "("+entry.Action+")") {
		action = " (" + entry.Action + ")"
	}
	reason := ""
	if entry.Reason != "" {
		reason = " [" + string(entry.Reason) + "]"
	}
	printer.write(fmt.Sprintf("    %-13s %s%s %s%s", entry.Phase, entry.Step, action, entry.Status, reason))
}

// Summary prints the closing line, which the tooling reads as authoritative.
func (printer *ProgressPrinter) Summary() {
	printer.gate.Lock()
	passed, failed, skipped := printer.passed, printer.failed, printer.skipped
	printer.gate.Unlock()
	printer.write(fmt.Sprintf("Summary: Total=%d, Passed=%d, Failed=%d, Blocked=0, Not Run=0, Skipped=%d",
		passed+failed+skipped, passed, failed, skipped))
}

func (printer *ProgressPrinter) write(line string) {
	printer.gate.Lock()
	defer printer.gate.Unlock()
	// Go's os.Stdout is not buffered, so each line is out as soon as it is written.
	fmt.Fprintln(printer.writer, line)
}
