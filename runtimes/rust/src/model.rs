//! One suite file, read once, as a value and as a map of where everything is.
//!
//! Two things come out of a parse. The value is what the schema is checked
//! against and what every pass walks. The position map is what turns a finding
//! into a place an editor can go to: a JSON pointer to the line and column of
//! the key that names a value and of the value itself, because a structural
//! finding points at the misspelled key and a dataflow finding points at the
//! value that carries the reference.

use std::collections::HashMap;

use serde_json::{Map, Value};
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::{Marker, TScalarStyle};

use crate::diag::Position;

/// Where a value and the key that names it are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodePosition {
    pub key: Position,
    pub value: Position,
}

impl NodePosition {
    fn both(position: Position) -> Self {
        NodePosition {
            key: position,
            value: position,
        }
    }
}

/// A parsed suite: what it says, and where each part of it is written.
#[derive(Debug, Clone)]
pub struct Document {
    pub value: Value,
    pub positions: HashMap<String, NodePosition>,
}

impl Document {
    /// The position of one pointer, or the start of the file when the pointer
    /// names nothing. A finding always has somewhere to point.
    pub fn at(&self, pointer: &str) -> NodePosition {
        self.positions
            .get(pointer)
            .copied()
            .unwrap_or_else(|| NodePosition::both(Position::start()))
    }

    /// The value one pointer names, if the document holds it.
    pub fn get(&self, pointer: &str) -> Option<&Value> {
        if pointer.is_empty() {
            return Some(&self.value);
        }
        self.value.pointer(pointer)
    }
}

/// Why a file could not be read as a suite. Always `E100`: nothing below can be
/// checked, so there is no second finding to report beside it.
#[derive(Debug, Clone)]
pub struct LoadError {
    pub message: String,
    pub position: Position,
}

/// One pointer segment, escaped the way JSON pointers escape.
pub fn escape<S: AsRef<str>>(segment: S) -> String {
    let segment = segment.as_ref();
    segment.replace('~', "~0").replace('/', "~1")
}

/// A pointer built from a parent and one more segment.
pub fn child(parent: &str, segment: &str) -> String {
    format!("{parent}/{}", escape(segment))
}

struct Collected {
    events: Vec<(Event, Marker)>,
}

impl MarkedEventReceiver for Collected {
    fn on_event(&mut self, event: Event, mark: Marker) {
        self.events.push((event, mark));
    }
}

fn position_of(mark: &Marker) -> Position {
    // yaml-rust2 reports the column as a zero-based offset while the line is
    // one-based. Every position in a diagnostic is one-based in both, which is
    // what an editor and the PowerShell binding both use.
    Position::new(mark.line(), mark.col() + 1)
}

/// Where a node begins, as a reader would say it.
///
/// The parser marks the start of a block mapping at the colon that told it the
/// line was a mapping, and the start of a block sequence at the first thing
/// inside it. Neither is where the node begins to a person reading the file, so
/// a container takes the position of the first thing it contains, which for a
/// mapping is its first key.
fn node_marker(events: &[(Event, Marker)], at: usize) -> Marker {
    // The earliest of the container's own mark and the first thing inside it.
    // A flow mapping is marked at its brace, which is where it begins; a block
    // mapping is marked at the colon that told the parser what it was, which is
    // after its first key. Taking the earlier of the two is right for both,
    // without asking which style the file used.
    let mut index = at;
    let mut earliest = match events.get(at) {
        Some((_, mark)) => *mark,
        None => return events[at].1,
    };
    loop {
        match events.get(index) {
            Some((Event::MappingStart(_, _), mark)) | Some((Event::SequenceStart(_, _), mark)) => {
                if (mark.line(), mark.col()) < (earliest.line(), earliest.col()) {
                    earliest = *mark;
                }
                index += 1;
            }
            Some((_, mark)) => {
                if (mark.line(), mark.col()) < (earliest.line(), earliest.col()) {
                    earliest = *mark;
                }
                return earliest;
            }
            None => return earliest,
        }
    }
}

/// A plain YAML scalar as the value it resolves to.
///
/// The core schema: `null` and `~` and nothing at all are null, `true` and
/// `false` are booleans, a whole number is an integer and a decimal one is a
/// float. Anything quoted is a string whatever it looks like, which is what
/// makes `timeoutSec: "30"` a type error rather than a number.
fn scalar_value(text: &str, style: TScalarStyle, tag: &Option<Tag>) -> Value {
    if let Some(tag) = tag {
        if tag.handle == "tag:yaml.org,2002:" {
            match tag.suffix.as_str() {
                "str" => return Value::String(text.to_string()),
                "null" => return Value::Null,
                "bool" => {
                    return Value::Bool(matches!(text, "true" | "True" | "TRUE"));
                }
                _ => {}
            }
        }
    }
    if style != TScalarStyle::Plain {
        return Value::String(text.to_string());
    }
    match text {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" => return Value::Bool(true),
        "false" | "False" | "FALSE" => return Value::Bool(false),
        _ => {}
    }
    if let Ok(number) = text.parse::<i64>() {
        return Value::Number(number.into());
    }
    if let Some(rest) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        if let Ok(number) = i64::from_str_radix(rest, 16) {
            return Value::Number(number.into());
        }
    }
    if let Ok(number) = text.parse::<f64>() {
        // A float that is not finite has no JSON spelling, so it stays the text
        // it was written as rather than becoming something unrepresentable.
        if let Some(number) = serde_json::Number::from_f64(number) {
            return Value::Number(number);
        }
    }
    Value::String(text.to_string())
}

/// Where the block sequence entry at or after `from_line` is written.
///
/// An entry with nothing after its dash is reported by the parser at the *next*
/// entry's content, because that is where the scanner was when it decided the
/// entry was empty. A reader would say the entry is at its own dash, and so
/// would every other binding, so the dash is found in the text instead.
fn dash_position(lines: &[&str], from_line: usize, column: usize) -> Option<Position> {
    if column == 0 {
        return None;
    }
    for (offset, text) in lines.iter().enumerate().skip(from_line.saturating_sub(1)) {
        let characters: Vec<char> = text.chars().collect();
        if characters.len() < column {
            continue;
        }
        let before_is_blank = characters[..column - 1].iter().all(|found| *found == ' ');
        if before_is_blank && characters[column - 1] == '-' {
            return Some(Position::new(offset + 1, column + 1));
        }
    }
    None
}

struct Builder<'a> {
    events: &'a [(Event, Marker)],
    lines: &'a [&'a str],
    at: usize,
    positions: HashMap<String, NodePosition>,
}

impl<'a> Builder<'a> {
    fn peek(&self) -> Option<&(Event, Marker)> {
        self.events.get(self.at)
    }

    /// One node and everything under it, recording where each part of it is.
    fn build(&mut self, pointer: &str) -> Value {
        let (event, mark) = match self.events.get(self.at) {
            Some(found) => (found.0.clone(), found.1),
            None => return Value::Null,
        };
        self.at += 1;
        match event {
            Event::Scalar(text, style, _, tag) => {
                let _ = mark;
                scalar_value(&text, style, &tag)
            }
            Event::SequenceStart(_, _) => {
                let mut items: Vec<Value> = Vec::new();
                let mut index = 0usize;
                // The dash column of this sequence, and the line to look for
                // the next one from. Only an entry with nothing after its dash
                // needs either.
                let dash_column = mark.col() + 1;
                let mut search_from = mark.line();
                loop {
                    match self.peek() {
                        Some((Event::SequenceEnd, _)) | None => {
                            self.at += 1;
                            break;
                        }
                        Some(_) => {
                            let empty_entry = matches!(
                                self.events.get(self.at),
                                Some((Event::Scalar(text, TScalarStyle::Plain, _, None), _)) if text.is_empty()
                            );
                            let position = if empty_entry {
                                dash_position(self.lines, search_from, dash_column)
                                    .unwrap_or_else(|| position_of(&node_marker(self.events, self.at)))
                            } else {
                                position_of(&node_marker(self.events, self.at))
                            };
                            search_from = position.line + 1;
                            let item_pointer = format!("{pointer}/{index}");
                            self.positions
                                .insert(item_pointer.clone(), NodePosition::both(position));
                            items.push(self.build(&item_pointer));
                            index += 1;
                        }
                    }
                }
                Value::Array(items)
            }
            Event::MappingStart(_, _) => {
                let mut map = Map::new();
                loop {
                    let key_mark = match self.peek() {
                        Some((Event::MappingEnd, _)) | None => {
                            self.at += 1;
                            break;
                        }
                        Some((_, key_mark)) => *key_mark,
                    };
                    // A key is a scalar; anything else is not a suite, and the
                    // schema is what says so. Read it as text either way, so
                    // that the walk does not stop here.
                    let key = match &self.events[self.at].0 {
                        Event::Scalar(text, _, _, _) => text.clone(),
                        _ => String::new(),
                    };
                    self.at += 1;
                    let value_position = match self.peek() {
                        Some(_) => position_of(&node_marker(self.events, self.at)),
                        None => position_of(&key_mark),
                    };
                    let key_pointer = child(pointer, &key);
                    self.positions.insert(
                        key_pointer.clone(),
                        NodePosition {
                            key: position_of(&key_mark),
                            value: value_position,
                        },
                    );
                    let value = self.build(&key_pointer);
                    map.insert(key, value);
                }
                Value::Object(map)
            }
            // An alias resolves to nothing here. The suite format has no use
            // for one, and a suite that uses one is a suite two bindings would
            // read differently.
            Event::Alias(_) => Value::Null,
            _ => Value::Null,
        }
    }
}

/// Read one suite file.
pub fn load(text: &str) -> Result<Document, LoadError> {
    let mut collected = Collected { events: Vec::new() };
    let mut parser = Parser::new_from_str(text);
    parser
        .load(&mut collected, false)
        .map_err(|failure| LoadError {
            message: failure.to_string(),
            // The start of the file, not where this parser stopped. Four YAML
            // parsers stop in four places on the same broken file, and a
            // position two bindings cannot agree on is not a contract.
            position: Position::start(),
        })?;

    // StreamStart, DocumentStart, ...the document..., DocumentEnd, StreamEnd.
    let start = collected
        .events
        .iter()
        .position(|(event, _)| matches!(event, Event::DocumentStart))
        .map(|at| at + 1);
    let start = match start {
        Some(start) if start < collected.events.len() => start,
        _ => {
            return Err(LoadError {
                message: "the file holds no YAML document.".to_string(),
                position: Position::start(),
            })
        }
    };

    let root_position = position_of(&node_marker(&collected.events, start));
    let lines: Vec<&str> = text.split('\n').map(|line| line.trim_end_matches('\r')).collect();
    let mut builder = Builder {
        events: &collected.events,
        lines: &lines,
        at: start,
        positions: HashMap::new(),
    };
    let value = builder.build("");
    let mut positions = builder.positions;
    positions.insert(String::new(), NodePosition::both(root_position));
    Ok(Document { value, positions })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mapping_records_the_key_and_the_value_apart() {
        let document = load("suite: typos\ntests:\n  - name: a\n    timeout: 30\n").unwrap();
        assert_eq!(document.value["suite"], "typos");
        let suite = document.at("/suite");
        assert_eq!(suite.key, Position::new(1, 1));
        assert_eq!(suite.value, Position::new(1, 8));
        let timeout = document.at("/tests/0/timeout");
        assert_eq!(timeout.key, Position::new(4, 5));
        assert_eq!(timeout.value, Position::new(4, 14));
    }

    #[test]
    fn a_sequence_item_is_at_its_own_dash() {
        let document = load("tests:\n  - name: a\n  - name: b\n").unwrap();
        assert_eq!(document.at("/tests/0").value, Position::new(2, 5));
        assert_eq!(document.at("/tests/1").value, Position::new(3, 5));
        assert_eq!(document.value["tests"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn scalars_resolve_to_the_types_the_schema_checks() {
        let document = load(
            "a: 30\nb: '30'\nc: 1.5\nd: true\ne: false\nf: null\ng: ~\nh:\ni: text\nj: \"true\"\n",
        )
        .unwrap();
        assert_eq!(document.value["a"], 30);
        assert_eq!(document.value["b"], "30");
        assert_eq!(document.value["c"], 1.5);
        assert_eq!(document.value["d"], true);
        assert_eq!(document.value["e"], false);
        assert!(document.value["f"].is_null());
        assert!(document.value["g"].is_null());
        assert!(document.value["h"].is_null());
        assert_eq!(document.value["i"], "text");
        assert_eq!(document.value["j"], "true");
    }

    #[test]
    fn a_key_with_a_slash_or_a_tilde_is_escaped() {
        assert_eq!(escape("a/b"), "a~1b");
        assert_eq!(escape("a~b"), "a~0b");
        assert_eq!(child("/x", "a/b"), "/x/a~1b");
    }

    #[test]
    fn a_file_that_is_not_yaml_says_where_it_stopped() {
        let refused = load("suite: [unclosed\ntests: 1").unwrap_err();
        assert!(refused.position.line >= 1);
        assert!(!refused.message.is_empty());
    }

    #[test]
    fn an_empty_file_holds_no_document() {
        assert!(load("").is_err());
        assert!(load("# only a comment\n").is_err());
    }

    #[test]
    fn a_document_that_is_a_list_still_parses() {
        let document = load("- just\n- a\n- list\n").unwrap();
        assert!(document.value.is_array());
    }

    #[test]
    fn a_nested_shape_keeps_every_pointer() {
        let document = load("tests:\n  - steps:\n      - action: core.noop\n        captureAs: x\n").unwrap();
        assert_eq!(document.get("/tests/0/steps/0/action").unwrap(), "core.noop");
        assert_eq!(document.at("/tests/0/steps/0/captureAs").key, Position::new(4, 9));
        assert_eq!(document.at("/tests/0/steps/0/captureAs").value, Position::new(4, 20));
        assert_eq!(document.at("").value, Position::new(1, 1));
        assert!(document.get("/tests/9").is_none());
        assert!(document.get("").is_some());
    }

    #[test]
    fn a_flow_mapping_is_read_like_a_block_one() {
        let document = load("params:\n  - { name: region, default: west }\n").unwrap();
        assert_eq!(document.get("/params/0/name").unwrap(), "region");
        assert_eq!(document.at("/params/0/name").key, Position::new(2, 7));
    }
}
