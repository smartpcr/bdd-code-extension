//! The example workspace's own `suiterun`: the runtime's command line with the
//! example extension, which is all a consumer's `suiterun` is.
//!
//! ```text
//! cargo run --example echo -- run --schema-root example/schema --path example/suites/echo.yml --region eu
//! ```

use std::sync::Arc;

#[path = "../example/src/extension.rs"]
mod extension;

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let extensions: Vec<Arc<dyn suiterun::Extension>> = vec![Arc::new(extension::Echo)];
    let code = suiterun::main_with(arguments, &mut std::io::stdout(), &mut std::io::stderr(), &extensions);
    std::process::exit(code);
}
