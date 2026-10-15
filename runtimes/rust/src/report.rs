//! The two reports a run writes.
//!
//! The same documents the PowerShell binding writes, so that the two
//! canonicalise equal by the rules in
//! `conformance/report/canonicalise.md`. The timestamps and durations
//! stay in the shipped output: a report a person reads wants them, and the
//! canonical form is what drops them for a comparison.

use crate::exec::{CaseResult, SuiteResult};
use crate::trace::Status;

/// XML text with the five characters that cannot appear raw replaced.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn counts(cases: &[CaseResult]) -> (usize, usize, usize, usize) {
    let total = cases.len();
    let passed = cases.iter().filter(|case| case.status == Status::Passed).count();
    let failed = cases
        .iter()
        .filter(|case| matches!(case.status, Status::Failed | Status::Error))
        .count();
    let skipped = cases.iter().filter(|case| case.status == Status::Skipped).count();
    (total, passed, failed, skipped)
}

fn result_word(status: Status) -> &'static str {
    match status {
        Status::Passed => "Passed",
        Status::Failed | Status::Error => "Failed",
        Status::Skipped => "Skipped",
    }
}

/// The time a report stamps itself with. Dropped by the canonical form, so its
/// only job is to be a legal timestamp.
fn stamp() -> String {
    crate::expr::evaluate(
        "nowIso()",
        &crate::expr::Scope::new(&serde_json::Value::Null),
    )
    .map(|value| crate::value::to_text(&value).replace('T', " ").replace('Z', "Z"))
    .unwrap_or_else(|_| "1970-01-01 00:00:00Z".to_string())
}

/// NUnit 3.
pub fn nunit3(suites: &[SuiteResult]) -> String {
    let all: Vec<&CaseResult> = suites.iter().flat_map(|suite| suite.cases.iter()).collect();
    let owned: Vec<CaseResult> = all.iter().map(|case| (*case).clone()).collect();
    let (total, passed, failed, skipped) = counts(&owned);
    let duration: f64 = owned.iter().map(|case| case.duration_sec).sum();
    let now = stamp();
    let overall = if failed > 0 { "Failed" } else { "Passed" };

    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str(&format!(
        "<test-run id=\"2\" testcasecount=\"{total}\" result=\"{overall}\" total=\"{total}\" passed=\"{passed}\" failed=\"{failed}\" inconclusive=\"0\" skipped=\"{skipped}\" asserts=\"0\" engine-version=\"1.0\" clr-version=\"rust\" start-time=\"{now}\" end-time=\"{now}\" duration=\"{duration:.3}\">\n"
    ));
    let mut suite_id = 1000;
    let mut case_id = 2000;
    for suite in suites {
        suite_id += 1;
        let (total, passed, failed, skipped) = counts(&suite.cases);
        let duration: f64 = suite.cases.iter().map(|case| case.duration_sec).sum();
        let result = if failed > 0 { "Failed" } else { "Passed" };
        let name = escape(&suite.name);
        out.push_str(&format!(
            "  <test-suite type=\"TestFixture\" id=\"0-{suite_id}\" name=\"{name}\" fullname=\"{name}\" classname=\"{name}\" runstate=\"Runnable\" testcasecount=\"{total}\" result=\"{result}\" start-time=\"{now}\" end-time=\"{now}\" duration=\"{duration:.3}\" total=\"{total}\" passed=\"{passed}\" failed=\"{failed}\" inconclusive=\"0\" skipped=\"{skipped}\" asserts=\"0\">\n"
        ));
        for case in &suite.cases {
            case_id += 1;
            let case_name = escape(&case.name);
            out.push_str(&format!(
                "    <test-case id=\"0-{case_id}\" name=\"{case_name}\" fullname=\"{name}.{case_name}\" methodname=\"{case_name}\" classname=\"{name}\" runstate=\"Runnable\" result=\"{}\" start-time=\"{now}\" end-time=\"{now}\" duration=\"{:.3}\" asserts=\"0\">\n",
                result_word(case.status),
                case.duration_sec
            ));
            match case.status {
                Status::Failed | Status::Error => {
                    out.push_str("      <failure>\n");
                    out.push_str(&format!("        <message>{}</message>\n", escape(&case.message)));
                    out.push_str("      </failure>\n");
                }
                Status::Skipped => {
                    out.push_str("      <reason>\n");
                    out.push_str(&format!("        <message>{}</message>\n", escape(&case.message)));
                    out.push_str("      </reason>\n");
                }
                Status::Passed => {}
            }
            if !case.output.is_empty() {
                out.push_str(&format!("      <output>{}</output>\n", escape(case.output.trim_end())));
            }
            out.push_str("    </test-case>\n");
        }
        out.push_str("  </test-suite>\n");
    }
    out.push_str("</test-run>\n");
    out
}

/// JUnit.
pub fn junit(suites: &[SuiteResult]) -> String {
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuites>\n");
    for suite in suites {
        let (total, _, failed, skipped) = counts(&suite.cases);
        let name = escape(&suite.name);
        out.push_str(&format!(
            "  <testsuite name=\"{name}\" tests=\"{total}\" failures=\"{failed}\" skipped=\"{skipped}\">\n"
        ));
        for case in &suite.cases {
            let case_name = escape(&case.name);
            out.push_str(&format!(
                "    <testcase name=\"{case_name}\" classname=\"{name}\" time=\"{:.3}\">\n",
                case.duration_sec
            ));
            match case.status {
                Status::Failed | Status::Error => out.push_str(&format!(
                    "      <failure message=\"{}\"></failure>\n",
                    escape(&case.message)
                )),
                Status::Skipped => out.push_str(&format!(
                    "      <skipped message=\"{}\"></skipped>\n",
                    escape(&case.message)
                )),
                Status::Passed => {}
            }
            out.push_str(&format!(
                "      <system-out>{}</system-out>\n",
                escape(case.output.trim_end())
            ));
            out.push_str("    </testcase>\n");
        }
        out.push_str("  </testsuite>\n");
    }
    out.push_str("</testsuites>\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<SuiteResult> {
        vec![SuiteResult {
            name: "s.yml".into(),
            cases: vec![
                CaseResult { name: "passes".into(), status: Status::Passed, message: String::new(), output: "\"Up\"".into(), duration_sec: 0.5 },
                CaseResult { name: "fails".into(), status: Status::Failed, message: "expected x equals 'y', got 'z'".into(), output: String::new(), duration_sec: 0.25 },
                CaseResult { name: "skips".into(), status: Status::Skipped, message: "tag filter".into(), output: String::new(), duration_sec: 0.0 },
            ],
        }]
    }

    #[test]
    fn nunit_counts_what_happened() {
        let document = nunit3(&sample());
        assert!(document.contains("total=\"3\""));
        assert!(document.contains("passed=\"1\""));
        assert!(document.contains("failed=\"1\""));
        assert!(document.contains("skipped=\"1\""));
        assert!(document.contains("result=\"Failed\""));
        assert!(document.contains("<message>expected x equals &apos;y&apos;, got &apos;z&apos;</message>"));
        assert!(document.contains("<output>&quot;Up&quot;</output>"));
        assert!(document.contains("<reason>"));
    }

    #[test]
    fn junit_says_the_same_thing_with_different_elements() {
        let document = junit(&sample());
        assert!(document.contains("<testsuite name=\"s.yml\" tests=\"3\" failures=\"1\" skipped=\"1\">"));
        assert!(document.contains("<failure message=\"expected x equals &apos;y&apos;, got &apos;z&apos;\">"));
        assert!(document.contains("<skipped message=\"tag filter\">"));
        assert!(document.contains("<system-out>&quot;Up&quot;</system-out>"));
    }

    #[test]
    fn a_run_that_passed_says_so_at_the_top() {
        let suites = vec![SuiteResult {
            name: "s.yml".into(),
            cases: vec![CaseResult { name: "c".into(), status: Status::Passed, message: String::new(), output: String::new(), duration_sec: 0.0 }],
        }];
        assert!(nunit3(&suites).contains("result=\"Passed\""));
        assert!(junit(&suites).contains("failures=\"0\""));
        assert!(nunit3(&[]).contains("total=\"0\""));
        assert!(junit(&[]).contains("<testsuites>"));
    }

    #[test]
    fn the_five_characters_that_cannot_appear_raw_are_escaped() {
        assert_eq!(escape("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
        assert!(stamp().ends_with('Z'));
    }
}
