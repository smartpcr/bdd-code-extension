//! Turning "unknown key" into "did you mean asserts".
//!
//! Two rules, in order. The nearest candidate within an edit distance, which
//! catches a transposition, a doubled letter and a dropped one. Then, when
//! nothing is near enough, the shortest candidate that one of the two is a
//! prefix of: `timeout` for `timeoutSec` is three edits away and so is
//! `cleanupTimeout` for `cleanupTimeoutSec`, and those are the two mistakes
//! this format invites most.
//!
//! A suggestion is help rather than contract. Two bindings that suggest
//! differently still conform; two that report different codes do not.

/// Levenshtein distance, ignoring case.
pub fn edit_distance(left: &str, right: &str) -> usize {
    let left: Vec<char> = left.to_lowercase().chars().collect();
    let right: Vec<char> = right.to_lowercase().chars().collect();
    if left == right {
        return 0;
    }
    if left.is_empty() {
        return right.len();
    }
    if right.is_empty() {
        return left.len();
    }
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    let mut current = vec![0usize; right.len() + 1];
    for (i, left_char) in left.iter().enumerate() {
        current[0] = i + 1;
        for (j, right_char) in right.iter().enumerate() {
            let cost = usize::from(left_char != right_char);
            current[j + 1] = (current[j] + 1)
                .min(previous[j + 1] + 1)
                .min(previous[j] + cost);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

/// The nearest legal spelling, or nothing.
pub fn nearest<S: AsRef<str>>(word: &str, candidates: &[S], max_distance: usize) -> Option<String> {
    if word.is_empty() {
        return None;
    }
    let mut best: Option<String> = None;
    let mut best_distance = max_distance + 1;
    for candidate in candidates {
        let candidate = candidate.as_ref();
        if candidate.is_empty() {
            continue;
        }
        let distance = edit_distance(word, candidate);
        if distance > max_distance {
            continue;
        }
        // A tie goes to the name that sorts first, so two runs suggest the same
        // thing whatever order the candidates arrived in.
        let better = match &best {
            None => true,
            Some(current) => distance < best_distance || (distance == best_distance && candidate < current.as_str()),
        };
        if better {
            best = Some(candidate.to_string());
            best_distance = distance;
        }
    }
    if best.is_some() {
        return best;
    }

    let lower = word.to_lowercase();
    let mut by_length: Vec<&str> = candidates
        .iter()
        .map(AsRef::as_ref)
        .filter(|candidate| !candidate.is_empty())
        .collect();
    by_length.sort_by(|left, right| left.len().cmp(&right.len()).then(left.cmp(right)));
    for candidate in by_length {
        let other = candidate.to_lowercase();
        if lower.len().min(other.len()) < 4 {
            continue;
        }
        if other.starts_with(&lower) || lower.starts_with(&other) {
            return Some(candidate.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distance_counts_the_edits_and_ignores_case() {
        assert_eq!(edit_distance("asserts", "asserts"), 0);
        assert_eq!(edit_distance("ASSERTS", "asserts"), 0);
        assert_eq!(edit_distance("assert", "asserts"), 1);
        assert_eq!(edit_distance("assrets", "asserts"), 2);
        assert_eq!(edit_distance("", "abc"), 3);
        assert_eq!(edit_distance("abc", ""), 3);
        assert_eq!(edit_distance("", ""), 0);
    }

    #[test]
    fn a_near_miss_is_suggested() {
        let keys = ["asserts", "steps", "name", "tags"];
        assert_eq!(nearest("assert", &keys, 2).as_deref(), Some("asserts"));
        assert_eq!(nearest("stepz", &keys, 2).as_deref(), Some("steps"));
        assert_eq!(nearest("nothinglikeit", &keys, 2), None);
    }

    #[test]
    fn a_prefix_is_suggested_when_nothing_is_near_enough() {
        let keys = ["timeoutSec", "cleanupTimeoutSec", "name"];
        assert_eq!(nearest("timeout", &keys, 2).as_deref(), Some("timeoutSec"));
        assert_eq!(
            nearest("cleanupTimeout", &keys, 2).as_deref(),
            Some("cleanupTimeoutSec")
        );
    }

    #[test]
    fn a_short_word_is_not_prefix_matched() {
        // Three shared characters is not a signal: too many names start with
        // the same three letters for that to mean anything.
        assert_eq!(nearest("tim", &["timeoutSec"], 2), None);
    }

    #[test]
    fn a_tie_goes_to_the_name_that_sorts_first() {
        assert_eq!(nearest("aaa", &["aab", "aac"], 2).as_deref(), Some("aab"));
        assert_eq!(nearest("aaa", &["aac", "aab"], 2).as_deref(), Some("aab"));
    }

    #[test]
    fn nothing_suggests_nothing() {
        assert_eq!(nearest("", &["a"], 2), None);
        assert_eq!(nearest("a", &[] as &[&str], 2), None);
        assert_eq!(nearest("a", &[""], 2), None);
    }

    #[test]
    fn a_wider_distance_reaches_further() {
        assert_eq!(nearest("suspned", &["fixture.suspend"], 2), None);
        assert_eq!(
            nearest("fixture.suspned", &["fixture.suspend"], 3).as_deref(),
            Some("fixture.suspend")
        );
    }
}
