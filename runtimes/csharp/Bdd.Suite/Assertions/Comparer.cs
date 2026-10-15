using System.Globalization;
using System.Text.RegularExpressions;
using Bdd.Suite.Values;

namespace Bdd.Suite.Assertions;

/// <summary>Why a pair could not be compared at all.</summary>
public sealed class CompareException(string message, string code = "") : Exception(message)
{
    /// <summary>The diagnostic code, when the refusal has one. A pattern outside
    /// the shared subset is E308; a pair that simply cannot be compared has
    /// none.</summary>
    public string Code { get; } = code;

    public override string ToString() => Code.Length == 0 ? Message : Code + ": " + Message;
}

/// <summary>
/// The assertion operators, and the one comparison rule each of them has.
///
/// conformance/asserts/cases.yaml is the specification. `equals`
/// comparing 3 with "3" as equal and `contains` ignoring case are decisions
/// rather than accidents of the language this is written in, which is why they
/// are data there rather than a paragraph here.
///
/// Every comparison states its StringComparison explicitly, because the
/// case-insensitive default this format inherits from PowerShell is not C#'s
/// default and a silent Ordinal here would be a divergence nobody wrote down.
/// </summary>
public static class Comparer
{
    /// <summary>Every operator the comparer implements, which the reference
    /// renders and a test compares against the schema.</summary>
    public static readonly string[] Operators =
    [
        "equals", "notEquals", "contains", "notContains", "startsWith", "endsWith",
        "matches", "in", "gt", "gte", "lt", "lte", "count",
        "isTrue", "isFalse", "isNull", "isNotNull", "script",
    ];

    private static readonly Regex Backreference = new(@"\\\d", RegexOptions.None, TimeSpan.FromSeconds(1));

    /// <summary>
    /// The regular expression construct one of the four engines cannot run, and
    /// what to call it.
    ///
    /// Go's RE2 is the narrowest of the four, so what it refuses is what the
    /// shared subset excludes. Detected by reading the pattern rather than by
    /// trying to compile it, because .NET compiles all of these happily and the
    /// lint has to agree with the binding that cannot.
    /// </summary>
    public static string Unportable(string pattern)
    {
        if (Backreference.IsMatch(pattern))
        {
            return "a backreference";
        }
        if (pattern.Contains("(?=", StringComparison.Ordinal) || pattern.Contains("(?!", StringComparison.Ordinal))
        {
            return "a lookahead";
        }
        if (pattern.Contains("(?<=", StringComparison.Ordinal) || pattern.Contains("(?<!", StringComparison.Ordinal))
        {
            return "a lookbehind";
        }
        return string.Empty;
    }

    private static double NumberOr(object? value, string side, string operator_)
    {
        if (Value.TryNumber(value, out var number))
        {
            return number;
        }
        throw new CompareException(string.Create(CultureInfo.InvariantCulture,
            $"{operator_} compares numbers, and the {side} is '{Value.Text(value)}', which is not one."));
    }

    /// <summary>
    /// Run one operator against one actual value.
    ///
    /// `present` is whether the subject was there at all, which only isNull and
    /// isNotNull can tell apart from a subject that is there and null.
    /// </summary>
    public static bool Compare(string operator_, object? actual, object? expected, bool present)
    {
        var wanted = Value.Text(expected);
        var subject = Value.Text(actual);
        switch (operator_)
        {
            case "equals":
                return string.Equals(subject, wanted, StringComparison.OrdinalIgnoreCase);
            case "notEquals":
                return !string.Equals(subject, wanted, StringComparison.OrdinalIgnoreCase);
            case "contains":
                if (actual is List<object?> items)
                {
                    return items.Any(item => string.Equals(Value.Text(item), wanted, StringComparison.Ordinal));
                }
                return subject.Contains(wanted, StringComparison.OrdinalIgnoreCase);
            case "notContains":
                return !Compare("contains", actual, expected, present);
            case "startsWith":
                return subject.StartsWith(wanted, StringComparison.OrdinalIgnoreCase);
            case "endsWith":
                return subject.EndsWith(wanted, StringComparison.OrdinalIgnoreCase);
            case "matches":
            {
                var construct = Unportable(wanted);
                if (construct.Length > 0)
                {
                    throw new CompareException(string.Create(CultureInfo.InvariantCulture,
                        $"the pattern '{wanted}' uses {construct}, which is outside the subset the four bindings share."),
                        "E308");
                }
                try
                {
                    // Case-insensitive, which is what the suites were written
                    // against.
                    return Regex.IsMatch(subject, wanted,
                        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(5));
                }
                catch (ArgumentException failure)
                {
                    throw new CompareException(string.Create(CultureInfo.InvariantCulture,
                        $"the pattern '{wanted}' cannot be read: {failure.Message}"));
                }
            }
            case "in":
            {
                if (expected is not List<object?> candidates)
                {
                    throw new CompareException(string.Create(CultureInfo.InvariantCulture,
                        $"in takes a list, and '{wanted}' is not one."));
                }
                return candidates.Any(candidate =>
                    string.Equals(Value.Text(candidate), subject, StringComparison.OrdinalIgnoreCase));
            }
            case "gt":
                return NumberOr(actual, "subject", operator_) > NumberOr(expected, "expected value", operator_);
            case "gte":
                return NumberOr(actual, "subject", operator_) >= NumberOr(expected, "expected value", operator_);
            case "lt":
                return NumberOr(actual, "subject", operator_) < NumberOr(expected, "expected value", operator_);
            case "lte":
                return NumberOr(actual, "subject", operator_) <= NumberOr(expected, "expected value", operator_);
            case "count":
            {
                if (actual is not List<object?> counted)
                {
                    throw new CompareException(string.Create(CultureInfo.InvariantCulture,
                        $"count takes a list, and the subject is '{subject}', which is not one."));
                }
                return counted.Count == NumberOr(expected, "expected value", "count");
            }
            case "isTrue":
                return (actual is bool isTrue && isTrue) == TruthOf(expected);
            case "isFalse":
                return (actual is bool isFalse && !isFalse) == TruthOf(expected);
            case "isNull":
                return (!present || actual is null) == TruthOf(expected);
            case "isNotNull":
                return (present && actual is not null) == TruthOf(expected);
            default:
                throw new CompareException(string.Create(CultureInfo.InvariantCulture,
                    $"Unknown assertion: {operator_}"));
        }
    }

    /// <summary>What an operator's own expected value means when it is a
    /// flag.</summary>
    internal static bool TruthOf(object? value)
    {
        switch (value)
        {
            case bool yes:
                return yes;
            case null:
                return false;
            default:
                var text = Value.Text(value);
                return text.Length > 0 && !string.Equals(text, "0", StringComparison.Ordinal);
        }
    }

    /// <summary>What a failed assertion says: the subject, the operator, what was
    /// expected and what was there.</summary>
    public static string Describe(string subject, string operator_, object? expected, object? actual, bool present)
    {
        string shown;
        if (!present)
        {
            shown = "(absent)";
        }
        else if (actual is null)
        {
            shown = "(null)";
        }
        else if (actual is List<object?> items)
        {
            shown = "[" + string.Join(", ", items.Select(Value.Text)) + "]";
        }
        else
        {
            shown = Value.Text(actual);
        }
        var wanted = expected is List<object?> candidates
            ? "[" + string.Join(", ", candidates.Select(Value.Text)) + "]"
            : Value.Text(expected);
        return operator_ switch
        {
            "isTrue" => string.Create(CultureInfo.InvariantCulture, $"expected {subject} to be true, got '{shown}'"),
            "isFalse" => string.Create(CultureInfo.InvariantCulture, $"expected {subject} to be false, got '{shown}'"),
            "isNull" => string.Create(CultureInfo.InvariantCulture,
                $"expected {subject} to be absent or null, got '{shown}'"),
            "isNotNull" => string.Create(CultureInfo.InvariantCulture,
                $"expected {subject} to be present, got '{shown}'"),
            "count" => string.Create(CultureInfo.InvariantCulture,
                $"expected {subject} to have {wanted} entries, got '{shown}'"),
            _ => string.Create(CultureInfo.InvariantCulture,
                $"expected {subject} {operator_} '{wanted}', got '{shown}'"),
        };
    }
}
