using System.Globalization;
using System.Text;

namespace Bdd.Suite.Testing;

/// <summary>
/// The identifiers a test plan gives suites and cases (spec/test-plan.md,
/// Identifiers): the name's ASCII letters and digits, each word capitalised, a
/// fallback for a name with none, N before a leading digit, and _2, _3, ... on
/// a collision compared ignoring ASCII case.
/// </summary>
public sealed class Identifiers
{
    /// <summary>The case identifiers generated code declares members with,
    /// taken before any case in a suite is named.</summary>
    public static readonly IReadOnlyList<string> ReservedInSuite =
        ["Setup", "Teardown", "BeforeEach", "AfterEach", "TestContext", "Session"];

    private readonly HashSet<string> _taken = new(StringComparer.OrdinalIgnoreCase);

    public Identifiers(IEnumerable<string>? reserved = null)
    {
        foreach (var one in reserved ?? [])
        {
            _taken.Add(one);
        }
    }

    /// <summary>The identifier a name gives before collisions.</summary>
    public static string Of(string name, string fallback)
    {
        var built = new StringBuilder();
        var startOfWord = true;
        foreach (var one in name)
        {
            if (char.IsAsciiLetterOrDigit(one))
            {
                built.Append(startOfWord ? char.ToUpperInvariant(one) : one);
                startOfWord = false;
            }
            else
            {
                startOfWord = true;
            }
        }
        var text = built.Length == 0 ? fallback : built.ToString();
        return char.IsAsciiDigit(text[0]) ? "N" + text : text;
    }

    /// <summary>The next free identifier for a name.</summary>
    public string Take(string name, string fallback)
    {
        var wanted = Of(name, fallback);
        var candidate = wanted;
        for (var number = 2; !_taken.Add(candidate); number++)
        {
            candidate = string.Create(CultureInfo.InvariantCulture, $"{wanted}_{number}");
        }
        return candidate;
    }
}
