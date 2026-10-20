//! The conformance corpus's execute suites, run by cargo test with the corpus
//! extension (corpus/bddsuite.tests.yaml).

use std::process::ExitCode;
use std::sync::Arc;

fn main() -> ExitCode {
    suiterun::testing::main(
        vec![Arc::new(shop_suite_tests::CorpusExtension)],
        include!(concat!(env!("OUT_DIR"), "/corpus.rs")),
    )
}
