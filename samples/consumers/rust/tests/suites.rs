//! The greeter's suites, run by cargo test with its extension.

use std::process::ExitCode;
use std::sync::Arc;

fn main() -> ExitCode {
    suiterun::testing::main(vec![Arc::new(greeter::GreeterExtension)], include!(concat!(env!("OUT_DIR"), "/suites.rs")))
}
