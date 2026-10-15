namespace Bdd.Suite.Text;

/// <summary>
/// Turning "unknown key" into "did you mean asserts".
///
/// Two rules, in order. The nearest candidate within an edit distance, which
/// catches a transposition, a doubled letter and a dropped one. Then, when
/// nothing is near enough, the shortest candidate that one of the two is a
/// prefix of: `timeout` for `timeoutSec` is three edits away and so is
/// `cleanupTimeout` for `cleanupTimeoutSec`, and those are the two mistakes this
/// format invites most.
/// </summary>
public static class Spelling
{
    /// <summary>The Levenshtein distance between two words, ignoring case.</summary>
    public static int Distance(string left, string right)
    {
        var one = left.ToLowerInvariant();
        var other = right.ToLowerInvariant();
        if (string.Equals(one, other, StringComparison.Ordinal))
        {
            return 0;
        }
        if (one.Length == 0)
        {
            return other.Length;
        }
        if (other.Length == 0)
        {
            return one.Length;
        }
        var previous = new int[other.Length + 1];
        var current = new int[other.Length + 1];
        for (var index = 0; index <= other.Length; index++)
        {
            previous[index] = index;
        }
        for (var i = 0; i < one.Length; i++)
        {
            current[0] = i + 1;
            for (var j = 0; j < other.Length; j++)
            {
                var cost = one[i] == other[j] ? 0 : 1;
                current[j + 1] = Math.Min(Math.Min(current[j] + 1, previous[j + 1] + 1), previous[j] + cost);
            }
            (previous, current) = (current, previous);
        }
        return previous[other.Length];
    }

    /// <summary>The nearest legal spelling, or nothing.</summary>
    public static string Nearest(string word, IReadOnlyList<string> candidates, int maxDistance)
    {
        if (word.Length == 0)
        {
            return string.Empty;
        }
        var best = string.Empty;
        var bestDistance = maxDistance + 1;
        foreach (var candidate in candidates)
        {
            if (candidate.Length == 0)
            {
                continue;
            }
            var distance = Distance(word, candidate);
            if (distance > maxDistance)
            {
                continue;
            }
            // A tie goes to the name that sorts first, so two runs suggest the
            // same thing whatever order the candidates arrived in.
            if (best.Length == 0 || distance < bestDistance
                || (distance == bestDistance && string.CompareOrdinal(candidate, best) < 0))
            {
                best = candidate;
                bestDistance = distance;
            }
        }
        if (best.Length > 0)
        {
            return best;
        }

        var byLength = candidates.Where(candidate => candidate.Length > 0).ToList();
        byLength.Sort((one, other) =>
            one.Length != other.Length ? one.Length - other.Length : string.CompareOrdinal(one, other));
        var lower = word.ToLowerInvariant();
        foreach (var candidate in byLength)
        {
            var other = candidate.ToLowerInvariant();
            var shared = Math.Min(lower.Length, other.Length);
            if (shared < 4)
            {
                continue;
            }
            if (other.StartsWith(lower, StringComparison.Ordinal)
                || lower.StartsWith(other, StringComparison.Ordinal))
            {
                return candidate;
            }
        }
        return string.Empty;
    }
}
