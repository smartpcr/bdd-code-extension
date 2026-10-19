using System.Text;

namespace Bdd.Suite.Testing;

/// <summary>One file the generator writes: its name in the output folder and
/// its text.</summary>
public sealed record GeneratedFile(string Name, string Text);

/// <summary>What writing (or checking) the output folder found.</summary>
public sealed record GenerateOutcome(IReadOnlyList<string> Written, IReadOnlyList<string> Removed, IReadOnlyList<string> Stale);

/// <summary>
/// <c>suiterun generate</c> for C# (spec/test-plan.md): render each plan with a
/// provider's template, then bring the output folder in line with it. A file is
/// written only when its text changed, so an unchanged suite does not make the
/// compiler run again; a generated file no suite needs any more is deleted, so
/// a deleted suite's tests leave the assembly (T0). Only files carrying the
/// generator's marker are ever replaced or deleted.
/// </summary>
public static class Generator
{
    /// <summary>The files a provider's template makes from the plans.</summary>
    public static IReadOnlyList<GeneratedFile> Render(IReadOnlyList<TestPlan> plans, string provider)
    {
        if (!string.Equals(provider, "mstest", StringComparison.Ordinal))
        {
            throw new TestsConfigException(Providers.CSharp.ContainsKey(provider)
                ? $"the {provider} provider is not built yet (docs/test-providers, stage T3); mstest is."
                : $"{provider} is not a C# provider; the C# runtime generates for mstest, nunit and xunit.");
        }
        var files = new List<GeneratedFile>();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var plan in plans)
        {
            var ns = plan.Config.Namespace.Length > 0 ? plan.Config.Namespace : CSharpCode.DefaultNamespace;
            foreach (var suite in plan.Suites)
            {
                var name = $"{ns}.{suite.Id}.g.cs";
                if (!names.Add(name))
                {
                    throw new TestsConfigException(
                        $"two configs generate {ns}.Suite_{suite.Id}; give one of them its own output.namespace.");
                }
                files.Add(new GeneratedFile(name, MsTestTemplate.Suite(suite, plan.Config, ns)));
            }
        }
        files.Add(new GeneratedFile("BddSuite.Run.g.cs", MsTestTemplate.Assembly(plans.Select(plan => plan.Config).ToList())));
        return files;
    }

    /// <summary>Write the files into the folder, or with <paramref name="check"/>
    /// only say which differ.</summary>
    public static GenerateOutcome Write(string folder, IReadOnlyList<GeneratedFile> files, bool check)
    {
        var written = new List<string>();
        var removed = new List<string>();
        var stale = new List<string>();
        if (!check)
        {
            Directory.CreateDirectory(folder);
        }
        var wanted = files.Select(file => file.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var file in files)
        {
            var path = Path.Combine(folder, file.Name);
            var current = File.Exists(path) ? File.ReadAllText(path) : null;
            if (string.Equals(current, file.Text, StringComparison.Ordinal))
            {
                continue;
            }
            if (check)
            {
                stale.Add(file.Name);
                continue;
            }
            File.WriteAllText(path, file.Text, new UTF8Encoding(false));
            written.Add(file.Name);
        }
        if (Directory.Exists(folder))
        {
            foreach (var path in Directory.EnumerateFiles(folder, "*.g.cs").Order(StringComparer.Ordinal))
            {
                var name = Path.GetFileName(path);
                if (wanted.Contains(name) || !Owned(path))
                {
                    continue;
                }
                if (check)
                {
                    stale.Add(name);
                    continue;
                }
                File.Delete(path);
                removed.Add(name);
            }
        }
        return new GenerateOutcome(written, removed, stale);
    }

    private static bool Owned(string path)
    {
        using var reader = new StreamReader(path);
        return string.Equals(reader.ReadLine(), CSharpCode.Marker, StringComparison.Ordinal);
    }
}
