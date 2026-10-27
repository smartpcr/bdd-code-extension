package actions

import "github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"

// Target is the environment a run reaches; empty values when none was given.
type Target struct {
	APIURL, LabID, ConnectionFile string
}

// Extension is the {{name}} extension of the suite runtime: its actions, and
// the environment a guarded suite reaches. The Suite Authoring extension
// passes --api-url, --lab-id and --connection-file to every run of a guarded
// suite (bddSuite.lab.*); the generated tests read them as
// BDD_SUITE_OPTION_API_URL and so on. Start hands them to every action as
// request.State (a Target).
var Extension = extension.Extension{
	Name:    "{{name}}",
	Actions: Registrations,
	Options: []extension.Option{
		{Flag: "--api-url", Description: "The environment's API URL."},
		{Flag: "--lab-id", Description: "The environment's id."},
		{Flag: "--connection-file", Description: "The environment's connection file."},
	},
	Start: func(options map[string]string) extension.RunState {
		return extension.RunState{State: Target{APIURL: options["--api-url"], LabID: options["--lab-id"], ConnectionFile: options["--connection-file"]}}
	},
}
