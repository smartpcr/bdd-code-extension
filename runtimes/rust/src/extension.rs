//! The extension API (DEC-S03): how code outside this crate adds to the
//! runtime without editing it. An extension may add any of five things:
//!
//! ```text
//! actions       name to handler, each handler seeing its extension's per-run state
//! context keys  names readable in ${...} and known to dataflow lint
//! options       command-line flags the extension declares and reads
//! rules         extra lint rules, and a limit a case may not exceed at run time
//! env prefix    the prefix of the parameter and record variables
//! ```
//!
//! A consumer builds its own `suiterun` from the runtime and its extensions:
//!
//! ```no_run
//! use std::sync::Arc;
//! # struct Mine;
//! # impl suiterun::extension::Extension for Mine { fn name(&self) -> &str { "mine" } }
//! let extensions: Vec<Arc<dyn suiterun::Extension>> = vec![Arc::new(Mine)];
//! let arguments: Vec<String> = std::env::args().skip(1).collect();
//! let code = suiterun::main_with(arguments, &mut std::io::stdout(), &mut std::io::stderr(), &extensions);
//! std::process::exit(code);
//! ```
//!
//! Several extensions compose into one [`Registry`]; a name two of them define,
//! or one that clashes with the core, is refused when they are composed,
//! before anything runs.

use std::any::Any;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use serde_json::Value;

use crate::actions::{self, Outcome, Request};
use crate::diag::Diagnostic;
use crate::model::Document;
use crate::validate::semantics::Library;

/// What an action runs: the expanded step and the run's context in, a value or
/// a failure out. Shared, because a step runs on a thread of its own.
pub type Handler = Arc<dyn Fn(&Request) -> Outcome + Send + Sync>;

/// What an extension's `start` hands its actions for one run, as
/// [`Request::state`]. An action downcasts it to the type its extension made.
pub type State = Arc<dyn Any + Send + Sync>;

/// One action: the name a step calls, and the handler that runs it.
#[derive(Clone)]
pub struct Action {
    pub name: String,
    pub handler: Handler,
}

impl Action {
    pub fn new(name: impl Into<String>, handler: impl Fn(&Request) -> Outcome + Send + Sync + 'static) -> Self {
        Action {
            name: name.into(),
            handler: Arc::new(handler),
        }
    }
}

impl fmt::Debug for Action {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("Action").field("name", &self.name).finish_non_exhaustive()
    }
}

/// A command-line flag an extension takes, always with a value: `--region <value>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionOption {
    /// With the leading dashes, e.g. `--region`.
    pub flag: String,
    /// One line for the usage text.
    pub description: String,
}

impl ExtensionOption {
    pub fn new(flag: impl Into<String>, description: impl Into<String>) -> Self {
        ExtensionOption {
            flag: flag.into(),
            description: description.into(),
        }
    }
}

/// What a lint rule sees: one parsed suite file and what its imports declare.
pub struct RuleInput<'a> {
    pub document: &'a Document,
    /// Relative to the workspace root, as findings report it.
    pub file: &'a str,
    pub suite: &'a Value,
    pub library: &'a Library,
}

/// A redaction an extension applies to every text a report carries.
pub type Redact = Arc<dyn Fn(&str) -> String + Send + Sync>;

/// What one run of an extension provides, from the values of its options.
#[derive(Default)]
pub struct RunState {
    /// A value for each context key, as `${key}` reads it; a declared key with
    /// no value (and none in the suite's defaults) reads as "".
    pub context: BTreeMap<String, Value>,
    /// Applied to every text a report carries, e.g. to hide secrets.
    pub redact: Option<Redact>,
    /// Handed to this extension's actions as [`Request::state`].
    pub state: Option<State>,
}

/// One extension. Every method has a default that adds nothing, so an
/// extension implements only the parts it adds.
pub trait Extension: Send + Sync {
    /// Shown in errors about this extension.
    fn name(&self) -> &str;
    fn actions(&self) -> Vec<Action> {
        Vec::new()
    }
    fn context_keys(&self) -> Vec<String> {
        Vec::new()
    }
    fn options(&self) -> Vec<ExtensionOption> {
        Vec::new()
    }
    /// The prefix of `PARAM_<NAME>` and `RECORD_PATH`; [`DEFAULT_ENV_PREFIX`]
    /// when no extension sets one.
    fn env_prefix(&self) -> Option<String> {
        None
    }
    /// Findings beyond the core's, positioned like every other (diagnostics.md).
    fn lint(&self, _input: &RuleInput) -> Vec<Diagnostic> {
        Vec::new()
    }
    /// The limit a case runs under, given the one the suite declares; the
    /// smallest any extension gives applies.
    fn case_limit_sec(&self, _suite: &Value, declared_sec: i64) -> i64 {
        declared_sec
    }
    /// Called once per run, with the values given for this extension's
    /// options (flag to value).
    fn start(&self, _options: &BTreeMap<String, String>) -> RunState {
        RunState::default()
    }
}

/// The prefix of the parameter and record variables when no extension sets one.
pub const DEFAULT_ENV_PREFIX: &str = "BDD_SUITE_";

/// The roots every expression may start at, before any extension adds context keys.
pub const CORE_ROOTS: [&str; 6] = ["capture", "param", "var", "row", "timeoutSec", "defaults"];

/// The core's own flags; an extension may not take one.
const CORE_FLAGS: [&str; 13] = [
    "--path",
    "--tags",
    "--results",
    "--trace-file",
    "--schema-root",
    "--corpus-root",
    "--binding",
    "--format",
    "--param",
    "--json",
    "--strict",
    "--dry-run",
    "--binding-check",
];

const THE_CORE: &str = "the core";

/// Why a set of extensions cannot be composed. Always exit 2, before anything runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionError(pub String);

impl fmt::Display for ExtensionError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.0)
    }
}

impl std::error::Error for ExtensionError {}

/// An action as the registry holds it: its handler, and which extension
/// registered it (none for the core).
#[derive(Clone)]
struct Registered {
    handler: Handler,
    owner: Option<usize>,
}

/// Every extension of one runtime, merged and checked: the composite that
/// `run`, `exec` and `validate` are handed instead of a fixed list.
#[derive(Clone)]
pub struct Registry {
    extensions: Vec<Arc<dyn Extension>>,
    actions: BTreeMap<String, Registered>,
    roots: Vec<String>,
    context_keys: Vec<String>,
    options: Vec<ExtensionOption>,
    env_prefix: String,
}

impl fmt::Debug for Registry {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("Registry")
            .field("actions", &self.names())
            .field("roots", &self.roots)
            .field("options", &self.options)
            .field("env_prefix", &self.env_prefix)
            .finish()
    }
}

impl Default for Registry {
    fn default() -> Self {
        Registry::core()
    }
}

impl Registry {
    /// The core alone: `core.*` and `wait`, no extension.
    pub fn core() -> Registry {
        Registry::compose(&[]).expect("the core alone always composes")
    }

    /// Merges extensions over the core, refusing any name defined twice or
    /// taken from the core.
    pub fn compose(extensions: &[Arc<dyn Extension>]) -> Result<Registry, ExtensionError> {
        let mut actions: BTreeMap<String, Registered> = BTreeMap::new();
        for action in actions::core_actions() {
            actions.insert(action.name, Registered { handler: action.handler, owner: None });
        }
        let owner_name = |owner: Option<usize>| match owner {
            Some(index) => extensions[index].name().to_string(),
            None => THE_CORE.to_string(),
        };
        let mut keys: Vec<(String, Option<usize>)> = CORE_ROOTS.iter().map(|key| (key.to_string(), None)).collect();
        let mut flags: Vec<(String, Option<usize>)> = CORE_FLAGS.iter().map(|flag| (flag.to_string(), None)).collect();
        let mut options: Vec<ExtensionOption> = Vec::new();
        let mut env_prefix: Option<(String, usize)> = None;
        for (index, extension) in extensions.iter().enumerate() {
            let name = extension.name();
            for action in extension.actions() {
                if let Some(held) = actions.get(&action.name) {
                    return Err(ExtensionError(format!(
                        "Action {} is defined by both {} and {name}.",
                        action.name,
                        owner_name(held.owner)
                    )));
                }
                actions.insert(action.name, Registered { handler: action.handler, owner: Some(index) });
            }
            for key in extension.context_keys() {
                if let Some((_, held)) = keys.iter().find(|(known, _)| *known == key) {
                    return Err(ExtensionError(format!(
                        "Context key {key} is defined by both {} and {name}.",
                        owner_name(*held)
                    )));
                }
                keys.push((key, Some(index)));
            }
            for option in extension.options() {
                if !is_option_flag(&option.flag) {
                    return Err(ExtensionError(format!(
                        "{name} declares the option {}; an option is --lower-case-words.",
                        option.flag
                    )));
                }
                if let Some((_, held)) = flags.iter().find(|(known, _)| *known == option.flag) {
                    return Err(ExtensionError(format!(
                        "Option {} is defined by both {} and {name}.",
                        option.flag,
                        owner_name(*held)
                    )));
                }
                flags.push((option.flag.clone(), Some(index)));
                options.push(option);
            }
            if let Some(prefix) = extension.env_prefix() {
                if let Some((held, owner)) = &env_prefix {
                    if *held != prefix {
                        return Err(ExtensionError(format!(
                            "{} sets the environment prefix {held} and {name} sets {prefix}.",
                            extensions[*owner].name()
                        )));
                    }
                }
                env_prefix = Some((prefix, index));
            }
        }
        let context_keys: Vec<String> = keys
            .iter()
            .filter(|(_, owner)| owner.is_some())
            .map(|(key, _)| key.clone())
            .collect();
        let roots: Vec<String> = CORE_ROOTS
            .iter()
            .map(|root| root.to_string())
            .chain(context_keys.iter().cloned())
            .collect();
        Ok(Registry {
            extensions: extensions.to_vec(),
            actions,
            roots,
            context_keys,
            options,
            env_prefix: env_prefix
                .map(|(prefix, _)| prefix)
                .unwrap_or_else(|| DEFAULT_ENV_PREFIX.to_string()),
        })
    }

    /// Every action this runtime runs: the core ones, `wait`, and every
    /// extension's, sorted.
    pub fn names(&self) -> Vec<String> {
        self.actions.keys().cloned().collect()
    }

    /// The handler registered for one action name.
    pub fn handler(&self, name: &str) -> Option<&Handler> {
        self.actions.get(name).map(|registered| &registered.handler)
    }

    /// The extensions, in the order they were composed.
    pub fn extensions(&self) -> &[Arc<dyn Extension>] {
        &self.extensions
    }

    /// [`CORE_ROOTS`] and every extension's context keys.
    pub fn roots(&self) -> &[String] {
        &self.roots
    }

    /// The context keys the extensions add, in the order they declared them.
    pub fn context_keys(&self) -> &[String] {
        &self.context_keys
    }

    /// Every option the extensions declare, in the order they declared them.
    pub fn options(&self) -> &[ExtensionOption] {
        &self.options
    }

    /// The prefix of `PARAM_<NAME>` and `RECORD_PATH`.
    pub fn env_prefix(&self) -> &str {
        &self.env_prefix
    }

    /// Every extension's lint findings for one file.
    pub fn lint(&self, input: &RuleInput) -> Vec<Diagnostic> {
        self.extensions.iter().flat_map(|extension| extension.lint(input)).collect()
    }

    /// The limit a case runs under: the smallest any extension gives, never
    /// more than the suite declares.
    pub fn case_limit_sec(&self, suite: &Value, declared_sec: i64) -> i64 {
        self.extensions
            .iter()
            .fold(declared_sec, |limit, extension| limit.min(extension.case_limit_sec(suite, declared_sec)))
    }

    /// Starts every extension with its own options' values, once per run.
    pub fn start(&self, values: &BTreeMap<String, String>) -> Started {
        let mut states: Vec<Option<State>> = Vec::new();
        let mut context: BTreeMap<String, Value> = BTreeMap::new();
        let mut redactors: Vec<Redact> = Vec::new();
        for extension in &self.extensions {
            let flags: Vec<String> = extension.options().into_iter().map(|option| option.flag).collect();
            let own: BTreeMap<String, String> = values
                .iter()
                .filter(|(flag, _)| flags.contains(flag))
                .map(|(flag, value)| (flag.clone(), value.clone()))
                .collect();
            let run = extension.start(&own);
            let declared = extension.context_keys();
            // Only the values given for keys this extension declares: a declared
            // key with none reads as "" unless the suite's defaults name it (exec).
            for (key, value) in run.context {
                if declared.contains(&key) {
                    context.insert(key, value);
                }
            }
            if let Some(redact) = run.redact {
                redactors.push(redact);
            }
            states.push(run.state);
        }
        Started {
            states,
            context,
            redactors,
        }
    }

    /// The state the extension that registered `action` started with, if any.
    pub(crate) fn state_for(&self, action: &str, started: &Started) -> Option<State> {
        let owner = self.actions.get(action)?.owner?;
        started.states.get(owner).cloned().flatten()
    }
}

fn is_option_flag(flag: &str) -> bool {
    let Some(rest) = flag.strip_prefix("--") else {
        return false;
    };
    let mut characters = rest.chars();
    matches!(characters.next(), Some(first) if first.is_ascii_lowercase())
        && characters.all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
}

/// One run's started extensions: each one's state, the context values, and
/// one redaction over all of them.
#[derive(Clone, Default)]
pub struct Started {
    states: Vec<Option<State>>,
    context: BTreeMap<String, Value>,
    redactors: Vec<Redact>,
}

impl Started {
    /// The value each context key was given for this run.
    pub fn context(&self) -> &BTreeMap<String, Value> {
        &self.context
    }

    /// One text with every extension's redaction applied.
    pub fn redact(&self, text: &str) -> String {
        self.redactors
            .iter()
            .fold(text.to_string(), |current, redact| redact(&current))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Named {
        name: &'static str,
        actions: Vec<&'static str>,
        keys: Vec<&'static str>,
        flags: Vec<&'static str>,
        prefix: Option<&'static str>,
    }

    impl Named {
        fn new(name: &'static str) -> Self {
            Named { name, actions: vec![], keys: vec![], flags: vec![], prefix: None }
        }
    }

    impl Extension for Named {
        fn name(&self) -> &str {
            self.name
        }
        fn actions(&self) -> Vec<Action> {
            self.actions.iter().map(|name| Action::new(*name, |_| Ok(json!(null)))).collect()
        }
        fn context_keys(&self) -> Vec<String> {
            self.keys.iter().map(|key| key.to_string()).collect()
        }
        fn options(&self) -> Vec<ExtensionOption> {
            self.flags.iter().map(|flag| ExtensionOption::new(*flag, "x")).collect()
        }
        fn env_prefix(&self) -> Option<String> {
            self.prefix.map(str::to_string)
        }
        fn case_limit_sec(&self, _suite: &Value, declared_sec: i64) -> i64 {
            declared_sec.min(10)
        }
        fn start(&self, options: &BTreeMap<String, String>) -> RunState {
            RunState {
                context: self
                    .keys
                    .iter()
                    .map(|key| (key.to_string(), json!(options.values().next().cloned().unwrap_or_default())))
                    .chain([("undeclared".to_string(), json!("ignored"))])
                    .collect(),
                redact: Some(Arc::new(|text: &str| text.replace("secret", "***"))),
                state: Some(Arc::new(self.name.to_string())),
            }
        }
    }

    fn compose(extensions: Vec<Named>) -> Result<Registry, ExtensionError> {
        let list: Vec<Arc<dyn Extension>> = extensions.into_iter().map(|e| Arc::new(e) as Arc<dyn Extension>).collect();
        Registry::compose(&list)
    }

    #[test]
    fn the_core_alone_has_the_core_actions_and_the_default_prefix() {
        let core = Registry::core();
        assert_eq!(core.names(), vec!["core.fail", "core.noop", "core.record", "core.set", "core.sleep", "wait"]);
        assert_eq!(core.env_prefix(), DEFAULT_ENV_PREFIX);
        assert_eq!(core.roots(), CORE_ROOTS.map(str::to_string).as_slice());
        assert!(core.context_keys().is_empty() && core.options().is_empty());
        assert_eq!(core.case_limit_sec(&json!({}), 30), 30);
    }

    #[test]
    fn extensions_add_actions_keys_options_and_a_prefix() {
        let mut one = Named::new("one");
        one.actions = vec!["one.act"];
        one.keys = vec!["region"];
        one.flags = vec!["--region"];
        one.prefix = Some("ONE_");
        let registry = compose(vec![one]).unwrap();
        assert!(registry.names().contains(&"one.act".to_string()));
        assert_eq!(registry.context_keys(), &["region".to_string()]);
        assert!(registry.roots().contains(&"region".to_string()));
        assert_eq!(registry.options()[0].flag, "--region");
        assert_eq!(registry.env_prefix(), "ONE_");
        assert_eq!(registry.case_limit_sec(&json!({}), 30), 10);
        let started = registry.start(&BTreeMap::from([("--region".to_string(), "eu".to_string()), ("--other".to_string(), "x".to_string())]));
        assert_eq!(started.context().get("region"), Some(&json!("eu")));
        assert!(!started.context().contains_key("undeclared"));
        assert_eq!(started.redact("a secret"), "a ***");
        let state = registry.state_for("one.act", &started).unwrap();
        assert_eq!(state.downcast_ref::<String>().map(String::as_str), Some("one"));
        assert!(registry.state_for("core.noop", &started).is_none());
    }

    #[test]
    fn a_name_defined_twice_is_refused_naming_both() {
        let mut one = Named::new("one");
        one.actions = vec!["same"];
        let mut two = Named::new("two");
        two.actions = vec!["same"];
        assert_eq!(compose(vec![one, two]).unwrap_err().0, "Action same is defined by both one and two.");
        let mut core = Named::new("late");
        core.actions = vec!["wait"];
        assert_eq!(compose(vec![core]).unwrap_err().0, "Action wait is defined by both the core and late.");
        let mut key = Named::new("keys");
        key.keys = vec!["capture"];
        assert_eq!(compose(vec![key]).unwrap_err().0, "Context key capture is defined by both the core and keys.");
        let mut flag = Named::new("flags");
        flag.flags = vec!["--path"];
        assert_eq!(compose(vec![flag]).unwrap_err().0, "Option --path is defined by both the core and flags.");
        let mut bad = Named::new("bad");
        bad.flags = vec!["-Region"];
        assert_eq!(compose(vec![bad]).unwrap_err().0, "bad declares the option -Region; an option is --lower-case-words.");
        let mut a = Named::new("a");
        a.prefix = Some("A_");
        let mut b = Named::new("b");
        b.prefix = Some("B_");
        assert_eq!(compose(vec![a, b]).unwrap_err().0, "a sets the environment prefix A_ and b sets B_.");
        let mut same_a = Named::new("a");
        same_a.prefix = Some("A_");
        let mut same_b = Named::new("b");
        same_b.prefix = Some("A_");
        assert_eq!(compose(vec![same_a, same_b]).unwrap().env_prefix(), "A_");
    }
}
