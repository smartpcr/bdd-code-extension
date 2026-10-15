//! `suiterun`: the Rust runtime's command line, with no extension.
//!
//! Four verbs and three exit codes, shared with the other runtimes (DEC-Y14).
//! Everything the verbs do lives in the library beside this file; a consumer's
//! own `suiterun` is the same call to `suiterun::main_with` with its
//! extensions.

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let code = suiterun::main_with(arguments, &mut std::io::stdout(), &mut std::io::stderr(), &[]);
    // A step the runner gave up on is still running on its own thread, and Rust
    // cannot kill one. Exiting is what ends it, which is the same promise the
    // other runtimes make: the case is over either way.
    std::process::exit(code);
}
