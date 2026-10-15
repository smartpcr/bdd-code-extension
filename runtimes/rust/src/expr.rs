//! The expression language, from `${...}`.
//!
//! A tokeniser, a Pratt parser and a closed list of functions. The grammar is
//! described in the design; `conformance/expressions/cases.yaml` is
//! the specification, and when the two disagree the table is what four bindings
//! are held to.
//!
//! Two rules decide what a string becomes. A string that is exactly one
//! expression yields that expression's value with its type intact, so
//! `${timeoutSec}` is a number. A string with an expression inside other text
//! is substituted into and stays a string.

use std::collections::BTreeMap;

use serde_json::{Number, Value};

use crate::value as values;

/// Every function the language has, and how many arguments each takes.
///
/// Closed because four bindings must agree; an open list would drift to
/// whatever each language's standard library happens to call things. Matched
/// case-sensitively, so `LOWER` is `E306` rather than a second spelling.
pub struct FunctionSpec {
    pub min: usize,
    pub max: usize,
    pub deterministic: bool,
}

pub fn functions() -> BTreeMap<&'static str, FunctionSpec> {
    let mut map = BTreeMap::new();
    let mut add = |name, min, max, deterministic| {
        map.insert(
            name,
            FunctionSpec {
                min,
                max,
                deterministic,
            },
        );
    };
    add("lower", 1, 1, true);
    add("upper", 1, 1, true);
    add("trim", 1, 1, true);
    add("replace", 3, 3, true);
    add("format", 1, 99, true);
    add("split", 2, 2, true);
    add("join", 2, 2, true);
    add("startsWith", 2, 2, true);
    add("endsWith", 2, 2, true);
    add("contains", 2, 2, true);
    add("len", 1, 1, true);
    add("first", 1, 1, true);
    add("last", 1, 1, true);
    add("int", 1, 1, true);
    add("float", 1, 1, true);
    add("str", 1, 1, true);
    add("bool", 1, 1, true);
    add("default", 2, 2, true);
    add("env", 1, 1, false);
    add("uuid", 0, 0, false);
    add("nowIso", 0, 0, false);
    map
}

/// Every name a path may start at when no extension adds a context key.
/// Anything else is `E301`. A runtime extension's context keys are added
/// through [`Scope::with_roots`].
pub const ROOTS: [&str; 6] = crate::extension::CORE_ROOTS;

/// Every function name, sorted, for a suggestion and for the reference.
pub fn function_names() -> Vec<String> {
    functions().keys().map(|name| name.to_string()).collect()
}

/// A refusal, carrying the code it is reported as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExprError {
    pub code: String,
    pub message: String,
}

impl ExprError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        ExprError {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ExprError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "{}: {}", self.code, self.message)
    }
}

type Answer = Result<Value, ExprError>;

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number(Value),
    Text(String),
    Name(String),
    Operator(String),
    End,
}

fn is_name_start(character: char) -> bool {
    character.is_ascii_alphabetic() || character == '_'
}

fn is_name_rest(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

/// One expression as tokens.
pub fn tokenise(text: &str) -> Result<Vec<String>, ExprError> {
    Ok(scan(text)?
        .into_iter()
        .map(|token| match token {
            Token::Number(value) => values::to_text(&value),
            Token::Text(value) => value,
            Token::Name(value) => value,
            Token::Operator(value) => value,
            Token::End => String::new(),
        })
        .collect())
}

fn scan(text: &str) -> Result<Vec<Token>, ExprError> {
    let characters: Vec<char> = text.chars().collect();
    let mut tokens: Vec<Token> = Vec::new();
    let mut at = 0usize;
    while at < characters.len() {
        let character = characters[at];
        if character.is_whitespace() {
            at += 1;
            continue;
        }
        if character == '\'' || character == '"' {
            let quote = character;
            let mut value = String::new();
            at += 1;
            let mut closed = false;
            while at < characters.len() {
                if characters[at] == quote {
                    closed = true;
                    at += 1;
                    break;
                }
                value.push(characters[at]);
                at += 1;
            }
            if !closed {
                return Err(ExprError::new(
                    "E305",
                    format!("a string is never closed, in '{text}'"),
                ));
            }
            tokens.push(Token::Text(value));
            continue;
        }
        if character.is_ascii_digit() {
            let mut value = String::new();
            while at < characters.len()
                && (characters[at].is_ascii_digit()
                    // A dot joins a number only when a digit follows, so that
                    // `sessionResults.0.value` keeps its segments.
                    || (characters[at] == '.'
                        && at + 1 < characters.len()
                        && characters[at + 1].is_ascii_digit()
                        && !value.contains('.')))
            {
                value.push(characters[at]);
                at += 1;
            }
            let number = if value.contains('.') {
                Number::from_f64(value.parse::<f64>().unwrap_or_default()).map(Value::Number)
            } else {
                value.parse::<i64>().ok().map(|whole| Value::Number(whole.into()))
            };
            match number {
                Some(number) => tokens.push(Token::Number(number)),
                None => {
                    return Err(ExprError::new(
                        "E305",
                        format!("'{value}' is not a number this language can read, in '{text}'"),
                    ))
                }
            }
            continue;
        }
        if is_name_start(character) {
            let mut value = String::new();
            while at < characters.len() && is_name_rest(characters[at]) {
                value.push(characters[at]);
                at += 1;
            }
            tokens.push(Token::Name(value));
            continue;
        }
        let two: String = characters[at..(at + 2).min(characters.len())].iter().collect();
        if ["==", "!=", "<=", ">="].contains(&two.as_str()) {
            tokens.push(Token::Operator(two));
            at += 2;
            continue;
        }
        if "+-*/%<>?:(),.".contains(character) {
            tokens.push(Token::Operator(character.to_string()));
            at += 1;
            continue;
        }
        return Err(ExprError::new(
            "E305",
            format!("'{character}' is not part of this language, at position {} of '{text}'", at + 1),
        ));
    }
    tokens.push(Token::End);
    Ok(tokens)
}

/// How an expression is evaluated: against what, and whether a value that
/// changes between runs is allowed.
pub struct Scope<'a> {
    pub value: &'a Value,
    pub allow_non_deterministic: bool,
    /// Checked rather than run. Every value underneath is a benign 1, so a
    /// missing operand or an unclosed bracket is reported without a model.
    pub syntax_only: bool,
    /// The roots a path may start at: the core's and the extensions' context
    /// keys. [`ROOTS`] when absent.
    pub roots: Option<&'a [String]>,
}

impl<'a> Scope<'a> {
    pub fn new(value: &'a Value) -> Self {
        Scope {
            value,
            allow_non_deterministic: true,
            syntax_only: false,
            roots: None,
        }
    }

    pub fn stable(mut self) -> Self {
        self.allow_non_deterministic = false;
        self
    }

    /// The same scope, with the roots a run's extensions allow.
    pub fn with_roots(mut self, roots: &'a [String]) -> Self {
        self.roots = Some(roots);
        self
    }

    pub fn syntax_only(value: &'a Value) -> Self {
        Scope {
            value,
            allow_non_deterministic: true,
            syntax_only: true,
            roots: None,
        }
    }

    fn allows(&self, root: &str) -> bool {
        match self.roots {
            Some(roots) => roots.iter().any(|allowed| allowed == root),
            None => ROOTS.contains(&root),
        }
    }

    fn root_list(&self) -> String {
        match self.roots {
            Some(roots) => roots.join(", "),
            None => ROOTS.join(", "),
        }
    }
}

struct Parser<'a, 'b> {
    tokens: Vec<Token>,
    at: usize,
    source: &'a str,
    scope: &'a Scope<'b>,
}

impl<'a, 'b> Parser<'a, 'b> {
    fn peek(&self) -> &Token {
        self.tokens.get(self.at).unwrap_or(&Token::End)
    }

    fn next(&mut self) -> Token {
        let token = self.peek().clone();
        self.at += 1;
        token
    }

    fn is_operator(&self, values: &[&str]) -> bool {
        match self.peek() {
            Token::Operator(found) | Token::Name(found) => values.contains(&found.as_str()),
            _ => false,
        }
    }

    fn ternary(&mut self) -> Answer {
        let condition = self.or()?;
        if self.is_operator(&["?"]) {
            self.at += 1;
            let taken = self.scope.syntax_only || truthy(&condition)?;
            let when_true = self.ternary_branch(taken)?;
            if !self.is_operator(&[":"]) {
                return Err(ExprError::new(
                    "E305",
                    format!("a ? needs a : after it, in '{}'", self.source),
                ));
            }
            self.at += 1;
            let when_false = self.ternary_branch(!taken)?;
            if self.scope.syntax_only {
                return Ok(when_true);
            }
            return Ok(if taken { when_true } else { when_false });
        }
        Ok(condition)
    }

    fn ternary_branch(&mut self, evaluate: bool) -> Answer {
        if evaluate || self.scope.syntax_only {
            return self.ternary();
        }
        let scope = Scope {
            value: self.scope.value,
            allow_non_deterministic: self.scope.allow_non_deterministic,
            syntax_only: true,
            roots: self.scope.roots,
        };
        let mut skipped = Parser { tokens: self.tokens.clone(), at: self.at, source: self.source, scope: &scope };
        let result = skipped.ternary();
        self.at = skipped.at;
        result
    }

    fn or(&mut self) -> Answer {
        let mut left = self.and()?;
        while self.is_operator(&["or"]) {
            self.at += 1;
            let right = self.and()?;
            left = Value::Bool(truthy(&left)? || truthy(&right)?);
        }
        Ok(left)
    }

    fn and(&mut self) -> Answer {
        let mut left = self.comparison()?;
        while self.is_operator(&["and"]) {
            self.at += 1;
            let right = self.comparison()?;
            left = Value::Bool(truthy(&left)? && truthy(&right)?);
        }
        Ok(left)
    }

    /// One comparison, and only one. `1 < 2 == true` is refused rather than
    /// read as something, because two bindings would chain it differently.
    fn comparison(&mut self) -> Answer {
        let left = self.additive()?;
        for operator in ["==", "!=", "<=", ">=", "<", ">"] {
            if self.is_operator(&[operator]) {
                self.at += 1;
                let right = self.additive()?;
                return compare(operator, &left, &right, self.scope.syntax_only);
            }
        }
        Ok(left)
    }

    fn additive(&mut self) -> Answer {
        let mut left = self.multiplicative()?;
        loop {
            if self.is_operator(&["+"]) {
                self.at += 1;
                let right = self.multiplicative()?;
                left = add(&left, &right, self.scope.syntax_only)?;
            } else if self.is_operator(&["-"]) {
                self.at += 1;
                let right = self.multiplicative()?;
                left = arithmetic("-", &left, &right, self.scope.syntax_only)?;
            } else {
                return Ok(left);
            }
        }
    }

    fn multiplicative(&mut self) -> Answer {
        let mut left = self.unary()?;
        loop {
            let operator = if self.is_operator(&["*"]) {
                "*"
            } else if self.is_operator(&["/"]) {
                "/"
            } else if self.is_operator(&["%"]) {
                "%"
            } else {
                return Ok(left);
            };
            self.at += 1;
            let right = self.unary()?;
            left = arithmetic(operator, &left, &right, self.scope.syntax_only)?;
        }
    }

    fn unary(&mut self) -> Answer {
        if self.is_operator(&["-"]) {
            self.at += 1;
            let value = self.unary()?;
            return arithmetic("-", &Value::Number(0.into()), &value, self.scope.syntax_only);
        }
        if self.is_operator(&["not"]) {
            self.at += 1;
            let value = self.unary()?;
            if self.scope.syntax_only {
                return Ok(Value::Bool(true));
            }
            return Ok(Value::Bool(!truthy(&value)?));
        }
        self.primary()
    }

    fn primary(&mut self) -> Answer {
        let token = self.next();
        match token {
            Token::Number(value) => Ok(value),
            Token::Text(value) => Ok(Value::String(value)),
            Token::Operator(operator) if operator == "(" => {
                let inside = self.ternary()?;
                if !self.is_operator(&[")"]) {
                    return Err(ExprError::new(
                        "E305",
                        format!("a ( is never closed, in '{}'", self.source),
                    ));
                }
                self.at += 1;
                Ok(inside)
            }
            Token::Name(name) => {
                match name.as_str() {
                    "true" => return Ok(Value::Bool(true)),
                    "false" => return Ok(Value::Bool(false)),
                    "null" => return Ok(Value::Null),
                    _ => {}
                }
                if self.is_operator(&["("]) {
                    self.at += 1;
                    let mut arguments: Vec<Value> = Vec::new();
                    if !self.is_operator(&[")"]) {
                        loop {
                            arguments.push(self.ternary()?);
                            if self.is_operator(&[","]) {
                                self.at += 1;
                                continue;
                            }
                            break;
                        }
                    }
                    if !self.is_operator(&[")"]) {
                        return Err(ExprError::new(
                            "E305",
                            format!("a call to {name} is never closed, in '{}'", self.source),
                        ));
                    }
                    self.at += 1;
                    return call(&name, &arguments, self.scope);
                }
                let mut segments = vec![name];
                while self.is_operator(&["."]) {
                    self.at += 1;
                    match self.next() {
                        Token::Name(segment) => segments.push(segment),
                        Token::Number(number) => segments.push(values::to_text(&number)),
                        _ => {
                            return Err(ExprError::new(
                                "E305",
                                format!("a path ends with a dot, in '{}'", self.source),
                            ))
                        }
                    }
                }
                resolve(&segments, self.scope)
            }
            Token::Operator(operator) => Err(ExprError::new(
                "E305",
                format!("'{operator}' has nothing to work on, in '{}'", self.source),
            )),
            Token::End => Err(ExprError::new(
                "E305",
                format!("'{}' ends before it says anything", self.source),
            )),
        }
    }
}

/// Whether a value counts as true, by the one rule `bool()` states.
fn truthy(value: &Value) -> Result<bool, ExprError> {
    match to_bool(value) {
        Some(yes) => Ok(yes),
        None => Err(ExprError::new(
            "E307",
            format!("bool cannot read '{}' as true or false", values::to_text(value)),
        )),
    }
}

fn to_bool(value: &Value) -> Option<bool> {
    if let Value::Bool(yes) = value {
        return Some(*yes);
    }
    match values::to_text(value).trim().to_lowercase().as_str() {
        "true" | "yes" | "1" => Some(true),
        "false" | "no" | "0" | "" => Some(false),
        _ => None,
    }
}

fn is_float(value: &Value) -> bool {
    match value {
        Value::Number(number) => number.as_i64().is_none(),
        Value::String(text) => text.trim().parse::<i64>().is_err() && text.trim().parse::<f64>().is_ok(),
        _ => false,
    }
}

fn number(value: f64, whole: bool) -> Value {
    if whole && value.fract() == 0.0 && value.abs() < 9.2e18 {
        return Value::Number((value as i64).into());
    }
    Number::from_f64(value).map(Value::Number).unwrap_or(Value::Null)
}

/// `+` is numeric when both sides are numbers and textual otherwise.
fn add(left: &Value, right: &Value, syntax_only: bool) -> Answer {
    if syntax_only {
        return Ok(Value::Number(1.into()));
    }
    match (values::as_number(left), values::as_number(right)) {
        (Some(one), Some(other)) => Ok(number(one + other, !is_float(left) && !is_float(right))),
        _ => Ok(Value::String(format!(
            "{}{}",
            values::to_text(left),
            values::to_text(right)
        ))),
    }
}

fn arithmetic(operator: &str, left: &Value, right: &Value, syntax_only: bool) -> Answer {
    if syntax_only {
        return Ok(Value::Number(1.into()));
    }
    let (one, other) = match (values::as_number(left), values::as_number(right)) {
        (Some(one), Some(other)) => (one, other),
        _ => {
            return Err(ExprError::new(
                "E307",
                format!(
                    "{operator} takes numbers, and '{}' or '{}' is not one",
                    values::to_text(left),
                    values::to_text(right)
                ),
            ))
        }
    };
    let whole = !is_float(left) && !is_float(right);
    match operator {
        "-" => Ok(number(one - other, whole)),
        "*" => Ok(number(one * other, whole)),
        "/" => {
            if other == 0.0 {
                return Err(ExprError::new("E307", "division by zero"));
            }
            Ok(number(one / other, whole))
        }
        "%" => {
            if other == 0.0 {
                return Err(ExprError::new("E307", "division by zero"));
            }
            Ok(number(one % other, whole))
        }
        _ => Err(ExprError::new("E305", format!("'{operator}' is not an operator"))),
    }
}

/// Numbers compare as numbers; anything else compares as text, ignoring case,
/// which is what the suites in the tree were written against.
fn compare(operator: &str, left: &Value, right: &Value, syntax_only: bool) -> Answer {
    if syntax_only {
        return Ok(Value::Bool(true));
    }
    let numeric = values::as_number(left).zip(values::as_number(right));
    match operator {
        "==" => Ok(Value::Bool(match numeric {
            Some((one, other)) => one == other,
            None => values::to_text(left).eq_ignore_ascii_case(&values::to_text(right)),
        })),
        "!=" => Ok(Value::Bool(match numeric {
            Some((one, other)) => one != other,
            None => !values::to_text(left).eq_ignore_ascii_case(&values::to_text(right)),
        })),
        _ => {
            let (one, other) = match numeric {
                Some(pair) => pair,
                None => {
                    return Err(ExprError::new(
                        "E307",
                        format!(
                            "{operator} compares numbers, and '{}' or '{}' is not one",
                            values::to_text(left),
                            values::to_text(right)
                        ),
                    ))
                }
            };
            Ok(Value::Bool(match operator {
                "<" => one < other,
                "<=" => one <= other,
                ">" => one > other,
                _ => one >= other,
            }))
        }
    }
}

/// One path against the scope.
fn resolve(segments: &[String], scope: &Scope) -> Answer {
    let whole = segments.join(".");
    if scope.syntax_only {
        return Ok(Value::Number(1.into()));
    }
    let root = segments[0].as_str();
    if !scope.allows(root) {
        return Err(ExprError::new(
            "E301",
            format!(
                "${{{whole}}} resolves to nothing. A path starts at {}.",
                scope.root_list()
            ),
        ));
    }
    let mut current = scope.value.clone();
    for segment in segments {
        if current.is_null() {
            return Err(ExprError::new(
                "E301",
                format!("${{{whole}}} resolves to nothing."),
            ));
        }
        if let Value::Array(items) = &current {
            if let Ok(index) = segment.parse::<usize>() {
                match items.get(index) {
                    Some(found) => {
                        current = found.clone();
                        continue;
                    }
                    None => {
                        return Err(ExprError::new(
                            "E301",
                            format!(
                                "${{{whole}}} resolves to nothing: the list has {} entries.",
                                items.len()
                            ),
                        ))
                    }
                }
            }
        }
        match current.get(segment.as_str()) {
            Some(found) => current = found.clone(),
            None => {
                return Err(ExprError::new(
                    "E301",
                    format!("${{{whole}}} resolves to nothing: no {segment} there."),
                ))
            }
        }
    }
    Ok(current)
}

fn as_list(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.clone(),
        Value::Null => Vec::new(),
        other => vec![other.clone()],
    }
}

/// One call of the closed list.
fn call(name: &str, arguments: &[Value], scope: &Scope) -> Answer {
    let declared = functions();
    let spec = match declared.get(name) {
        Some(spec) => spec,
        None => {
            let prefix: String = name.chars().take(2).collect::<String>().to_lowercase();
            let nearest = declared
                .keys()
                .find(|candidate| candidate.to_lowercase().starts_with(&prefix));
            let suggestion = match nearest {
                Some(found) => format!(" Did you mean {found}?"),
                None => String::new(),
            };
            return Err(ExprError::new(
                "E306",
                format!("there is no function called {name}.{suggestion}"),
            ));
        }
    };
    if arguments.len() < spec.min || arguments.len() > spec.max {
        let expected = if spec.min == spec.max {
            spec.min.to_string()
        } else {
            format!("{} to {}", spec.min, spec.max)
        };
        return Err(ExprError::new(
            "E307",
            format!("{name} takes {expected} argument(s), not {}", arguments.len()),
        ));
    }
    if !spec.deterministic && !scope.allow_non_deterministic {
        return Err(ExprError::new(
            "E309",
            format!("{name} is not deterministic, and this value has to be stable"),
        ));
    }
    if scope.syntax_only {
        return Ok(Value::Number(1.into()));
    }

    let text = |index: usize| values::to_text(&arguments[index]);
    match name {
        "lower" => Ok(Value::String(text(0).to_lowercase())),
        "upper" => Ok(Value::String(text(0).to_uppercase())),
        "trim" => Ok(Value::String(text(0).trim().to_string())),
        "replace" => Ok(Value::String(text(0).replace(&text(1), &text(2)))),
        "format" => {
            let mut out = text(0);
            for (index, argument) in arguments.iter().enumerate().skip(1) {
                out = out.replace(&format!("{{{}}}", index - 1), &values::to_text(argument));
            }
            Ok(Value::String(out))
        }
        "split" => Ok(Value::Array(
            text(0)
                .split(&text(1))
                .map(|piece| Value::String(piece.to_string()))
                .collect(),
        )),
        "join" => Ok(Value::String(
            as_list(&arguments[0])
                .iter()
                .map(values::to_text)
                .collect::<Vec<String>>()
                .join(&text(1)),
        )),
        "startsWith" => Ok(Value::Bool(
            text(0).to_lowercase().starts_with(&text(1).to_lowercase()),
        )),
        "endsWith" => Ok(Value::Bool(
            text(0).to_lowercase().ends_with(&text(1).to_lowercase()),
        )),
        "contains" => match &arguments[0] {
            Value::Array(items) => Ok(Value::Bool(
                items.iter().any(|item| values::to_text(item) == text(1)),
            )),
            _ => Ok(Value::Bool(
                text(0).to_lowercase().contains(&text(1).to_lowercase()),
            )),
        },
        "len" => match &arguments[0] {
            Value::Null => Ok(Value::Number(0.into())),
            Value::String(value) => Ok(Value::Number((value.chars().count() as i64).into())),
            Value::Array(items) => Ok(Value::Number((items.len() as i64).into())),
            Value::Object(map) => Ok(Value::Number((map.len() as i64).into())),
            _ => Err(ExprError::new("E307", "len takes a string or a list")),
        },
        "first" | "last" => {
            let list = as_list(&arguments[0]);
            if list.is_empty() {
                return Err(ExprError::new(
                    "E307",
                    format!("{name} takes a list with something in it"),
                ));
            }
            Ok(if name == "first" {
                list[0].clone()
            } else {
                list[list.len() - 1].clone()
            })
        }
        "int" => match values::as_number(&arguments[0]) {
            Some(value) => Ok(Value::Number((value.trunc() as i64).into())),
            None => Err(ExprError::new(
                "E307",
                format!("int cannot read '{}' as a number", text(0)),
            )),
        },
        "float" => match values::as_number(&arguments[0]) {
            Some(value) => Ok(Number::from_f64(value).map(Value::Number).unwrap_or(Value::Null)),
            None => Err(ExprError::new(
                "E307",
                format!("float cannot read '{}' as a number", text(0)),
            )),
        },
        "str" => Ok(Value::String(text(0))),
        "bool" => match to_bool(&arguments[0]) {
            Some(yes) => Ok(Value::Bool(yes)),
            None => Err(ExprError::new(
                "E307",
                format!("bool cannot read '{}' as true or false", text(0)),
            )),
        },
        "default" => {
            let first = &arguments[0];
            if first.is_null() || values::to_text(first).is_empty() {
                Ok(arguments[1].clone())
            } else {
                Ok(first.clone())
            }
        }
        "env" => Ok(Value::String(std::env::var(text(0)).unwrap_or_default())),
        "uuid" => Ok(Value::String(new_uuid())),
        "nowIso" => Ok(Value::String(now_iso())),
        _ => Err(ExprError::new("E306", format!("there is no function called {name}."))),
    }
}

/// A 32-character identifier, from the clock and the address of a local
/// allocation. A test tool needs an identifier nobody else has this second, not
/// a cryptographic one, and this avoids a dependency for one function.
fn new_uuid() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or(0);
    let boxed = Box::new(0u8);
    let address = Box::into_raw(boxed) as usize;
    // Safety: the box was just leaked by into_raw and is reclaimed here.
    unsafe { drop(Box::from_raw(address as *mut u8)) };
    format!("{now:016x}{address:016x}")
        .chars()
        .take(32)
        .collect()
}

/// The current time as `yyyy-MM-ddTHH:mm:ssZ`, without a date library.
fn now_iso() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let time = seconds.rem_euclid(86_400);
    // Civil from days, the standard algorithm: shift the year to start in
    // March so that the leap day falls at the end of it.
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 { month_prime + 3 } else { month_prime - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

/// One expression, evaluated.
pub fn evaluate(text: &str, scope: &Scope) -> Answer {
    let tokens = scan(text)?;
    let mut parser = Parser {
        tokens,
        at: 0,
        source: text,
        scope,
    };
    let value = parser.ternary()?;
    match parser.peek() {
        Token::End => Ok(value),
        Token::Operator(operator) => Err(ExprError::new(
            "E305",
            format!("'{operator}' is left over at the end of '{text}'"),
        )),
        Token::Name(name) => Err(ExprError::new(
            "E305",
            format!("'{name}' is left over at the end of '{text}'"),
        )),
        other => Err(ExprError::new(
            "E305",
            format!("'{}' is left over at the end of '{text}'", values::to_text(&Value::String(format!("{other:?}")))),
        )),
    }
}

/// One value with every `${...}` in it substituted.
///
/// A string that is exactly one expression keeps that expression's type; a
/// string with an expression inside text becomes a string.
pub fn expand(value: &Value, scope: &Scope) -> Answer {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.starts_with("${") && trimmed.ends_with('}') && text == trimmed {
                let inside = &text[2..text.len() - 1];
                if !inside.contains("${") {
                    return evaluate(inside, scope);
                }
            }
            let mut out = String::new();
            let characters: Vec<char> = text.chars().collect();
            let mut at = 0usize;
            while at < characters.len() {
                if characters[at] == '$' && at + 1 < characters.len() && characters[at + 1] == '{' {
                    let mut end = at + 2;
                    while end < characters.len() && characters[end] != '}' {
                        end += 1;
                    }
                    if end < characters.len() {
                        let inside: String = characters[at + 2..end].iter().collect();
                        let result = evaluate(&inside, scope)?;
                        out.push_str(&match result {
                            Value::Bool(yes) => yes.to_string(),
                            other => values::to_text(&other),
                        });
                        at = end + 1;
                        continue;
                    }
                }
                out.push(characters[at]);
                at += 1;
            }
            Ok(Value::String(out))
        }
        Value::Array(items) => {
            let mut expanded = Vec::new();
            for item in items {
                expanded.push(expand(item, scope)?);
            }
            Ok(Value::Array(expanded))
        }
        Value::Object(map) => {
            let mut expanded = serde_json::Map::new();
            for (key, item) in map {
                expanded.insert(key.clone(), expand(item, scope)?);
            }
            Ok(Value::Object(expanded))
        }
        other => Ok(other.clone()),
    }
}

/// Every `${...}` in a value, with the pointer it was written at.
pub fn references(value: &Value, pointer: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    match value {
        Value::String(text) => {
            let characters: Vec<char> = text.chars().collect();
            let mut at = 0usize;
            while at < characters.len() {
                if characters[at] == '$' && at + 1 < characters.len() && characters[at + 1] == '{' {
                    let mut end = at + 2;
                    while end < characters.len() && characters[end] != '}' {
                        end += 1;
                    }
                    if end < characters.len() {
                        found.push((
                            pointer.to_string(),
                            characters[at + 2..end].iter().collect::<String>(),
                        ));
                        at = end + 1;
                        continue;
                    }
                }
                at += 1;
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                found.extend(references(item, &format!("{pointer}/{index}")));
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                found.extend(references(item, &crate::model::child(pointer, key)));
            }
        }
        _ => {}
    }
    found
}

/// The paths and the function names one expression names.
pub struct Reading {
    pub paths: Vec<Vec<String>>,
    pub functions: Vec<String>,
    pub error: Option<ExprError>,
}

/// What one expression reads, and whether it parses at all.
pub fn read(text: &str, stable: bool) -> Reading {
    let mut reading = Reading {
        paths: Vec::new(),
        functions: Vec::new(),
        error: None,
    };
    let tokens = match scan(text) {
        Ok(tokens) => tokens,
        Err(failure) => {
            reading.error = Some(failure);
            return reading;
        }
    };
    let nothing = Value::Null;
    let scope = Scope {
        value: &nothing,
        allow_non_deterministic: !stable,
        syntax_only: true,
        roots: None,
    };
    if let Err(failure) = evaluate(text, &scope) {
        reading.error = Some(failure);
        return reading;
    }
    let keywords = ["and", "or", "not", "true", "false", "null"];
    let mut at = 0usize;
    while at < tokens.len() {
        let name = match &tokens[at] {
            Token::Name(name) => name.clone(),
            _ => {
                at += 1;
                continue;
            }
        };
        if keywords.contains(&name.as_str()) {
            at += 1;
            continue;
        }
        if matches!(tokens.get(at + 1), Some(Token::Operator(operator)) if operator == "(") {
            reading.functions.push(name);
            at += 1;
            continue;
        }
        let mut segments = vec![name];
        at += 1;
        while matches!(tokens.get(at), Some(Token::Operator(operator)) if operator == ".") {
            match tokens.get(at + 1) {
                Some(Token::Name(segment)) => {
                    segments.push(segment.clone());
                    at += 2;
                }
                Some(Token::Number(number)) => {
                    segments.push(values::to_text(number));
                    at += 2;
                }
                _ => break,
            }
        }
        reading.paths.push(segments);
    }
    reading
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scope_value() -> Value {
        json!({
            "capture": { "cs": { "State": "Up", "Nodes": ["N1", "N2", "N3"], "Count": 3, "Empty": [] } },
            "param": { "budget": "120", "blank": "" },
            "var": { "deadline": 240 },
            "row": { "node": "N2" },
            "region": "eu",
            "timeoutSec": 300,
            "defaults": { "region": "eu" }
        })
    }

    fn eval(text: &str) -> Answer {
        let value = scope_value();
        evaluate(text, &Scope::new(&value))
    }

    #[test]
    fn arithmetic_keeps_whole_numbers_whole() {
        assert_eq!(eval("1 + 2").unwrap(), json!(3));
        assert_eq!(eval("6 / 3").unwrap(), json!(2));
        assert_eq!(eval("7 / 2").unwrap(), json!(3.5));
        assert_eq!(eval("1.5 + 1.5").unwrap(), json!(3.0));
        assert_eq!(eval("10 % 3").unwrap(), json!(1));
    }

    #[test]
    fn division_by_zero_is_refused() {
        assert_eq!(eval("1 / 0").unwrap_err().code, "E307");
        assert_eq!(eval("1 % 0").unwrap_err().code, "E307");
    }

    #[test]
    fn plus_is_numeric_or_textual_by_its_operands() {
        assert_eq!(eval("'a' + 'b'").unwrap(), json!("ab"));
        assert_eq!(eval("\"x\" + 1").unwrap(), json!("x1"));
        assert_eq!(eval("\"3\" + 4").unwrap(), json!(7));
    }

    #[test]
    fn a_path_resolves_or_says_it_does_not() {
        assert_eq!(eval("capture.cs.State").unwrap(), json!("Up"));
        assert_eq!(eval("capture.cs.Nodes.1").unwrap(), json!("N2"));
        assert_eq!(eval("timeoutSec").unwrap(), json!(300));
        assert_eq!(eval("nosuchroot").unwrap_err().code, "E301");
        // A context key is a root only when an extension declares it.
        assert_eq!(eval("region").unwrap_err().code, "E301");
        let value = scope_value();
        let roots: Vec<String> = ROOTS.iter().map(|root| root.to_string()).chain(["region".to_string()]).collect();
        assert_eq!(evaluate("region", &Scope::new(&value).with_roots(&roots)).unwrap(), json!("eu"));
        assert_eq!(eval("capture.nope").unwrap_err().code, "E301");
        assert_eq!(eval("capture.cs.Nodes.9").unwrap_err().code, "E301");
    }

    #[test]
    fn a_function_name_is_matched_case_sensitively() {
        assert_eq!(eval("lower('A')").unwrap(), json!("a"));
        assert_eq!(eval("LOWER('A')").unwrap_err().code, "E306");
    }

    #[test]
    fn one_comparison_at_a_time() {
        assert_eq!(eval("1 < 2").unwrap(), json!(true));
        assert_eq!(eval("1 < 2 == true").unwrap_err().code, "E305");
    }

    #[test]
    fn a_template_keeps_a_whole_expressions_type() {
        let value = scope_value();
        let scope = Scope::new(&value);
        assert_eq!(expand(&json!("${timeoutSec}"), &scope).unwrap(), json!(300));
        assert_eq!(
            expand(&json!("budget ${timeoutSec}s"), &scope).unwrap(),
            json!("budget 300s")
        );
        assert_eq!(expand(&json!(7), &scope).unwrap(), json!(7));
    }

    #[test]
    fn a_stable_scope_refuses_the_three_that_change() {
        let value = scope_value();
        let scope = Scope::new(&value).stable();
        assert_eq!(evaluate("uuid()", &scope).unwrap_err().code, "E309");
        assert_eq!(evaluate("nowIso()", &scope).unwrap_err().code, "E309");
        assert_eq!(evaluate("env('PATH')", &scope).unwrap_err().code, "E309");
        assert_eq!(evaluate("upper('x')", &scope).unwrap(), json!("X"));
    }

    #[test]
    fn reading_tells_a_call_from_a_path() {
        let reading = read("upper(capture.cs.State) + var.deadline", false);
        assert!(reading.error.is_none());
        assert_eq!(reading.functions, vec!["upper".to_string()]);
        assert_eq!(reading.paths.len(), 2);
        assert_eq!(reading.paths[0].join("."), "capture.cs.State");
        assert_eq!(reading.paths[1].join("."), "var.deadline");
        assert!(read("true and not false", false).paths.is_empty());
        assert_eq!(read("capture.cs @ 1", false).error.unwrap().code, "E305");
        assert_eq!(read("uuid()", true).error.unwrap().code, "E309");
    }

    #[test]
    fn references_carry_the_pointer_they_were_written_at() {
        let value = json!({ "a": "x${one}y${two}", "b": ["${three}"] });
        let found = references(&value, "");
        assert_eq!(found.len(), 3);
        assert_eq!(found[0], ("/a".to_string(), "one".to_string()));
        assert_eq!(found[2], ("/b/0".to_string(), "three".to_string()));
    }

    #[test]
    fn a_generated_identifier_is_the_right_shape() {
        assert_eq!(new_uuid().len(), 32);
        let stamp = now_iso();
        assert_eq!(stamp.len(), 20, "{stamp}");
        assert!(stamp.ends_with('Z'));
        assert!(stamp.contains('T'));
    }
}
