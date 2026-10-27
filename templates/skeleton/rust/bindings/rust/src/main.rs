//! This workspace's `suiterun`, Rust binding: the runtime's command line with
//! the {{name}} extension. The Suite Authoring extension builds and runs it
//! (.vscode/settings.json, bddSuite.bindings.rust).

use std::sync::Arc;

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let extensions: Vec<Arc<dyn suiterun::Extension>> = vec![Arc::new({{crate}}::extension::{{Namespace}}Extension)];
    let code = suiterun::main_with(arguments, &mut std::io::stdout(), &mut std::io::stderr(), &extensions);
    std::process::exit(code);
}
