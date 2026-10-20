using System.Globalization;
using Bdd.Suite.Diagnostics;
using Bdd.Suite.Model;
using Bdd.Suite.Schema;
using Bdd.Suite.Validation;
using Bdd.Suite.Values;

namespace Bdd.Suite.Tests;

/// <summary>
/// The validate corpus: every entry, byte for byte.
///
/// A binding conforms when it finds the same problems at the same places. The
/// message wording is not compared, because it is deliberately not part of the
/// contract (spec/diagnostics.md).
/// </summary>
public sealed class ValidateCorpusTests(Xunit.Abstractions.ITestOutputHelper output)
{
    [Fact]
    public void EveryValidateEntry()
    {
        var corpus = Corpus.Find();
        var manifest = corpus.Manifest();
        var shipped = SuiteSchema.Load(corpus.SchemaRoot);

        var failures = new List<string>();
        var checked_ = 0;
        var pending = new List<string>();
        foreach (var entry in Corpus.Entries(manifest, "validate"))
        {
            var suite = entry.Text("suite");
            if (Corpus.PendingIn(entry, "csharp"))
            {
                pending.Add(suite);
                continue;
            }
            var path = corpus.Path(suite);
            var relative = Findings.RelativePath(path, corpus.Root);

            var binding = entry.Text("binding");
            var options = new ValidationOptions
            {
                Binding = binding.Length > 0 ? binding : "csharp",
                BindingCheck = entry.Value("bindingCheck") as bool? ?? false,
                Params = entry.Map("params") is { } given
                    ? given.Keys.Select(name =>
                        new KeyValuePair<string, string>(name, Value.Text(given.Value(name)))).ToList()
                    : [],
                // The corpus's context keys come from the corpus extension, as
                // they would from a workspace's own.
                Extensions = Where.CorpusComposite,
            };

            // An entry may name an overlay: a small catalog merged over the
            // shipped one, so a rule the catalog drives can be proved without
            // changing the catalog every binding reads.
            var effective = shipped;
            var overlayName = entry.Text("catalogOverlay");
            if (overlayName.Length > 0)
            {
                effective = shipped.WithOverlay(corpus.Yaml(overlayName));
            }

            var produced = Validator.File(path, relative, effective, options);
            var expectation = corpus.Json(entry.Text("expectation"));

            var expected = (expectation.List("diagnostics") ?? [])
                .OfType<OrderedMap>()
                .Select(row => string.Create(CultureInfo.InvariantCulture,
                    $"{row.Text("code")}@{Value.Text(row.Value("line"))}:{Value.Text(row.Value("column"))} [{row.Text("severity")}]"))
                .ToList();
            var actual = produced
                .Select(finding => string.Create(CultureInfo.InvariantCulture,
                    $"{finding.Code}@{finding.Position.Line}:{finding.Position.Column} [{finding.SeverityName}]"))
                .ToList();
            checked_++;
            if (!string.Equals(string.Join(' ', actual), string.Join(' ', expected), StringComparison.Ordinal))
            {
                failures.Add(string.Create(CultureInfo.InvariantCulture,
                    $"{suite}\n  produced: {string.Join(' ', actual)}\n  expected: {string.Join(' ', expected)}"));
                continue;
            }
            var strict = expectation.Value("strict") as bool? ?? false;
            var exit = Findings.Fails(produced, strict) ? 2L : 0L;
            var wanted = expectation.Value("exitCode") as long? ?? 0L;
            if (exit != wanted)
            {
                failures.Add(string.Create(CultureInfo.InvariantCulture,
                    $"{suite} exits {exit}; the expectation says {wanted}"));
            }
        }

        Corpus.ReportPending(output, "validate", pending);
        Assert.Equal(41, checked_);
        Assert.True(failures.Count == 0,
            $"{failures.Count} of {checked_} entries differ:\n{string.Join('\n', failures)}");
    }
}
