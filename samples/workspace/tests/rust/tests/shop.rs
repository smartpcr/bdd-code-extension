//! The sample workspace's suites, run by cargo test with the workspace's
//! extension (shop/bddsuite.tests.yaml).

use std::process::ExitCode;
use std::sync::Arc;

fn main() -> ExitCode {
    suiterun::testing::main(
        vec![Arc::new(shop_suiterun::extension::Shop)],
        include!(concat!(env!("OUT_DIR"), "/shop.rs")),
    )
}
