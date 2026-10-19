package generate

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/suite"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/validate"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/diag"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// ReservedInSuite are the case identifiers generated code declares members
// with, taken before any case in a suite is named (spec/test-plan.md).
var ReservedInSuite = []string{"Setup", "Teardown", "BeforeEach", "AfterEach", "TestContext", "Session"}

// Identifiers gives names their identifiers (spec/test-plan.md, Identifiers):
// the name's ASCII letters and digits, each word capitalised, a fallback for a
// name with none, N before a leading digit, and _2, _3, ... on a collision
// compared ignoring ASCII case.
type Identifiers struct{ taken map[string]bool }

// NewIdentifiers starts with the given identifiers taken.
func NewIdentifiers(reserved ...string) *Identifiers {
	held := &Identifiers{taken: map[string]bool{}}
	for _, one := range reserved {
		held.taken[strings.ToLower(one)] = true
	}
	return held
}

// IdentifierOf is the identifier a name gives before collisions.
func IdentifierOf(name, fallback string) string {
	built := strings.Builder{}
	startOfWord := true
	for _, one := range name {
		letter := one < 128 && (one >= 'a' && one <= 'z' || one >= 'A' && one <= 'Z' || one >= '0' && one <= '9')
		if !letter {
			startOfWord = true
			continue
		}
		if startOfWord && one >= 'a' && one <= 'z' {
			one -= 'a' - 'A'
		}
		built.WriteRune(one)
		startOfWord = false
	}
	text := built.String()
	if text == "" {
		text = fallback
	}
	if text[0] >= '0' && text[0] <= '9' {
		text = "N" + text
	}
	return text
}

// Take is the next free identifier for a name.
func (held *Identifiers) Take(name, fallback string) string {
	wanted := IdentifierOf(name, fallback)
	candidate := wanted
	for number := 2; held.taken[strings.ToLower(candidate)]; number++ {
		candidate = fmt.Sprintf("%s_%d", wanted, number)
	}
	held.taken[strings.ToLower(candidate)] = true
	return candidate
}

// Case is one case of a plan: a test the generated code declares.
type Case struct {
	Name    string
	ID      string
	Tags    []string
	Outline string
	Row     *model.Map
}

// Suite is one suite of a plan: a test function.
type Suite struct {
	File      string
	FullPath  string
	Name      string
	ID        string
	Tags      []string
	Guarded   bool
	GuardedBy []string
	Cases     []Case
}

// Plan is a config's test plan (spec/test-plan.md).
type Plan struct {
	Config *Config
	Suites []Suite
}

// Covers says whether an offlineActions pattern covers an action: the name
// itself, or prefix.* and a name starting with the prefix and its dot.
func Covers(pattern, action string) bool {
	if strings.HasSuffix(pattern, "*") {
		return strings.HasPrefix(action, strings.TrimSuffix(pattern, "*"))
	}
	return pattern == action
}

// Actions is every action a suite can run: its hooks and every case's phases,
// meta steps expanded (imported ones too), and the step each wait polls.
func Actions(suiteModel *model.Map, path string) ([]string, error) {
	library, err := suite.ReadLibraries(suiteModel, path)
	if err != nil {
		return nil, err
	}
	definitions := suite.MetaDefinitions(suiteModel, library)
	lists := [][]*model.Map{}
	hooks, err := suite.ExpandedHooks(suiteModel, definitions)
	if err != nil {
		return nil, err
	}
	for _, steps := range hooks {
		lists = append(lists, steps)
	}
	for _, held := range suite.Cases(suiteModel) {
		phases, err := suite.ExpandedCase(held, definitions)
		if err != nil {
			return nil, err
		}
		for _, steps := range phases {
			lists = append(lists, steps)
		}
	}
	var out []string
	for _, steps := range lists {
		for _, step := range steps {
			for current := step; current != nil; {
				if action := walk.Text(current, "action"); action != "" {
					out = append(out, action)
				}
				next, ok := walk.AsMap(current.Value("forStep"))
				if !ok {
					break
				}
				current = next
			}
		}
	}
	return out, nil
}

func distinct(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, one := range values {
		if !seen[one] {
			seen[one] = true
			out = append(out, one)
		}
	}
	return out
}

// Build builds a config's plan, or refuses it with the findings of every suite
// that does not lint clean (nothing is generated from a partial plan).
func Build(config *Config) (*Plan, []diag.Diagnostic, error) {
	loaded, err := schema.Load(config.SchemaRoot)
	if err != nil {
		return nil, nil, err
	}
	// The suites lint before any extension is loaded, so the context keys the
	// extensions add come from the config.
	standIn, err := extension.Compose(extension.Extension{Name: "the config's context keys", ContextKeys: config.ContextKeys})
	if err != nil {
		return nil, nil, err
	}
	settings := &validate.Options{Extensions: standIn}
	files, err := Select(config.Directory(), config.Suites, config.Exclude)
	if err != nil {
		return nil, nil, err
	}
	type loadedSuite struct {
		relative, full string
		held           *model.Map
	}
	var suites []loadedSuite
	var findings []diag.Diagnostic
	for _, relative := range files {
		full := filepath.Join(config.Directory(), filepath.FromSlash(relative))
		text, err := os.ReadFile(full)
		if err != nil {
			return nil, nil, err
		}
		document, err := model.Load(string(text))
		if err != nil {
			return nil, nil, err
		}
		held, ok := document.Value.(*model.Map)
		// A library declares and never runs: only a file with a suite key is a suite.
		if !ok || !held.Has("suite") {
			continue
		}
		found, err := validate.File(full, relative, loaded, settings)
		if err != nil {
			return nil, nil, err
		}
		findings = append(findings, found...)
		suites = append(suites, loadedSuite{relative, full, held})
	}
	findings = diag.Sorted(findings)
	if diag.Fails(findings, false) {
		return nil, findings, nil
	}

	plan := &Plan{Config: config}
	suiteIDs := NewIdentifiers()
	for _, one := range suites {
		name := walk.Text(one.held, "suite")
		caseIDs := NewIdentifiers(ReservedInSuite...)
		var cases []Case
		entries, _ := walk.List(one.held, "tests")
		for _, raw := range entries {
			held, ok := walk.AsMap(raw)
			if !ok {
				continue
			}
			outline := ""
			if rows, ok := held.Value("examples").([]any); ok && len(rows) > 0 {
				outline = walk.Text(held, "name")
			}
			for _, expanded := range suite.ExpandOutline(held) {
				caseName := walk.Text(expanded, "name")
				planned := Case{Name: caseName, ID: caseIDs.Take(caseName, "Case"), Tags: distinct(suite.CaseTags(one.held, expanded)), Outline: outline}
				if outline != "" {
					planned.Row, _ = walk.AsMap(expanded.Value("__row"))
				}
				cases = append(cases, planned)
			}
		}
		guardedBy := []string{}
		if config.OfflineActions != nil {
			used, err := Actions(one.held, one.full)
			if err != nil {
				return nil, nil, err
			}
			for _, action := range distinct(used) {
				covered := false
				for _, pattern := range config.OfflineActions {
					covered = covered || Covers(pattern, action)
				}
				if !covered {
					guardedBy = append(guardedBy, action)
				}
			}
			sort.Strings(guardedBy)
		}
		tags := []string{}
		if raw, ok := walk.List(one.held, "tags"); ok {
			for _, tag := range raw {
				if text, ok := tag.(string); ok {
					tags = append(tags, text)
				}
			}
		}
		plan.Suites = append(plan.Suites, Suite{
			File: one.relative, FullPath: one.full, Name: name, ID: suiteIDs.Take(name, "Suite"),
			Tags: distinct(tags), Guarded: len(guardedBy) > 0, GuardedBy: guardedBy, Cases: cases,
		})
	}
	return plan, findings, nil
}

// orderedJSON writes a value with its maps' keys in their own order.
func orderedJSON(buffer *bytes.Buffer, held any) {
	switch value := held.(type) {
	case *model.Map:
		buffer.WriteByte('{')
		for index, key := range value.Keys() {
			if index > 0 {
				buffer.WriteByte(',')
			}
			orderedJSON(buffer, key)
			buffer.WriteByte(':')
			orderedJSON(buffer, value.Value(key))
		}
		buffer.WriteByte('}')
	case []any:
		buffer.WriteByte('[')
		for index, item := range value {
			if index > 0 {
				buffer.WriteByte(',')
			}
			orderedJSON(buffer, item)
		}
		buffer.WriteByte(']')
	default:
		encoder := json.NewEncoder(buffer)
		encoder.SetEscapeHTML(false)
		_ = encoder.Encode(value)
		buffer.Truncate(buffer.Len() - 1)
	}
}

// JSON is the plan as spec/test-plan.schema.json describes it: indented UTF-8
// with non-ASCII characters as themselves.
func (plan *Plan) JSON() string {
	compact := &bytes.Buffer{}
	compact.WriteString(`{"planVersion":1,"suites":[`)
	for index, one := range plan.Suites {
		if index > 0 {
			compact.WriteByte(',')
		}
		compact.WriteString(`{"file":`)
		orderedJSON(compact, one.File)
		compact.WriteString(`,"name":`)
		orderedJSON(compact, one.Name)
		compact.WriteString(`,"id":`)
		orderedJSON(compact, one.ID)
		compact.WriteString(`,"tags":`)
		orderedJSON(compact, anyList(one.Tags))
		compact.WriteString(`,"guarded":`)
		orderedJSON(compact, one.Guarded)
		compact.WriteString(`,"guardedBy":`)
		orderedJSON(compact, anyList(one.GuardedBy))
		compact.WriteString(`,"cases":[`)
		for at, held := range one.Cases {
			if at > 0 {
				compact.WriteByte(',')
			}
			compact.WriteString(`{"name":`)
			orderedJSON(compact, held.Name)
			compact.WriteString(`,"id":`)
			orderedJSON(compact, held.ID)
			if held.Outline != "" {
				compact.WriteString(`,"outline":`)
				orderedJSON(compact, held.Outline)
				compact.WriteString(`,"row":`)
				orderedJSON(compact, held.Row)
			}
			compact.WriteString(`,"tags":`)
			orderedJSON(compact, anyList(held.Tags))
			compact.WriteByte('}')
		}
		compact.WriteString("]}")
	}
	compact.WriteString("]}")
	indented := &bytes.Buffer{}
	_ = json.Indent(indented, compact.Bytes(), "", "  ")
	return indented.String()
}

func anyList(values []string) []any {
	out := make([]any, 0, len(values))
	for _, one := range values {
		out = append(out, one)
	}
	return out
}
