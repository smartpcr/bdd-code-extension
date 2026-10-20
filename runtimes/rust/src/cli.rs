//! The command-line contract, parsed by hand.
//!
//! DEC-Y14 gives four bindings one command line:
//!
//! ```text
//! suiterun lint    --path <glob> [--json] [--strict] [--binding-check] [--binding <name>]
//! suiterun run     --path <glob> [--tags a,b] [--name a*,b?] [--results f.xml]
//!                  [--format nunit3|junit] [--dry-run] [--param n=v] [--trace-file f.json]
//!                  [--progress] [--schema-root dir] [any option an extension declares, with its value]
//! suiterun list    --path <glob> [--tags a,b] [--name a*,b?]
//! suiterun actions [--json]
//! suiterun generate --config <file> [--config <file>...] [--plan] [--check]
//!                   [--provider rust] [--out <dir>]
//! ```
//!
//! A consumer's own `suiterun` calls [`crate::main_with`] with its extensions:
//! each extension's options are taken like the core's valued flags.
//!
//! Parsed by hand rather than with an argument-parsing crate, because the exit
//! codes are part of the contract: 0 when every selected case passed, 1 when a
//! case failed, 2 for a harness or validation error, and an unknown argument is
//! 2 rather than whatever a library happens to use.
//!
//! `--param` and `--trace-file` are not in DEC-Y14, which was written before
//! the runner had either. They are here because the conformance corpus drives
//! both: an execute entry may name parameter overrides, and the trace is what
//! the corpus compares.

use std::collections::BTreeMap;
use std::fmt;

use crate::extension::Registry;

/// What the tool was asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verb {
    Lint,
    Run,
    List,
    Actions,
    Generate,
}

impl fmt::Display for Verb {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Verb::Lint => "lint",
            Verb::Run => "run",
            Verb::List => "list",
            Verb::Actions => "actions",
            Verb::Generate => "generate",
        };
        out.write_str(name)
    }
}

/// Which report a run writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportFormat {
    NUnit3,
    JUnit,
}

/// One parsed command line.
#[derive(Debug, Clone)]
pub struct Options {
    pub verb: Verb,
    pub path: String,
    pub tags: Vec<String>,
    /// `--name` globs (`*`, `?`): a case is selected when its name matches any
    /// of them and the tag filter selects it; none selects every case
    /// (spec/README.md, docs/packages DEC-P05).
    pub names: Vec<String>,
    /// `--progress`: live lines while a run goes, in the shape spec/progress.md
    /// gives.
    pub progress: bool,
    pub results: Option<String>,
    pub trace_file: Option<String>,
    pub format: ReportFormat,
    pub params: Vec<(String, String)>,
    pub binding: String,
    pub json: bool,
    pub strict: bool,
    pub dry_run: bool,
    pub binding_check: bool,
    /// Where the schema and the catalog are read from. Neither is compiled in:
    /// the vocabulary four bindings share is a file, and a binding holding its
    /// own copy is a binding that can disagree with the others quietly.
    pub schema_root: Option<String>,
    pub corpus_root: Option<String>,
    /// The value given for each option an extension declares, by flag.
    pub extension_options: BTreeMap<String, String>,
    /// `generate`: the test configs (spec/test-plan.md), whether to print the
    /// plan, whether to only check, the provider and the output folder.
    pub configs: Vec<String>,
    pub plan: bool,
    pub check: bool,
    pub provider: Option<String>,
    pub out: Option<String>,
}

impl Default for Options {
    /// The options of a plain `run`, for a caller that builds them in code.
    fn default() -> Self {
        Options::new(Verb::Run)
    }
}

impl Options {
    fn new(verb: Verb) -> Self {
        Options {
            verb,
            path: String::new(),
            tags: Vec::new(),
            names: Vec::new(),
            progress: false,
            results: None,
            trace_file: None,
            format: ReportFormat::NUnit3,
            params: Vec::new(),
            binding: "rust".to_string(),
            json: false,
            strict: false,
            dry_run: false,
            binding_check: false,
            schema_root: None,
            corpus_root: None,
            extension_options: BTreeMap::new(),
            configs: Vec::new(),
            plan: false,
            check: false,
            provider: None,
            out: None,
        }
    }
}

/// Why a command line was refused. Always exit 2: a command line nobody can
/// read is a harness error, never a failing case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgError(pub String);

impl fmt::Display for ArgError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.0)
    }
}

const USAGE: &str = "\
suiterun lint    --path <glob> [--json] [--strict] [--binding-check] [--binding <name>]
suiterun run     --path <glob> [--tags a,b] [--name a*,b?] [--results f.xml] [--format nunit3|junit]
                 [--dry-run] [--param name=value] [--trace-file f.json] [--progress]
suiterun list    --path <glob> [--tags a,b] [--name a*,b?]
suiterun actions [--json]
suiterun generate --config <file> [--config <file>...] [--plan] [--check]
                  [--provider rust] [--out <dir>]";

/// The usage text, for a caller that wants to print it beside its own message.
pub fn usage() -> &'static str {
    USAGE
}

/// The usage text, with every option the registry's extensions declare.
pub fn usage_with(registry: &Registry) -> String {
    if registry.options().is_empty() {
        return USAGE.to_string();
    }
    let lines: Vec<String> = registry
        .options()
        .iter()
        .map(|option| format!("                 {} <value>  {}", option.flag, option.description))
        .collect();
    format!("{USAGE}\nOptions the extensions add, for run:\n{}", lines.join("\n"))
}

/// Parse one command line for the core alone, or say why it cannot be read.
pub fn parse<I: IntoIterator<Item = String>>(arguments: I) -> Result<Options, ArgError> {
    parse_with(arguments, &Registry::core())
}

/// Parse one command line, or say why it cannot be read. An option an
/// extension of `registry` declares is a valued flag like the core's.
pub fn parse_with<I: IntoIterator<Item = String>>(arguments: I, registry: &Registry) -> Result<Options, ArgError> {
    let usage = usage_with(registry);
    let usage = usage.as_str();
    let arguments: Vec<String> = arguments.into_iter().collect();
    let verb = match arguments.first().map(|first| first.as_str()) {
        Some("lint") => Verb::Lint,
        Some("run") => Verb::Run,
        Some("list") => Verb::List,
        Some("actions") => Verb::Actions,
        Some("generate") => Verb::Generate,
        Some(other) => return Err(ArgError(format!("there is no verb called {other}.\n{usage}"))),
        None => return Err(ArgError(format!("a verb is needed.\n{usage}"))),
    };

    let mut options = Options::new(verb.clone());
    let mut index = 1;
    while index < arguments.len() {
        let name = arguments[index].as_str();
        // Every flag that takes a value reads the next argument, and says so
        // rather than silently treating the next flag as its value.
        let mut value = |argument: &str| -> Result<String, ArgError> {
            index += 1;
            match arguments.get(index) {
                Some(found) if !found.starts_with("--") => Ok(found.clone()),
                _ => Err(ArgError(format!("{argument} needs a value after it."))),
            }
        };
        // generate takes its own flags and no other; no other verb takes them.
        const GENERATE_FLAGS: [&str; 5] = ["--config", "--plan", "--check", "--provider", "--out"];
        if (verb == Verb::Generate) != GENERATE_FLAGS.contains(&name) {
            return Err(ArgError(format!("{verb} does not take {name}.\n{usage}")));
        }
        match name {
            "--config" => options.configs.push(value("--config")?),
            "--plan" => options.plan = true,
            "--check" => options.check = true,
            "--provider" => options.provider = Some(value("--provider")?),
            "--out" => options.out = Some(value("--out")?),
            "--path" => options.path = value("--path")?,
            "--tags" => {
                let raw = value("--tags")?;
                options.tags = raw
                    .split(',')
                    .map(|tag| tag.trim().to_string())
                    .filter(|tag| !tag.is_empty())
                    .collect();
            }
            "--name" => {
                let raw = value("--name")?;
                options.names.extend(
                    raw.split(',').map(|pattern| pattern.trim().to_string()).filter(|pattern| !pattern.is_empty()),
                );
            }
            "--progress" => options.progress = true,
            "--results" => options.results = Some(value("--results")?),
            "--trace-file" => options.trace_file = Some(value("--trace-file")?),
            "--schema-root" => options.schema_root = Some(value("--schema-root")?),
            "--corpus-root" => options.corpus_root = Some(value("--corpus-root")?),
            "--binding" => options.binding = value("--binding")?,
            "--format" => {
                let raw = value("--format")?;
                options.format = match raw.as_str() {
                    "nunit3" => ReportFormat::NUnit3,
                    "junit" => ReportFormat::JUnit,
                    other => {
                        return Err(ArgError(format!(
                            "--format is nunit3 or junit, not {other}."
                        )))
                    }
                };
            }
            "--param" => {
                let raw = value("--param")?;
                match raw.split_once('=') {
                    Some((name, value)) if !name.is_empty() => {
                        options.params.push((name.to_string(), value.to_string()))
                    }
                    _ => {
                        return Err(ArgError(format!(
                            "--param takes name=value, and {raw} is not one."
                        )))
                    }
                }
            }
            "--json" => options.json = true,
            "--strict" => options.strict = true,
            "--dry-run" => options.dry_run = true,
            "--binding-check" => options.binding_check = true,
            other if registry.options().iter().any(|option| option.flag == other) => {
                let given = value(other)?;
                options.extension_options.insert(other.to_string(), given);
            }
            other => {
                return Err(ArgError(format!(
                    "{verb} does not take {other}.\n{usage}"
                )))
            }
        }
        index += 1;
    }

    // A verb that reads files needs to be told which. `actions` reads the
    // catalog and nothing else, so it is the one that does not.
    if options.verb == Verb::Generate {
        if options.configs.is_empty() {
            return Err(ArgError(format!("generate needs --config.\n{usage}")));
        }
    } else if options.verb != Verb::Actions && options.path.is_empty() {
        return Err(ArgError(format!("{verb} needs --path.\n{usage}")));
    }
    Ok(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn every_verb_parses() {
        assert_eq!(parse(args("lint --path a.yml")).unwrap().verb, Verb::Lint);
        assert_eq!(parse(args("run --path a.yml")).unwrap().verb, Verb::Run);
        assert_eq!(parse(args("list --path a.yml")).unwrap().verb, Verb::List);
        assert_eq!(parse(args("actions")).unwrap().verb, Verb::Actions);
        assert_eq!(parse(args("generate --config c.yaml")).unwrap().verb, Verb::Generate);
    }

    #[test]
    fn generate_takes_its_own_flags_and_no_other_verb_does() {
        let options = parse(args("generate --config a.yaml --config b.yaml --plan --check --provider rust --out gen")).unwrap();
        assert_eq!(options.configs, vec!["a.yaml".to_string(), "b.yaml".to_string()]);
        assert!(options.plan && options.check);
        assert_eq!(options.provider.as_deref(), Some("rust"));
        assert_eq!(options.out.as_deref(), Some("gen"));
        assert!(parse(args("generate --plan")).unwrap_err().0.contains("generate needs --config"));
        assert!(parse(args("generate --config a.yaml --path x")).unwrap_err().0.contains("generate does not take --path"));
        assert!(parse(args("run --path a.yml --config c.yaml")).unwrap_err().0.contains("run does not take --config"));
        assert!(parse(args("lint --path a.yml --plan")).unwrap_err().0.contains("lint does not take --plan"));
    }

    #[test]
    fn the_default_options_are_a_plain_run() {
        let options = Options::default();
        assert_eq!(options.verb, Verb::Run);
        assert!(options.path.is_empty() && options.tags.is_empty() && !options.dry_run);
        assert_eq!(options.binding, "rust");
    }

    #[test]
    fn flags_are_read() {
        let options = parse(args(
            "run --path t/*.yml --tags a,b --results r.xml --format junit --dry-run \
             --param one=1 --param two=x=y --trace-file t.json",
        ))
        .unwrap();
        assert_eq!(options.path, "t/*.yml");
        assert_eq!(options.tags, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(options.results.as_deref(), Some("r.xml"));
        assert_eq!(options.trace_file.as_deref(), Some("t.json"));
        assert_eq!(options.format, ReportFormat::JUnit);
        assert!(options.dry_run);
        assert_eq!(
            options.params,
            vec![
                ("one".to_string(), "1".to_string()),
                ("two".to_string(), "x=y".to_string())
            ]
        );
    }

    #[test]
    fn lint_flags_are_read() {
        let options = parse(args("lint --path a.yml --json --strict --binding-check --binding go")).unwrap();
        assert!(options.json && options.strict && options.binding_check);
        assert_eq!(options.binding, "go");
    }

    #[test]
    fn the_binding_defaults_to_this_one() {
        assert_eq!(parse(args("lint --path a.yml")).unwrap().binding, "rust");
    }

    #[test]
    fn an_unknown_argument_is_refused() {
        let refused = parse(args("run --path a.yml --nonsense")).unwrap_err();
        assert!(refused.0.contains("--nonsense"), "{}", refused.0);
        assert!(refused.0.contains("run"), "{}", refused.0);
    }

    #[test]
    fn an_unknown_verb_is_refused() {
        let refused = parse(args("frobnicate --path a.yml")).unwrap_err();
        assert!(refused.0.contains("frobnicate"), "{}", refused.0);
    }

    #[test]
    fn nothing_at_all_is_refused() {
        assert!(parse(Vec::<String>::new()).unwrap_err().0.contains("a verb is needed"));
    }

    #[test]
    fn a_flag_with_no_value_is_refused() {
        assert!(parse(args("run --path")).unwrap_err().0.contains("--path needs a value"));
        assert!(parse(args("run --path a.yml --tags")).unwrap_err().0.contains("--tags needs a value"));
        assert!(parse(args("run --path a.yml --format")).unwrap_err().0.contains("--format needs a value"));
    }

    #[test]
    fn a_flag_may_not_swallow_the_next_flag() {
        assert!(parse(args("run --path --json")).unwrap_err().0.contains("--path needs a value"));
    }

    #[test]
    fn a_bad_format_is_refused() {
        assert!(parse(args("run --path a.yml --format xml")).unwrap_err().0.contains("nunit3 or junit"));
    }

    #[test]
    fn a_param_without_a_value_is_refused() {
        assert!(parse(args("run --path a.yml --param lonely")).unwrap_err().0.contains("name=value"));
        assert!(parse(args("run --path a.yml --param =x")).unwrap_err().0.contains("name=value"));
    }

    #[test]
    fn the_three_file_verbs_need_a_path() {
        for line in ["lint", "run", "list"] {
            assert!(parse(args(line)).unwrap_err().0.contains("needs --path"), "{line}");
        }
        assert!(parse(args("actions")).is_ok());
    }

    #[test]
    fn a_lab_flag_is_no_longer_the_cores() {
        // The lab options moved to the product's extension; the core refuses them.
        for flag in ["--api-url", "--lab-id", "--connection-file"] {
            let refused = parse(args(&format!("run --path a.yml {flag} x"))).unwrap_err();
            assert!(refused.0.contains(&format!("run does not take {flag}")), "{}", refused.0);
        }
    }

    #[test]
    fn an_extension_option_is_a_valued_flag_and_listed_in_the_usage() {
        struct Region;
        impl crate::extension::Extension for Region {
            fn name(&self) -> &str {
                "region"
            }
            fn options(&self) -> Vec<crate::extension::ExtensionOption> {
                vec![crate::extension::ExtensionOption::new("--region", "Where to run.")]
            }
        }
        let extensions: Vec<std::sync::Arc<dyn crate::extension::Extension>> = vec![std::sync::Arc::new(Region)];
        let registry = Registry::compose(&extensions).unwrap();
        let options = parse_with(args("run --path a.yml --region eu"), &registry).unwrap();
        assert_eq!(options.extension_options.get("--region").map(String::as_str), Some("eu"));
        assert!(parse_with(args("run --path a.yml --region"), &registry).unwrap_err().0.contains("--region needs a value"));
        let refused = parse_with(args("run --path a.yml --nonsense"), &registry).unwrap_err();
        assert!(refused.0.contains("--region <value>  Where to run."), "{}", refused.0);
        assert_eq!(usage_with(&Registry::core()), usage());
    }

    #[test]
    fn the_default_format_is_nunit3() {
        assert_eq!(parse(args("run --path a.yml")).unwrap().format, ReportFormat::NUnit3);
    }

    #[test]
    fn a_verb_prints_as_itself() {
        assert_eq!(Verb::Lint.to_string(), "lint");
        assert_eq!(Verb::Run.to_string(), "run");
        assert_eq!(Verb::List.to_string(), "list");
        assert_eq!(Verb::Actions.to_string(), "actions");
        assert_eq!(Verb::Generate.to_string(), "generate");
        assert!(usage().contains("--binding-check"));
        assert_eq!(ArgError("x".into()).to_string(), "x");
    }
}
