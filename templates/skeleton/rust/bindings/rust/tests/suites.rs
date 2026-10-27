//! The {{name}} suites, run by cargo test with its extension.

use std::process::ExitCode;
use std::sync::Arc;

fn main() -> ExitCode {
    suiterun::testing::main(vec![Arc::new({{crate}}::extension::{{Namespace}}Extension)], include!(concat!(env!("OUT_DIR"), "/suites.rs")))
}
