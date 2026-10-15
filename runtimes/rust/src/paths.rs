//! Where a workspace's schema is, and which files a glob names.
//!
//! The workspace root is found by walking up from the working directory to
//! `test/e2e/schema` (the layout a workspace uses by default), so the runtime
//! works from any directory inside it; `--schema-root` names another place.

use std::path::{Path, PathBuf};

/// The workspace root: the nearest ancestor holding `test/e2e/schema`.
pub fn repository_root(start: &Path) -> Option<PathBuf> {
    let mut here = Some(start);
    while let Some(directory) = here {
        if directory.join("test").join("e2e").join("schema").is_dir() {
            return Some(directory.to_path_buf());
        }
        here = directory.parent();
    }
    None
}

/// Where `suite.schema.json` and `actions.catalog.yaml` are by default.
pub fn schema_root(root: &Path) -> PathBuf {
    root.join("test").join("e2e").join("schema")
}

/// Whether a name matches a glob of the kind a `--path` takes: `*` for any run
/// of characters inside one segment, `?` for one, and nothing else.
///
/// Written out rather than taken from a crate because the whole vocabulary is
/// two characters, and because a glob library that treats `**` or `[a-z]` as
/// meaningful would quietly accept patterns the other bindings do not.
pub fn matches_glob(pattern: &str, name: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let name: Vec<char> = name.chars().collect();
    // The classic two-cursor walk with one backtrack point, which is linear and
    // needs no recursion: `star` remembers where the last `*` was so that a
    // mismatch after it can give the star one more character.
    let (mut at_pattern, mut at_name) = (0usize, 0usize);
    let (mut star, mut star_at_name) = (usize::MAX, 0usize);
    while at_name < name.len() {
        if at_pattern < pattern.len() && (pattern[at_pattern] == '?' || pattern[at_pattern] == name[at_name]) {
            at_pattern += 1;
            at_name += 1;
        } else if at_pattern < pattern.len() && pattern[at_pattern] == '*' {
            star = at_pattern;
            star_at_name = at_name;
            at_pattern += 1;
        } else if star != usize::MAX {
            at_pattern = star + 1;
            star_at_name += 1;
            at_name = star_at_name;
        } else {
            return false;
        }
    }
    while at_pattern < pattern.len() && pattern[at_pattern] == '*' {
        at_pattern += 1;
    }
    at_pattern == pattern.len()
}

/// Every file a `--path` names, in one order on every machine.
///
/// A pattern with no `*` or `?` in its last segment is a file, and is returned
/// whether or not the directory holds anything else.
pub fn resolve(pattern: &str, working_directory: &Path) -> Result<Vec<PathBuf>, String> {
    let raw = pattern.replace('\\', "/");
    let candidate = PathBuf::from(&raw);
    let full = if candidate.is_absolute() {
        candidate
    } else {
        working_directory.join(&raw)
    };

    let leaf = full
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    if !leaf.contains('*') && !leaf.contains('?') {
        if full.is_file() {
            return Ok(vec![full]);
        }
        return Err(format!("{pattern} names no file."));
    }

    let directory = full.parent().unwrap_or(working_directory).to_path_buf();
    let listing = std::fs::read_dir(&directory)
        .map_err(|failure| format!("{} cannot be read: {failure}", directory.display()))?;
    let mut found: Vec<PathBuf> = Vec::new();
    for entry in listing.flatten() {
        if !entry.path().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if matches_glob(&leaf, &name) {
            found.push(entry.path());
        }
    }
    // Sorted, because a run's report lists its suites in the order they ran and
    // two machines must not order them differently.
    found.sort();
    if found.is_empty() {
        return Err(format!("{pattern} names no file."));
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This repository's corpus (conformance/), two folders up from the crate.
    fn corpus() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
    }

    #[test]
    fn a_star_matches_any_run_of_characters() {
        assert!(matches_glob("*.yml", "smoke.yml"));
        assert!(matches_glob("*.yml", ".yml"));
        assert!(matches_glob("*", "anything"));
        assert!(matches_glob("suite-*.yml", "suite-stage0.yml"));
        assert!(!matches_glob("*.yml", "smoke.yaml"));
        assert!(!matches_glob("suite-*.yml", "smoke.yml"));
    }

    #[test]
    fn a_question_mark_matches_exactly_one() {
        assert!(matches_glob("stage?.yml", "stage0.yml"));
        assert!(!matches_glob("stage?.yml", "stage10.yml"));
        assert!(!matches_glob("stage?.yml", "stage.yml"));
    }

    #[test]
    fn several_stars_backtrack() {
        assert!(matches_glob("*-*.yml", "suite-stage0.yml"));
        assert!(matches_glob("a*b*c", "abc"));
        assert!(matches_glob("a*b*c", "axxbyyc"));
        assert!(!matches_glob("a*b*c", "axxbyy"));
        assert!(matches_glob("**", "anything"));
    }

    #[test]
    fn a_pattern_with_nothing_special_is_the_name_itself() {
        assert!(matches_glob("smoke.yml", "smoke.yml"));
        assert!(!matches_glob("smoke.yml", "smoke.yml.bak"));
        assert!(!matches_glob("smoke.yml", "Smoke.yml"));
    }

    #[test]
    fn the_root_is_the_nearest_ancestor_with_the_schema() {
        let workspace = std::env::temp_dir().join(format!("suiterun-paths-{}", std::process::id()));
        let inner = workspace.join("test").join("e2e").join("schema");
        std::fs::create_dir_all(inner.join("deeper")).unwrap();
        assert_eq!(repository_root(&inner.join("deeper")), Some(workspace.clone()));
        assert_eq!(schema_root(&workspace), inner);
        assert!(repository_root(Path::new("/")).is_none());
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn a_glob_finds_the_corpus_and_sorts_it() {
        let found = resolve("execute/*.yml", &corpus()).unwrap();
        assert!(found.len() >= 9, "found {}", found.len());
        let names: Vec<String> = found
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
    }

    #[test]
    fn one_named_file_needs_no_star() {
        let found = resolve("execute/hooks.yml", &corpus()).unwrap();
        assert_eq!(found.len(), 1);
        let absolute = corpus().join("execute").join("hooks.yml");
        let found = resolve(&absolute.to_string_lossy(), Path::new("/")).unwrap();
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn a_pattern_that_names_nothing_says_so() {
        assert!(resolve("execute/nosuchfile.yml", &corpus())
            .unwrap_err()
            .contains("names no file"));
        assert!(resolve("execute/*.nosuch", &corpus())
            .unwrap_err()
            .contains("names no file"));
        assert!(resolve("nosuchdirectory/*.yml", &corpus())
            .unwrap_err()
            .contains("cannot be read"));
    }
}
