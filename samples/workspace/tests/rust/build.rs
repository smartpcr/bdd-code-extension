//! Generates each harness's suite list from its config at every build; a suite
//! that does not lint clean stops the build with its findings.

fn main() {
    suiterun::testing::build("shop/bddsuite.tests.yaml", "shop.rs");
    suiterun::testing::build("corpus/bddsuite.tests.yaml", "corpus.rs");
}
