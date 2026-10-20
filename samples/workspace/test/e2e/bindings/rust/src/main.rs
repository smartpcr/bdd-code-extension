//! The sample workspace's `suiterun`, Rust binding: the runtime's command line
//! with this workspace's extension.
//!
//! ```text
//! cargo build    # target/debug/suiterun(.exe)
//! ```

use std::sync::Arc;

use shop_suiterun::extension;

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let extensions: Vec<Arc<dyn suiterun::Extension>> = vec![Arc::new(extension::Shop)];
    let code = suiterun::main_with(arguments, &mut std::io::stdout(), &mut std::io::stderr(), &extensions);
    std::process::exit(code);
}
