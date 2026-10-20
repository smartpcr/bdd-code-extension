//! The canonical report form, implemented here rather than in the binding.
//!
//! `conformance/report/canonicalise.md` is the definition every runtime
//! implements from. It lives in the test because the shipped output
//! keeps its timestamps: a person reading a report wants them, and only a
//! comparison does not.

mod common;

use std::collections::BTreeMap;

use serde_json::Value;
use suiterun::{exec, model, report, schema, trace::Trace};

/// When, how long, and on what. None of it is behaviour.
const VOLATILE_ATTRIBUTES: [&str; 9] = [
    "start-time",
    "end-time",
    "duration",
    "time",
    "timestamp",
    "hostname",
    "id",
    "clr-version",
    "engine-version",
];

/// A stack trace belongs to the host runtime rather than to the suite, and
/// JUnit puts the same thing in the text of a failure.
const VOLATILE_ELEMENTS: [&str; 1] = ["stack-trace"];
const TEXTLESS_ELEMENTS: [&str; 1] = ["failure"];

/// A small reader, which is all a report needs: elements, attributes and text,
/// with no namespaces and no entities beyond the five.
#[derive(Debug)]
struct Element {
    name: String,
    attributes: Vec<(String, String)>,
    children: Vec<Element>,
    text: String,
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn parse(document: &str) -> Element {
    let characters: Vec<char> = document.chars().collect();
    let mut at = 0usize;
    let mut stack: Vec<Element> = Vec::new();
    let mut root: Option<Element> = None;
    while at < characters.len() {
        if characters[at] != '<' {
            let start = at;
            while at < characters.len() && characters[at] != '<' {
                at += 1;
            }
            let text: String = characters[start..at].iter().collect();
            if let Some(current) = stack.last_mut() {
                current.text.push_str(&unescape(&text));
            }
            continue;
        }
        let start = at;
        while at < characters.len() && characters[at] != '>' {
            at += 1;
        }
        let tag: String = characters[start + 1..at.min(characters.len())].iter().collect();
        at += 1;
        if tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        if let Some(name) = tag.strip_prefix('/') {
            let finished = stack.pop().expect("a closing tag with nothing open");
            assert_eq!(finished.name, name.trim(), "tags are balanced");
            match stack.last_mut() {
                Some(parent) => parent.children.push(finished),
                None => root = Some(finished),
            }
            continue;
        }
        let empty = tag.ends_with('/');
        let body = tag.trim_end_matches('/');
        let mut pieces = body.splitn(2, char::is_whitespace);
        let name = pieces.next().unwrap_or_default().to_string();
        let mut attributes = Vec::new();
        if let Some(rest) = pieces.next() {
            let characters: Vec<char> = rest.chars().collect();
            let mut index = 0usize;
            while index < characters.len() {
                while index < characters.len() && characters[index].is_whitespace() {
                    index += 1;
                }
                let start = index;
                while index < characters.len() && characters[index] != '=' {
                    index += 1;
                }
                if index >= characters.len() {
                    break;
                }
                let key: String = characters[start..index].iter().collect();
                index += 2;
                let start = index;
                while index < characters.len() && characters[index] != '"' {
                    index += 1;
                }
                let value: String = characters[start..index.min(characters.len())].iter().collect();
                index += 1;
                attributes.push((key.trim().to_string(), unescape(&value)));
            }
        }
        let element = Element {
            name,
            attributes,
            children: Vec::new(),
            text: String::new(),
        };
        if empty {
            match stack.last_mut() {
                Some(parent) => parent.children.push(element),
                None => root = Some(element),
            }
        } else {
            stack.push(element);
        }
    }
    root.expect("a report has a root element")
}

/// One line of captured output, with a JSON objects keys put in order.
///
/// What a step captured is behaviour; the order a hash map happened to
/// enumerate it in is not, and four bindings enumerate in four orders.
fn sorted_json_line(line: &str) -> String {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return line.to_string();
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(parsed) => serde_json::to_string(&sorted_json(&parsed)).unwrap_or_else(|_| line.to_string()),
        Err(_) => line.to_string(),
    }
}

/// The same value with every objects keys in ascending order. An array keeps
/// the order it was written in, because that order is behaviour.
fn sorted_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), sorted_json(&map[key])))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted_json).collect()),
        other => other.clone(),
    }
}

fn canonical_lines(element: &Element, depth: usize, lines: &mut Vec<String>) {
    let indent = " ".repeat(2 * depth);
    let mut attributes: Vec<String> = element
        .attributes
        .iter()
        .filter(|(name, _)| !VOLATILE_ATTRIBUTES.contains(&name.as_str()))
        .map(|(name, value)| format!("{name}=\"{}\"", value.replace("\r\n", "\n")))
        .collect();
    attributes.sort();
    let open = if attributes.is_empty() {
        element.name.clone()
    } else {
        format!("{} {}", element.name, attributes.join(" "))
    };
    let children: Vec<&Element> = element
        .children
        .iter()
        .filter(|child| !VOLATILE_ELEMENTS.contains(&child.name.as_str()))
        .collect();
    let text = if TEXTLESS_ELEMENTS.contains(&element.name.as_str()) {
        String::new()
    } else {
        element
            .text
            .replace("\r\n", "\n")
            .trim()
            .split('\n')
            .map(sorted_json_line)
            .collect::<Vec<String>>()
            .join("\n")
    };

    if children.is_empty() && text.is_empty() {
        lines.push(format!("{indent}<{open}/>"));
        return;
    }
    if children.is_empty() {
        let flat: Vec<String> = text.split('\n').map(|line| line.trim_end().to_string()).collect();
        if flat.len() == 1 {
            lines.push(format!("{indent}<{open}>{}</{}>", flat[0], element.name));
            return;
        }
        lines.push(format!("{indent}<{open}>"));
        for line in flat {
            lines.push(format!("{}{line}", " ".repeat(2 * (depth + 1))));
        }
        lines.push(format!("{indent}</{}>", element.name));
        return;
    }
    lines.push(format!("{indent}<{open}>"));
    if !text.is_empty() {
        lines.push(format!("{}{text}", " ".repeat(2 * (depth + 1))));
    }
    for child in children {
        canonical_lines(child, depth + 1, lines);
    }
    lines.push(format!("{indent}</{}>", element.name));
}

fn canonicalise(document: &str) -> String {
    let mut lines = Vec::new();
    canonical_lines(&parse(document), 0, &mut lines);
    lines.join("\n") + "\n"
}

#[test]
fn three_runs_in_both_formats_canonicalise_to_what_is_stored() {
    let corpus = common::corpus();
    let schema = schema::load(&common::corpus_schema()).unwrap();
    let manifest = common::manifest();
    let registry = common::corpus_registry();

    let mut failures: Vec<String> = Vec::new();
    let mut checked = 0usize;
    for entry in manifest["reports"]["entries"].as_array().unwrap() {
        if common::pending_here(entry) {
            common::report_pending("report", entry);
            continue;
        }
        let suite = entry["suite"].as_str().unwrap();
        let path = corpus.join(suite);
        let text = std::fs::read_to_string(&path).unwrap();
        let suite_model = model::load(&text).unwrap().value;
        let options = exec::Options {
            tags: entry
                .get("tags")
                .and_then(Value::as_str)
                .map(|tags| tags.split(',').map(str::to_string).collect())
                .unwrap_or_default(),
            params: Vec::new(),
            dry_run: false,
            record_path: None,
        };
        // Three runs, each canonicalised: all three must be the stored form.
        let mut runs: Vec<String> = Vec::new();
        for _ in 0..3 {
            let mut trace = Trace::default();
            let extensions = exec::RunExtensions::new(&registry, &BTreeMap::new());
            let result = exec::run_file(&path, &suite_model, &schema, &options, &mut trace, &extensions).unwrap();
            let suites = vec![result];
            let produced = match entry["format"].as_str().unwrap_or("NUnit3") {
                "JUnit" => report::junit(&suites),
                _ => report::nunit3(&suites),
            };
            runs.push(canonicalise(&produced));
        }
        let stored = std::fs::read_to_string(corpus.join(entry["expected"].as_str().unwrap()))
            .unwrap()
            .replace("\r\n", "\n");
        checked += 1;
        if runs[1] != runs[0] || runs[2] != runs[0] {
            failures.push(format!("{suite}: three runs canonicalise differently"));
        }
        let produced = runs.swap_remove(0);
        if produced != stored {
            let produced_lines: Vec<&str> = produced.split('\n').collect();
            let stored_lines: Vec<&str> = stored.split('\n').collect();
            let first = (0..produced_lines.len().max(stored_lines.len()))
                .find(|index| produced_lines.get(*index) != stored_lines.get(*index))
                .unwrap_or(0);
            failures.push(format!(
                "{suite} in {} differs at line {}:\n  produced: {}\n  stored:   {}",
                entry["format"].as_str().unwrap_or("NUnit3"),
                first + 1,
                produced_lines.get(first).unwrap_or(&"(nothing)"),
                stored_lines.get(first).unwrap_or(&"(nothing)")
            ));
        }
    }

    println!("  {} of {checked} stored reports match", checked - failures.len());
    assert_eq!(checked, 7, "reports checked");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn two_runs_that_differ_only_in_what_they_measured_canonicalise_equal() {
    let stamped = "<test-run id=\"2\" start-time=\"2026-01-01 00:00:00Z\" duration=\"9.000\" total=\"1\"><test-case id=\"0-1\" name=\"c\" result=\"Passed\" duration=\"9.000\"/></test-run>";
    let later = stamped
        .replace("2026-01-01 00:00:00Z", "2026-06-30 11:22:33Z")
        .replace("9.000", "0.125")
        .replace("id=\"2\"", "id=\"7\"");
    assert_eq!(canonicalise(stamped), canonicalise(&later));
    let changed = stamped.replace("result=\"Passed\"", "result=\"Failed\"");
    assert_ne!(canonicalise(stamped), canonicalise(&changed));
}

#[test]
fn a_stack_trace_and_a_failures_text_are_dropped_and_its_message_is_not() {
    let document = "<r><test-case name=\"c\"><failure><message>why</message><stack-trace>at somewhere:1</stack-trace></failure></test-case></r>";
    let canonical = canonicalise(document);
    assert!(canonical.contains("<message>why</message>"), "{canonical}");
    assert!(!canonical.contains("stack-trace"), "{canonical}");
    let junit = "<r><testcase name=\"c\"><failure message=\"why\">at somewhere:1</failure></testcase></r>";
    let canonical = canonicalise(junit);
    assert!(canonical.contains("message=\"why\""), "{canonical}");
    assert!(!canonical.contains("somewhere"), "{canonical}");
}
