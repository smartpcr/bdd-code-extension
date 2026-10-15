//! Validation, in the three levels DEC-Y05 defines.
//!
//! Structure sees the file and the schema. Semantics sees the parsed model and
//! the catalog. Dataflow sees the expanded model and the catalog. All three run
//! over one parse and everything they find is reported, because an author
//! fixing four typos should see four diagnostics.

pub mod dataflow;
pub mod semantics;
pub mod structure;

use std::path::Path;

use crate::diag::{self, Diagnostic};
use crate::extension::{Registry, RuleInput};
use crate::model;
use crate::schema::Schema;

/// How one file is to be validated.
#[derive(Debug, Clone, Default)]
pub struct Options {
    pub binding: String,
    pub binding_check: bool,
    pub params: Vec<(String, String)>,
    /// The runtime's extensions: their context keys, lint rules and
    /// environment prefix. The core alone by default.
    pub extensions: Registry,
}

/// Every diagnostic for one suite file, in the one order every binding writes.
pub fn file(path: &Path, relative: &str, schema: &Schema, options: &Options) -> Result<Vec<Diagnostic>, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|failure| format!("{} cannot be read: {failure}", path.display()))?;
    let document = match model::load(&text) {
        Ok(document) => document,
        Err(failure) => {
            return Ok(vec![structure::unparseable(relative, &failure.message, failure.position)])
        }
    };
    if !document.value.is_object() {
        return Ok(vec![structure::not_a_mapping(relative)]);
    }
    let library = semantics::imports(&document, relative, path);
    let mut found = structure::check(&document, relative, schema)?;
    found.extend(semantics::check(
        &document,
        relative,
        schema,
        &library,
        &options.binding,
        options.binding_check,
        &options.params,
        options.extensions.env_prefix(),
    ));
    found.extend(dataflow::check(&document, relative, schema, &library, options.extensions.context_keys()));
    found.extend(options.extensions.lint(&RuleInput {
        document: &document,
        file: relative,
        suite: &document.value,
        library: &library,
    }));
    Ok(diag::sorted(found))
}
