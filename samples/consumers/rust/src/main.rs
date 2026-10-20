//! The greeter's suiterun: lint, run and list its suites with its extension.

use std::sync::Arc;

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let extensions: Vec<Arc<dyn suiterun::Extension>> = vec![Arc::new(greeter::GreeterExtension)];
    let code = suiterun::main_with(arguments, &mut std::io::stdout(), &mut std::io::stderr(), &extensions);
    std::process::exit(code);
}
