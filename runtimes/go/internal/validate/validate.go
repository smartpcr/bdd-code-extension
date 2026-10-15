// Package validate is validation, in the three levels DEC-Y05 defines.
//
// Structure sees the file and the schema. Semantics sees the parsed model and
// the catalog. Dataflow sees the expanded model and the catalog. All three run
// over one parse and everything they find is reported, because an author fixing
// four typos should see four diagnostics.
package validate

import (
	"fmt"
	"os"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/diag"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
)

// Options is how one file is to be validated.
type Options struct {
	Binding      string
	BindingCheck bool
	// Params are the --param pairs, in the order they were given, because a
	// later one replaces an earlier one and the message names the first.
	Params [][2]string
	// Extensions is the runtime's extensions: their context keys, lint rules
	// and environment prefix. The core alone when nil.
	Extensions *extension.Composite
}

// File is every diagnostic for one suite file, in the one order every binding
// writes them.
func File(path, relative string, loaded *schema.Schema, options *Options) ([]diag.Diagnostic, error) {
	text, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("%s cannot be read: %w", path, err)
	}
	document, err := model.Load(string(text))
	if err != nil {
		failure, ok := err.(*model.LoadError)
		if !ok {
			return nil, err
		}
		return []diag.Diagnostic{Unparseable(relative, failure.Message, failure.Position)}, nil
	}
	if _, ok := document.Value.(*model.Map); !ok {
		return []diag.Diagnostic{NotAMapping(relative)}, nil
	}
	extensions := options.Extensions
	if extensions == nil {
		extensions = extension.CoreOnly()
	}
	library := Imports(document, relative, path)
	found, err := checkStructure(document, relative, loaded)
	if err != nil {
		return nil, err
	}
	found = append(found, checkSemantics(document, relative, loaded, library,
		options.Binding, options.BindingCheck, options.Params, extensions.EnvPrefix)...)
	found = append(found, checkDataflow(document, relative, loaded, library, extensions.ContextKeys)...)
	// The extensions' rules see the same parse and what its imports are; their
	// findings are sorted in with the core's.
	found = append(found, extensions.Lint(extension.RuleInput{
		Document: document,
		File:     relative,
		Suite:    document.Value.(*model.Map),
		Imports:  library.Imports,
	})...)
	return diag.Sorted(found), nil
}
