//! Generates the suite list from tests/bddsuite.tests.yaml at every build; a
//! suite that does not lint clean stops the build with its findings.

fn main() {
    suiterun::testing::build("tests/bddsuite.tests.yaml", "suites.rs");
}
