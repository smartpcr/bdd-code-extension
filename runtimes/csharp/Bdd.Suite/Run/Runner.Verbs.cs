using System.Globalization;
using Bdd.Suite.Cli;
using Bdd.Suite.Diagnostics;
using Bdd.Suite.Extensions;
using Bdd.Suite.Model;
using Bdd.Suite.Paths;
using Bdd.Suite.Schema;
using Bdd.Suite.Validation;

namespace Bdd.Suite.Run;

public static partial class Runner
{
    /// <summary>
    /// The workspace root (found from the working directory) and the schema
    /// directory this run reads from. With --schema-root no walk is needed:
    /// findings are then relative to the workspace root when there is one, else
    /// to the working directory.
    /// </summary>
    internal static (string Repository, string SchemaRoot) Roots(Options options, string? workingDirectory = null)
    {
        var cwd = workingDirectory ?? Directory.GetCurrentDirectory();
        var repository = RepositoryPaths.FindRoot(cwd);
        if (options.SchemaRoot.Length > 0)
        {
            return (repository ?? Path.GetFullPath(cwd), Path.GetFullPath(Path.Combine(cwd, options.SchemaRoot)));
        }
        if (repository is null)
        {
            throw new IOException(
                "the workspace root cannot be found from this directory (no test/e2e/schema above it); pass --schema-root.");
        }
        return (repository, RepositoryPaths.SchemaRoot(repository));
    }

    private static List<string> SelectedFiles(Options options) =>
        RepositoryPaths.Resolve(options.Path, Directory.GetCurrentDirectory());

    private static OrderedMap LoadSuite(string path)
    {
        string text;
        try
        {
            text = File.ReadAllText(path);
        }
        catch (IOException failure)
        {
            throw new IOException(string.Create(CultureInfo.InvariantCulture,
                $"{path} cannot be read: {failure.Message}"), failure);
        }
        try
        {
            return SuiteDocument.Load(text).Value as OrderedMap
                ?? throw new IOException(string.Create(CultureInfo.InvariantCulture,
                    $"{path} does not hold a YAML mapping."));
        }
        catch (LoadException failure)
        {
            throw new IOException(string.Create(CultureInfo.InvariantCulture,
                $"{path} is not valid YAML: {failure.Message}"), failure);
        }
    }

    /// <summary>`lint`: validate every selected suite and run nothing.</summary>
    public static Report Lint(Options options, Composite? extensions = null)
    {
        try
        {
            var (repository, schemaRoot) = Roots(options);
            var schema = SuiteSchema.Load(schemaRoot);
            var files = SelectedFiles(options);

            var found = new List<Diagnostic>();
            var settings = new ValidationOptions
            {
                Binding = options.Binding,
                BindingCheck = options.BindingCheck,
                Params = options.Params,
                Extensions = extensions ?? Composite.CoreOnly,
            };
            foreach (var path in files)
            {
                found.AddRange(Validator.File(path, Findings.RelativePath(path, repository), schema, settings));
            }
            found = Findings.Sorted(found);

            var fails = Findings.Fails(found, options.Strict);
            string out_;
            if (options.Json)
            {
                out_ = Findings.ToJson(found);
            }
            else
            {
                var lines = found.Select(finding => finding.Human()).ToList();
                lines.Add(string.Create(CultureInfo.InvariantCulture,
                    $"Lint {(fails ? "failed" : "clean")}: {files.Count} suite file(s), {found.Count} finding(s)."));
                out_ = string.Join('\n', lines);
            }
            return new Report { Out = out_, Code = fails ? Exit.Refused : Exit.Passed };
        }
        catch (IOException failure)
        {
            return Report.Refused(failure.Message);
        }
    }
}
