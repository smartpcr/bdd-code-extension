using System.Diagnostics;
using System.Text.Json;
using System.Xml.Linq;
using Bdd.Suite.Example;
using Bdd.Suite.Extensions;
using Bdd.Suite.Model;
using Bdd.Suite.Run;

namespace Bdd.Suite.Tests;

/// <summary>
/// E3, the C# part: an extension built outside the runtime, on its public API
/// only, adds an action, a context key, an option and a rule; the plain runtime
/// has none of them; two extensions cannot define one action.
/// </summary>
public sealed class ExampleTests
{
    private static string SchemaRoot => Path.Combine(Where.Example, "schema");

    private static string Suite => Path.Combine(Where.Example, "suites", "echo.yml");

    private sealed record Outcome(int Code, string Out, string Err);

    private static Outcome Run(IReadOnlyList<string> arguments, params IExtension[] extensions)
    {
        var stdout = new StringWriter();
        var stderr = new StringWriter();
        var code = Runner.Run(arguments, stdout, stderr, extensions);
        return new Outcome(code, stdout.ToString(), stderr.ToString());
    }

    private static (int Code, List<string> Findings) Lint(params IExtension[] extensions)
    {
        var got = Run(["lint", "--schema-root", SchemaRoot, "--path", Suite, "--json"], extensions);
        using var parsed = JsonDocument.Parse(got.Out);
        var findings = parsed.RootElement.EnumerateArray()
            .Select(one => $"{one.GetProperty("code").GetString()} {one.GetProperty("line").GetInt32()}:{one.GetProperty("column").GetInt32()}")
            .ToList();
        return (got.Code, findings);
    }

    [Fact]
    public void WithTheExtensionTheActionRunsRegionReadsTheOptionAndTheRuleReportsItsCeiling()
    {
        // The suite asserts e.echoed equals 'eu:hello from eu': the action ran,
        // ${region} read the option, and the action saw its extension's state.
        var got = Run(["run", "--schema-root", SchemaRoot, "--path", Suite, "--region", "eu"], new EchoExtension());
        Assert.True(got.Code == 0, got.Out + got.Err);
        Assert.Contains("[passed] echoes-with-the-region", got.Out, StringComparison.Ordinal);

        // Only the rule: timeoutSec 30 in a suite tagged slow.
        var (code, findings) = Lint(new EchoExtension());
        Assert.Equal(2, code);
        Assert.Equal(["E205 5:17"], findings);

        var listed = Run(["actions", "--json"], new EchoExtension());
        Assert.Contains("example.echo", JsonSerializer.Deserialize<List<string>>(listed.Out)!);
    }

    [Fact]
    public void WithoutTheExtensionRegionIsE301NoCeilingTheOptionIsRefusedAndTheActionHasNoHandler()
    {
        // Lint follows the catalog, so example.echo is not E104; the context key
        // is unknown and the slow rule is not there.
        var (code, findings) = Lint();
        Assert.Equal(2, code);
        Assert.Equal(["E301 9:15"], findings);

        var refused = Run(["run", "--schema-root", SchemaRoot, "--path", Suite, "--region", "eu"]);
        Assert.Equal(2, refused.Code);
        Assert.Contains("run does not take --region", refused.Err, StringComparison.Ordinal);

        var scratch = Path.Combine(Path.GetTempPath(), "suiterun-example-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(scratch);
        try
        {
            var results = Path.Combine(scratch, "results.xml");
            var failed = Run(["run", "--schema-root", SchemaRoot, "--path", Suite, "--results", results, "--format", "junit"]);
            Assert.Equal(1, failed.Code);
            Assert.Contains("[failed] echoes-with-the-region", failed.Out, StringComparison.Ordinal);
            // The step reads ${region} first, so without the context key it
            // fails there.
            Assert.Contains("E301: ${region} resolves to nothing", FailureMessage(results), StringComparison.Ordinal);

            // The same step without ${region} reaches dispatch, and fails it by
            // name.
            var plain = Path.Combine(scratch, "echo.yml");
            File.WriteAllText(plain, File.ReadAllText(Suite).Replace("hello from ${region}", "hello", StringComparison.Ordinal));
            failed = Run(["run", "--schema-root", SchemaRoot, "--path", plain, "--results", results, "--format", "junit"]);
            Assert.Equal(1, failed.Code);
            Assert.Contains("Unknown action: example.echo. No extension of this runtime registers it.",
                FailureMessage(results), StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(scratch, true);
        }
    }

    private static string FailureMessage(string junit) =>
        XDocument.Load(junit).Descendants("failure").Select(failure => (string?)failure.Attribute("message")).Single() ?? string.Empty;

    [Fact]
    public void TheSlowRuleCapsACaseAtRunTime()
    {
        var limit = new EchoExtension().Rules.CaseLimitSec!;
        var slow = SuiteDocument.Load("tags: [slow]\n").Value as OrderedMap ?? new OrderedMap();
        var fast = SuiteDocument.Load("tags: [fast]\n").Value as OrderedMap ?? new OrderedMap();
        Assert.Equal(EchoExtension.SlowCeilingSec, limit(slow, 30));
        Assert.Equal(5, limit(slow, 5));
        Assert.Equal(30, limit(fast, 30));
        Assert.Equal(EchoExtension.SlowCeilingSec, Composite.Compose(new EchoExtension()).CaseLimitSec(slow, 30));
    }

    [Fact]
    public void TwoExtensionsDefiningOneActionAreRefusedBeforeAnythingRuns()
    {
        var twin = new Extension { Name = "twin", Actions = [new ActionRegistration("example.echo", _ => null)] };
        var got = Run(["actions"], new EchoExtension(), twin);
        Assert.Equal(2, got.Code);
        Assert.Equal(string.Empty, got.Out);
        Assert.Contains("Action example.echo is defined by both example and twin.", got.Err, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheExampleIsItsOwnProgramAndReachesOnlyTheLibrarysPublicTypes()
    {
        // Its own program, run as a separate process from the build output.
        var program = ExampleProgram();
        var start = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var argument in new[] { program, "run", "--schema-root", SchemaRoot, "--path", Suite, "--region", "eu" })
        {
            start.ArgumentList.Add(argument);
        }
        using var process = Process.Start(start) ?? throw new InvalidOperationException("dotnet did not start");
        var reading = process.StandardOutput.ReadToEndAsync();
        var readingErrors = process.StandardError.ReadToEndAsync();
        using var limit = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        await process.WaitForExitAsync(limit.Token);
        var output = await reading;
        var errors = await readingErrors;
        Assert.True(process.ExitCode == 0, output + errors);
        Assert.Contains("[passed] echoes-with-the-region", output, StringComparison.Ordinal);

        // It references the library and nothing else of this runtime, and the
        // library opens its internals to the tests alone, so nothing but public
        // types is reachable from the example.
        var example = XDocument.Load(Path.Combine(Where.Example, "Bdd.Suite.Example.csproj"));
        Assert.Equal([@"..\Bdd.Suite\Bdd.Suite.csproj"],
            example.Descendants("ProjectReference").Select(reference => (string?)reference.Attribute("Include")));
        Assert.Empty(example.Descendants("PackageReference"));
        var library = XDocument.Load(Path.Combine(Where.Runtime, "Bdd.Suite", "Bdd.Suite.csproj"));
        Assert.Equal(["Bdd.Suite.Tests"],
            library.Descendants("InternalsVisibleTo").Select(granted => (string?)granted.Attribute("Include")));
        var referenced = typeof(EchoExtension).Assembly.GetReferencedAssemblies()
            .Select(name => name.Name ?? string.Empty)
            .Where(name => !name.StartsWith("System", StringComparison.Ordinal) && name != "netstandard")
            .ToList();
        Assert.Equal(["Bdd.Suite"], referenced);
    }

    /// <summary>The example's own build output: beside the tests' under
    /// artifacts/bin, in the same configuration and framework.</summary>
    private static string ExampleProgram()
    {
        var here = new DirectoryInfo(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        var framework = here.Name;
        var configuration = here.Parent!.Name;
        var bin = here.Parent!.Parent!.Parent!.FullName;
        var built = Path.Combine(bin, "Bdd.Suite.Example", configuration, framework, "Bdd.Suite.Example.dll");
        Assert.True(File.Exists(built), $"the example is not built at {built}");
        return built;
    }
}
