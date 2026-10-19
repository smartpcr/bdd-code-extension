namespace Bdd.Suite.Testing;

/// <summary>
/// Which test framework a C# test project generates for (DEC-T10): the command
/// line's <c>--provider</c>, else the config's <c>provider</c>, else what the
/// project's package references say.
/// </summary>
public static class Providers
{
    /// <summary>The C# providers, and the package that identifies each.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> CSharp = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["mstest"] = ["MSTest", "MSTest.TestFramework"],
        ["nunit"] = ["NUnit"],
        ["xunit"] = ["xunit.v3", "xunit.v3.core"],
    };

    /// <summary>The provider the package references identify, empty when none
    /// does; refused when more than one does, because the choice is then the
    /// project's to make.</summary>
    public static string Detect(IEnumerable<string> packages)
    {
        var ids = packages.Select(one => one.Trim()).Where(one => one.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var found = CSharp.Where(entry => entry.Value.Any(ids.Contains)).Select(entry => entry.Key).ToList();
        return found.Count switch
        {
            0 => string.Empty,
            1 => found[0],
            _ => throw new TestsConfigException(
                $"the project references {string.Join(" and ", found)}; name one with provider in bddsuite.tests.yaml."),
        };
    }

    /// <summary>The provider to generate for.</summary>
    public static string Choose(string given, IEnumerable<TestsConfig> configs, IEnumerable<string> packages)
    {
        if (given.Length > 0)
        {
            return given;
        }
        var named = configs.Select(config => config.Provider).Where(one => one.Length > 0).Distinct(StringComparer.Ordinal).ToList();
        if (named.Count > 1)
        {
            throw new TestsConfigException($"the configs name different providers: {string.Join(", ", named)}.");
        }
        if (named.Count == 1)
        {
            return named[0];
        }
        var detected = Detect(packages);
        return detected.Length > 0
            ? detected
            : throw new TestsConfigException(
                "no provider: name one with provider in bddsuite.tests.yaml, or reference MSTest, NUnit or xunit.v3.");
    }
}
