//! One finding, and the two ways of writing a set of them.
//!
//! The codes and the positions are the contract between four bindings; the
//! message wording is not (test/e2e/schema/diagnostics.md). Everything here
//! follows from that: the sort is total so that two bindings that find the same
//! problems write byte-identical JSON, and paths are relative with forward
//! slashes so that three operating systems produce one string.

use std::cmp::Ordering;
use std::fmt;

/// Whether a finding fails the validation, or only fails it under `--strict`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
        }
    }
}

impl fmt::Display for Severity {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.as_str())
    }
}

/// A one-based position in a file. Zero would be a position no editor can go to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Position {
    pub line: usize,
    pub column: usize,
}

impl Position {
    pub fn new(line: usize, column: usize) -> Self {
        Position {
            line: line.max(1),
            column: column.max(1),
        }
    }

    /// The position of a file that could not be read far enough to have one.
    pub fn start() -> Self {
        Position { line: 1, column: 1 }
    }
}

/// One thing wrong with one suite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: String,
    pub severity: Severity,
    pub file: String,
    pub position: Position,
    pub message: String,
    pub suggestion: Option<String>,
}

impl Diagnostic {
    pub fn error(code: &str, file: &str, position: Position, message: impl Into<String>) -> Self {
        Diagnostic {
            code: code.to_string(),
            severity: Severity::Error,
            file: file.to_string(),
            position,
            message: message.into(),
            suggestion: None,
        }
    }

    pub fn warning(code: &str, file: &str, position: Position, message: impl Into<String>) -> Self {
        Diagnostic {
            severity: Severity::Warning,
            ..Diagnostic::error(code, file, position, message)
        }
    }

    /// The nearest legal spelling, when there is one. Never part of what two
    /// bindings are compared on: it is help, and help may differ.
    pub fn suggest(mut self, suggestion: impl Into<String>) -> Self {
        let suggestion = suggestion.into();
        if !suggestion.is_empty() {
            self.suggestion = Some(suggestion);
        }
        self
    }

    /// `file:line:column  CODE  message`, with the suggestion indented under it.
    pub fn to_human(&self) -> String {
        let head = format!(
            "{}:{}:{}  {}  {}",
            self.file, self.position.line, self.position.column, self.code, self.message
        );
        match &self.suggestion {
            Some(suggestion) => format!("{head}\n    {suggestion}"),
            None => head,
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        let mut map = serde_json::Map::new();
        map.insert("code".into(), self.code.clone().into());
        map.insert("severity".into(), self.severity.as_str().into());
        map.insert("file".into(), self.file.clone().into());
        map.insert("line".into(), self.position.line.into());
        map.insert("column".into(), self.position.column.into());
        map.insert("message".into(), self.message.clone().into());
        if let Some(suggestion) = &self.suggestion {
            map.insert("suggestion".into(), suggestion.clone().into());
        }
        serde_json::Value::Object(map)
    }
}

/// File, then line, then column, then code, then message. Total, so that two
/// bindings cannot disagree by ordering.
pub fn compare(left: &Diagnostic, right: &Diagnostic) -> Ordering {
    left.file
        .cmp(&right.file)
        .then(left.position.line.cmp(&right.position.line))
        .then(left.position.column.cmp(&right.position.column))
        .then(left.code.cmp(&right.code))
        .then(left.message.cmp(&right.message))
}

/// The same set of findings, in the one order every binding writes them in,
/// each once.
///
/// Two findings with the same file, position, code and message are one
/// finding, as in the PowerShell binding. The structural pass checks a step's
/// common fields twice (against the envelope, then against its action's
/// branch), so a refused `why` would otherwise be reported twice.
pub fn sorted(mut findings: Vec<Diagnostic>) -> Vec<Diagnostic> {
    findings.sort_by(compare);
    findings.dedup_by(|later, kept| compare(later, kept) == Ordering::Equal);
    findings
}

/// Whether a set of findings fails the validation. A warning only does under
/// `--strict`.
pub fn fails(findings: &[Diagnostic], strict: bool) -> bool {
    findings
        .iter()
        .any(|finding| finding.severity == Severity::Error || strict)
}

/// The array defined by diagnostic.schema.json.
pub fn to_json_array(findings: &[Diagnostic]) -> serde_json::Value {
    serde_json::Value::Array(findings.iter().map(Diagnostic::to_json).collect())
}

/// A path as a diagnostic carries it: relative to the repository root when it
/// is under it, and with forward slashes wherever it came from.
pub fn relative_path(full: &std::path::Path, root: &std::path::Path) -> String {
    let text = full
        .strip_prefix(root)
        .map(|stripped| stripped.to_string_lossy().to_string())
        .unwrap_or_else(|_| full.to_string_lossy().to_string());
    text.replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn at(code: &str, file: &str, line: usize, column: usize) -> Diagnostic {
        Diagnostic::error(code, file, Position::new(line, column), "something")
    }

    #[test]
    fn a_position_is_one_based() {
        assert_eq!(Position::new(0, 0), Position { line: 1, column: 1 });
        assert_eq!(Position::start(), Position { line: 1, column: 1 });
        assert_eq!(Position::new(4, 7), Position { line: 4, column: 7 });
    }

    #[test]
    fn the_sort_is_total_and_in_that_order() {
        let findings = sorted(vec![
            at("E102", "b.yml", 1, 1),
            at("E101", "a.yml", 2, 1),
            at("E101", "a.yml", 1, 2),
            at("E101", "a.yml", 1, 1),
            at("E100", "a.yml", 1, 1),
        ]);
        let order: Vec<String> = findings
            .iter()
            .map(|finding| format!("{}@{}:{}:{}", finding.code, finding.file, finding.position.line, finding.position.column))
            .collect();
        assert_eq!(
            order,
            vec![
                "E100@a.yml:1:1",
                "E101@a.yml:1:1",
                "E101@a.yml:1:2",
                "E101@a.yml:2:1",
                "E102@b.yml:1:1",
            ]
        );
    }

    #[test]
    fn the_same_finding_twice_is_reported_once() {
        let findings = sorted(vec![
            Diagnostic::error("E103", "a.yml", Position::new(6, 14), "refused"),
            Diagnostic::error("E103", "a.yml", Position::new(6, 14), "refused"),
            Diagnostic::error("E103", "a.yml", Position::new(6, 14), "refused differently"),
        ]);
        let messages: Vec<&str> = findings
            .iter()
            .map(|finding| finding.message.as_str())
            .collect();
        assert_eq!(messages, vec!["refused", "refused differently"]);
    }

    #[test]
    fn the_message_breaks_a_tie_nothing_else_can() {
        let mut first = at("E101", "a.yml", 1, 1);
        first.message = "aaa".into();
        let mut second = at("E101", "a.yml", 1, 1);
        second.message = "bbb".into();
        assert_eq!(compare(&first, &second), Ordering::Less);
        assert_eq!(compare(&second, &first), Ordering::Greater);
        assert_eq!(compare(&first, &first.clone()), Ordering::Equal);
    }

    #[test]
    fn a_warning_only_fails_under_strict() {
        let warning = vec![Diagnostic::warning("W301", "a.yml", Position::start(), "unread")];
        assert!(!fails(&warning, false));
        assert!(fails(&warning, true));
        let error = vec![at("E101", "a.yml", 1, 1)];
        assert!(fails(&error, false));
        assert!(fails(&error, true));
        assert!(!fails(&[], true));
    }

    #[test]
    fn the_human_line_names_the_place_then_the_code() {
        let finding = at("E101", "a.yml", 4, 5).suggest("Did you mean timeoutSec");
        assert_eq!(
            finding.to_human(),
            "a.yml:4:5  E101  something\n    Did you mean timeoutSec"
        );
        assert_eq!(at("E101", "a.yml", 4, 5).to_human(), "a.yml:4:5  E101  something");
    }

    #[test]
    fn an_empty_suggestion_is_no_suggestion() {
        assert!(at("E101", "a.yml", 1, 1).suggest("").suggestion.is_none());
    }

    #[test]
    fn the_json_is_the_shape_the_schema_defines() {
        let json = at("E104", "a.yml", 6, 17).suggest("fixture.suspend").to_json();
        assert_eq!(json["code"], "E104");
        assert_eq!(json["severity"], "error");
        assert_eq!(json["file"], "a.yml");
        assert_eq!(json["line"], 6);
        assert_eq!(json["column"], 17);
        assert_eq!(json["suggestion"], "fixture.suspend");
        let bare = at("E104", "a.yml", 6, 17).to_json();
        assert!(bare.get("suggestion").is_none());
        assert_eq!(to_json_array(&[at("E100", "a.yml", 1, 1)]).as_array().unwrap().len(), 1);
        assert_eq!(to_json_array(&[]).as_array().unwrap().len(), 0);
    }

    #[test]
    fn severity_prints_as_the_word_the_schema_uses() {
        assert_eq!(Severity::Error.to_string(), "error");
        assert_eq!(Severity::Warning.to_string(), "warning");
    }

    #[test]
    fn a_path_is_relative_with_forward_slashes() {
        let root = Path::new("/repo");
        assert_eq!(relative_path(&root.join("test").join("a.yml"), root), "test/a.yml");
        assert_eq!(relative_path(Path::new("/elsewhere/a.yml"), root), "/elsewhere/a.yml");
    }
}
