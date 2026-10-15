using System.Globalization;
using System.Text.Json;
using Bdd.Suite.Cli;
using Bdd.Suite.Execution;
using Bdd.Suite.Extensions;
using Bdd.Suite.Reporting;
using Bdd.Suite.Schema;
using Bdd.Suite.Tracing;

namespace Bdd.Suite.Run;

public static partial class Runner
{
    /// <summary>`list`: the cases a run would select, and nothing else.</summary>
    public static Report List(Options options)
    {
        try
        {
            var lines = new List<string>();
            foreach (var path in SelectedFiles(options))
            {
                var suite = LoadSuite(path);
                foreach (var held in SuiteExpansion.Cases(suite))
                {
                    if (!SuiteExpansion.TagsMatch(SuiteExpansion.CaseTags(suite, held), options.Tags))
                    {
                        continue;
                    }
                    lines.Add(string.Create(CultureInfo.InvariantCulture,
                        $"{Path.GetFileName(path)}  {held.Text("name")}"));
                }
            }
            return new Report { Out = string.Join('\n', lines), Code = Exit.Passed };
        }
        catch (IOException failure)
        {
            return Report.Refused(failure.Message);
        }
    }

    /// <summary>`actions`: what this runtime implements - the core's actions,
    /// wait, and every extension's - which is what a portability check is
    /// answered from.</summary>
    public static Report Actions(Options options, Composite? extensions = null)
    {
        var names = Executor.AllNames(extensions);
        if (!options.Json)
        {
            return new Report { Out = string.Join('\n', names), Code = Exit.Passed };
        }
        var text = JsonSerializer.Serialize(names, new JsonSerializerOptions { WriteIndented = true });
        return new Report { Out = text, Code = Exit.Passed };
    }

    /// <summary>`run`: execute every selected case.</summary>
    public static Report RunSuites(Options options, Composite? extensions = null)
    {
        var composite = extensions ?? Composite.CoreOnly;
        try
        {
            var (_, schemaRoot) = Roots(options);
            var schema = SuiteSchema.Load(schemaRoot);
            var files = SelectedFiles(options);

            var trace = new Trace();
            var settings = new RunOptions
            {
                Tags = options.Tags,
                Params = options.Params,
                DryRun = options.DryRun,
                RecordPath = Environment.GetEnvironmentVariable(composite.EnvPrefix + "RECORD_PATH") ?? string.Empty,
            };
            // Started once per run and shared by every file, so an extension's
            // state persists across files.
            var run = new RunExtensions(composite, composite.Start(options.ExtensionOptions));

            var suites = new List<SuiteResult>();
            var lines = new List<string>();
            foreach (var path in files)
            {
                var suite = LoadSuite(path);
                SuiteResult result;
                try
                {
                    result = Executor.RunFile(path, suite, schema, settings, trace, run);
                }
                catch (ExpansionException failure)
                {
                    return Report.Refused(failure.Message);
                }
                lines.Add(string.Create(CultureInfo.InvariantCulture, $"=== Suite: {Path.GetFileName(path)} ==="));
                foreach (var held in result.Cases)
                {
                    lines.Add(string.Create(CultureInfo.InvariantCulture, $"  [{held.Status,-5}] {held.Name}"));
                }
                suites.Add(result);
            }

            var failed = Executor.Failed(suites);

            if (options.TraceFile.Length > 0)
            {
                Write(options.TraceFile, trace.ToJson() + "\n");
                lines.Add("Trace written to " + options.TraceFile);
            }
            if (options.Results.Length > 0)
            {
                // Every text a report carries passes through the extensions'
                // redaction.
                var document = options.Format == ReportFormat.JUnit
                    ? Reports.JUnit(suites, run.Started.Redact)
                    : Reports.NUnit3(suites, run.Started.Redact);
                Write(options.Results, document);
                lines.Add("Results written to " + options.Results);
            }
            lines.Add(failed
                ? "One or more tests failed."
                : options.DryRun
                    ? "Suite validation passed; live tests were not run."
                    : "All selected tests passed.");

            return new Report { Out = string.Join('\n', lines), Code = failed ? Exit.Failed : Exit.Passed };
        }
        catch (IOException failure)
        {
            return Report.Refused(failure.Message);
        }
    }

    private static void Write(string path, string text)
    {
        var parent = Path.GetDirectoryName(Path.GetFullPath(path));
        if (parent is not null)
        {
            Directory.CreateDirectory(parent);
        }
        File.WriteAllText(path, text);
    }
}
