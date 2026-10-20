//! The execute corpus: the trace a run must emit, and the code it must exit
//! with.
//!
//! A report says which cases passed; only a trace says in which order the
//! phases ran, which step a guard skipped and which row of a table failed.

mod common;

use serde_json::Value;
use suiterun::{exit, model};

fn entries(corpus: &std::path::Path) -> Vec<Value> {
    model::load(&std::fs::read_to_string(corpus.join("run-manifest.yaml")).unwrap())
        .unwrap()
        .value["entries"]
        .as_array()
        .expect("the manifest lists entries")
        .clone()
}

fn as_lines(trace: &Value) -> Vec<String> {
    trace
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .map(|entry| {
            let part = |name: &str| entry.get(name).and_then(Value::as_str).unwrap_or("").to_string();
            format!(
                "{} | {} | {} | {} | {} | {}",
                part("phase"),
                part("case"),
                part("step"),
                part("action"),
                part("status"),
                part("reason")
            )
        })
        .collect()
}

#[test]
fn every_execute_entry() {
    let corpus = common::corpus();
    let scratch = std::env::temp_dir().join(format!("suiterun-execute-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).unwrap();

    let mut failures: Vec<String> = Vec::new();
    let mut checked = 0usize;
    let mut pending = 0usize;
    for entry in entries(&corpus) {
        if entry["kind"].as_str() != Some("execute") {
            continue;
        }
        if common::pending_here(&entry) {
            common::report_pending("execute", &entry);
            pending += 1;
            continue;
        }
        let suite = entry["suite"].as_str().unwrap();
        let stem = suite.rsplit('/').next().unwrap().trim_end_matches(".yml");
        let trace_path = scratch.join(format!("{stem}.trace.json"));
        // Through the program, with the corpus extension, as a consumer's
        // suiterun runs it.
        let schema_root = match entry.get("schemaRoot").and_then(Value::as_str) {
            Some(root) => corpus.join(root),
            None => common::corpus_schema(),
        };
        let mut arguments: Vec<String> = vec![
            "run".into(),
            "--schema-root".into(),
            schema_root.to_string_lossy().to_string(),
            "--path".into(),
            corpus.join(suite).to_string_lossy().to_string(),
            "--trace-file".into(),
            trace_path.to_string_lossy().to_string(),
        ];
        if let Some(tags) = entry.get("tags").and_then(Value::as_str) {
            arguments.extend(["--tags".to_string(), tags.to_string()]);
        }
        if let Some(names) = entry.get("names").and_then(Value::as_str) {
            arguments.extend(["--name".to_string(), names.to_string()]);
        }
        let transcript = entry.get("progress").and_then(Value::as_str);
        if transcript.is_some() {
            arguments.push("--progress".to_string());
        }
        if let Some(params) = entry.get("params").and_then(Value::as_object) {
            for (name, value) in params {
                arguments.extend(["--param".to_string(), format!("{name}={}", suiterun::value::to_text(value))]);
            }
        }

        let printed = common::Captured::default();
        let standard = suiterun::progress::set_writer(Some(Box::new(printed.clone())));
        let started = std::time::Instant::now();
        let (code, out, err) = common::run_cli(&arguments);
        let seconds = started.elapsed().as_secs_f64();
        suiterun::progress::set_writer(standard);
        checked += 1;

        match transcript {
            Some(transcript) => {
                let wanted: Vec<String> = std::fs::read_to_string(corpus.join(transcript))
                    .unwrap()
                    .lines()
                    .map(str::to_string)
                    .collect();
                let got = mask_progress(&printed.lines());
                if got != wanted {
                    failures.push(format!(
                        "{suite} progress differs.\nPrinted:\n  {}\nExpected:\n  {}",
                        got.join("\n  "),
                        wanted.join("\n  ")
                    ));
                }
            }
            None if !printed.lines().is_empty() => failures.push(format!("{suite} printed progress lines without --progress")),
            None => {}
        }

        let expectation: Value = serde_json::from_str(
            &std::fs::read_to_string(corpus.join(entry["expectation"].as_str().unwrap())).unwrap(),
        )
        .unwrap();
        let expected_code = expectation["exitCode"].as_i64().unwrap_or(0) as i32;
        if code != expected_code {
            failures.push(format!(
                "{suite} exits {code}; the expectation says {expected_code}. It said:\n{out}{err}"
            ));
            continue;
        }
        if let Some(most) = expectation.get("maxSeconds").and_then(Value::as_f64) {
            if seconds >= most {
                failures.push(format!(
                    "{suite} took {seconds:.1}s; it has to finish inside {most}s or the limit was waited out"
                ));
            }
        }
        let produced: Value =
            serde_json::from_str(&std::fs::read_to_string(&trace_path).unwrap()).unwrap();
        let produced = as_lines(&produced);
        let expected = as_lines(&expectation["trace"]);
        if produced != expected {
            failures.push(format!(
                "{suite} trace differs.\nProduced:\n  {}\nExpected:\n  {}",
                produced.join("\n  "),
                expected.join("\n  ")
            ));
        }
    }

    let _ = std::fs::remove_dir_all(&scratch);
    assert_eq!(exit::PASSED, 0);
    println!("  {checked} execute entries run; {} differ; {pending} pending", failures.len());
    assert_eq!(checked, 20, "execute entries checked");
    assert_eq!(pending, 0, "execute entries pending in rust");
    assert!(
        failures.is_empty(),
        "{} of {checked} entries differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// Progress lines with what the contract leaves free masked: the failure text
/// and the durations (spec/progress.md).
fn mask_progress(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|line| {
            let line = match line.strip_prefix("    failure: ") {
                Some(_) => "    failure: *".to_string(),
                None => line.clone(),
            };
            // "(<digits>s)" -> "(*s)"
            let mut out = String::new();
            let mut rest = line.as_str();
            while let Some(at) = rest.find('(') {
                out.push_str(&rest[..at]);
                let tail = &rest[at + 1..];
                let digits = tail.chars().take_while(char::is_ascii_digit).count();
                if digits > 0 && tail[digits..].starts_with("s)") {
                    out.push_str("(*s)");
                    rest = &tail[digits + 2..];
                } else {
                    out.push('(');
                    rest = tail;
                }
            }
            out.push_str(rest);
            out
        })
        .collect()
}
