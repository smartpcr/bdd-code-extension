// Package extension is the extension API (DEC-S03): how code outside this
// runtime adds to it without editing it. An extension may add any of five
// things:
//
//	actions       name to handler, each handler seeing its extension's per-run state
//	context keys  names readable in ${...} and known to dataflow lint
//	options       command-line flags the extension declares and reads
//	rules         extra lint rules, and a limit a case may not exceed at run time
//	env prefix    the prefix of the parameter and record variables
//
// A consumer builds its own suiterun from the runtime and its extensions:
//
//	func main() { os.Exit(suiterun.Main(os.Args[1:], os.Stdout, os.Stderr, myExtension)) }
//
// Several extensions compose; a name two of them define, or one that clashes
// with the core, is refused when they are composed, before anything runs.
package extension

import (
	"fmt"
	"regexp"
	"sort"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/diag"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/expr"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
)

// DefaultEnvPrefix is the prefix of PARAM_<NAME> and RECORD_PATH when no
// extension sets one.
const DefaultEnvPrefix = "BDD_SUITE_"

// CoreRoots is the roots every expression may start at, before any extension
// adds context keys.
var CoreRoots = expr.CoreRoots

// coreFlags is the core's own flags; an extension may not take one.
var coreFlags = []string{"--path", "--tags", "--results", "--trace-file", "--schema-root", "--binding", "--format",
	"--param", "--json", "--strict", "--dry-run", "--binding-check"}

var optionPattern = regexp.MustCompile(`^--[a-z][a-z0-9-]*$`)

// Option is a command-line flag an extension takes, always with a value:
// `--region <value>`.
type Option struct {
	// Flag is the flag with its leading dashes, e.g. --region.
	Flag string
	// Description is one line for the usage text.
	Description string
}

// Import is one import a suite (or a library it imports) names, in reading
// order, so an extension's rule can see what a suite brings in.
type Import struct {
	// Import is the path as the suite writes it.
	Import string
	// Pointer is where the suite writes it, e.g. /imports/0.
	Pointer string
	// File is the absolute path the import resolves to.
	File string
}

// RuleInput is what a lint rule sees: one parsed suite file and what its
// imports are.
type RuleInput struct {
	Document *model.Document
	// File is relative to the workspace root, as findings report it.
	File    string
	Suite   *model.Map
	Imports []Import
}

// Rules is an extension's lint rules and limits. Either may be nil.
type Rules struct {
	// Lint is findings beyond the core's, positioned like every other
	// (diagnostics.md).
	Lint func(input RuleInput) []diag.Diagnostic
	// CaseLimitSec is the limit a case runs under, given the one the suite
	// declares; the smaller of the two applies.
	CaseLimitSec func(suite *model.Map, declaredSec int64) int64
}

// RunState is what one run of an extension provides, from the values of its
// options.
type RunState struct {
	// Context is a value for each context key, as ${key} reads it; a declared
	// key with no value reads as "".
	Context map[string]any
	// Redact is applied to every text a report carries, e.g. to hide secrets.
	Redact func(text string) string
	// State is handed to this extension's actions as Request.State.
	State any
}

// Extension is one extension of this runtime.
type Extension struct {
	// Name is shown in errors about this extension.
	Name        string
	Actions     []actions.Registration
	ContextKeys []string
	Options     []Option
	Rules       Rules
	// EnvPrefix is the prefix of PARAM_<NAME> and RECORD_PATH; BDD_SUITE_
	// when no extension sets one.
	EnvPrefix string
	// Start is called once per run, with the values given for this
	// extension's options (flag to value).
	Start func(options map[string]string) RunState
}

// Error is why extensions cannot be composed.
type Error struct{ Message string }

func (failure *Error) Error() string { return failure.Message }

func refuse(format string, arguments ...any) error {
	return &Error{Message: fmt.Sprintf(format, arguments...)}
}

// Registered is one action of the composite: its handler, and the extension
// that registered it (Owner is -1 for the core).
type Registered struct {
	Handler   actions.Handler
	Owner     int
	OwnerName string
}

// Composite is every extension of one runtime, merged and checked.
type Composite struct {
	Extensions []Extension
	// Actions is action name to its handler and owner, the core's included.
	Actions map[string]Registered
	// Roots is CoreRoots and every extension's context keys.
	Roots []string
	// ContextKeys is every extension's context keys, in declaration order.
	ContextKeys []string
	Options     []Option
	EnvPrefix   string
}

const theCore = "the core"

// Compose merges the core and the given extensions, refusing any name defined
// twice or taken from the core.
func Compose(extensions ...Extension) (*Composite, error) {
	held := map[string]Registered{}
	for _, registration := range actions.Core() {
		held[registration.Name] = Registered{Handler: registration.Handler, Owner: -1, OwnerName: theCore}
	}
	keys := map[string]string{}
	for _, key := range CoreRoots {
		keys[key] = theCore
	}
	flags := map[string]string{}
	for _, flag := range coreFlags {
		flags[flag] = theCore
	}
	composite := &Composite{Extensions: extensions}
	prefix, prefixOwner := "", ""
	for index, one := range extensions {
		for _, registration := range one.Actions {
			if owner, taken := held[registration.Name]; taken {
				return nil, refuse("Action %s is defined by both %s and %s.", registration.Name, owner.OwnerName, one.Name)
			}
			held[registration.Name] = Registered{Handler: registration.Handler, Owner: index, OwnerName: one.Name}
		}
		for _, key := range one.ContextKeys {
			if owner, taken := keys[key]; taken {
				return nil, refuse("Context key %s is defined by both %s and %s.", key, owner, one.Name)
			}
			keys[key] = one.Name
			composite.ContextKeys = append(composite.ContextKeys, key)
		}
		for _, option := range one.Options {
			if !optionPattern.MatchString(option.Flag) {
				return nil, refuse("%s declares the option %s; an option is --lower-case-words.", one.Name, option.Flag)
			}
			if owner, taken := flags[option.Flag]; taken {
				return nil, refuse("Option %s is defined by both %s and %s.", option.Flag, owner, one.Name)
			}
			flags[option.Flag] = one.Name
			composite.Options = append(composite.Options, option)
		}
		if one.EnvPrefix != "" {
			if prefixOwner != "" && prefix != one.EnvPrefix {
				return nil, refuse("%s sets the environment prefix %s and %s sets %s.", prefixOwner, prefix, one.Name, one.EnvPrefix)
			}
			prefix, prefixOwner = one.EnvPrefix, one.Name
		}
	}
	composite.Actions = held
	composite.Roots = append(append([]string(nil), CoreRoots...), composite.ContextKeys...)
	composite.EnvPrefix = DefaultEnvPrefix
	if prefixOwner != "" {
		composite.EnvPrefix = prefix
	}
	return composite, nil
}

// CoreOnly is the core with no extension.
func CoreOnly() *Composite {
	composite, err := Compose()
	if err != nil {
		// The core alone cannot clash with itself.
		panic(err)
	}
	return composite
}

// Names is every action this runtime runs, sorted: the core ones, wait, and
// every extension's.
func (composite *Composite) Names() []string {
	names := make([]string, 0, len(composite.Actions))
	for name := range composite.Actions {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Lint is every extension's findings for one file.
func (composite *Composite) Lint(input RuleInput) []diag.Diagnostic {
	found := []diag.Diagnostic{}
	for _, one := range composite.Extensions {
		if one.Rules.Lint != nil {
			found = append(found, one.Rules.Lint(input)...)
		}
	}
	return found
}

// CaseLimitSec is the limit a case runs under: the smallest of what it
// declares and what every extension allows.
func (composite *Composite) CaseLimitSec(suite *model.Map, declaredSec int64) int64 {
	limit := declaredSec
	for _, one := range composite.Extensions {
		if one.Rules.CaseLimitSec == nil {
			continue
		}
		if allowed := one.Rules.CaseLimitSec(suite, declaredSec); allowed < limit {
			limit = allowed
		}
	}
	return limit
}

// Started is one run's started extensions: each one's state, the context
// values, and one redaction over all of them.
type Started struct {
	// States is each extension's state, by its index in the composite.
	States []any
	// Context is only the values given: a declared key with none reads as ""
	// unless the suite's defaults name it (package exec).
	Context  map[string]any
	redactor []func(string) string
}

// Redact passes a text through every extension's redaction, in order.
func (started *Started) Redact(text string) string {
	if started == nil {
		return text
	}
	for _, one := range started.redactor {
		text = one(text)
	}
	return text
}

// State is the state of the extension that owns an action, or nil for the
// core's.
func (started *Started) State(owner int) any {
	if started == nil || owner < 0 || owner >= len(started.States) {
		return nil
	}
	return started.States[owner]
}

// Start starts every extension with its own options' values, once per run.
func Start(composite *Composite, values map[string]string) *Started {
	started := &Started{States: make([]any, len(composite.Extensions)), Context: map[string]any{}}
	for index, one := range composite.Extensions {
		own := map[string]string{}
		for _, option := range one.Options {
			if given, found := values[option.Flag]; found {
				own[option.Flag] = given
			}
		}
		if one.Start == nil {
			continue
		}
		run := one.Start(own)
		started.States[index] = run.State
		for _, key := range one.ContextKeys {
			if given, found := run.Context[key]; found {
				started.Context[key] = given
			}
		}
		if run.Redact != nil {
			started.redactor = append(started.redactor, run.Redact)
		}
	}
	return started
}
