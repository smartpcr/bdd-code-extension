using System.Globalization;
using Bdd.Suite.Assertions;
using Bdd.Suite.Model;
using Bdd.Suite.Values;

namespace Bdd.Suite.Tests;

/// <summary>The assertion table, row by row.</summary>
public sealed class AssertionCorpusTests
{
    [Fact]
    public void EveryRowOfTheAssertionTable()
    {
        var corpus = Corpus.Find();
        var cases = corpus.Yaml("asserts/cases.yaml");
        var rows = cases.List("cases") ?? [];
        Assert.True(rows.Count > 80, $"only {rows.Count} rows");

        var failures = new List<string>();
        var used = new HashSet<string>(StringComparer.Ordinal);
        foreach (var raw in rows)
        {
            if (raw is not OrderedMap row)
            {
                continue;
            }
            var operator_ = row.Text("op");
            used.Add(operator_);
            var actual = row.Value("actual");
            var expected = row.Value("expected");
            var present = row.Value("present") as bool? ?? true;
            var label = string.Create(CultureInfo.InvariantCulture,
                $"{operator_} of [{Value.Text(actual)}] against [{Value.Text(expected)}]");

            bool held = false;
            CompareException? refused = null;
            try
            {
                held = Comparer.Compare(operator_, actual, expected, present);
            }
            catch (CompareException failure)
            {
                refused = failure;
            }

            switch (row.Text("result"))
            {
                case "error":
                    if (refused is null)
                    {
                        failures.Add(string.Create(CultureInfo.InvariantCulture,
                            $"{label} returned {held}; the table says it cannot be compared at all"));
                        break;
                    }
                    if (row.Value("code") is string code && !string.Equals(refused.Code, code, StringComparison.Ordinal))
                    {
                        failures.Add(string.Create(CultureInfo.InvariantCulture,
                            $"{label} is refused with [{refused}]; the table says {code}"));
                    }
                    break;
                case "pass":
                    if (refused is not null)
                    {
                        failures.Add(string.Create(CultureInfo.InvariantCulture,
                            $"{label} was refused with [{refused}]; the table says it passes"));
                    }
                    else if (!held)
                    {
                        failures.Add(string.Create(CultureInfo.InvariantCulture,
                            $"{label} is false; the table says it passes"));
                    }
                    break;
                case "fail":
                    if (refused is not null)
                    {
                        failures.Add(string.Create(CultureInfo.InvariantCulture,
                            $"{label} was refused with [{refused}]; the table says it fails"));
                    }
                    else if (held)
                    {
                        failures.Add(string.Create(CultureInfo.InvariantCulture,
                            $"{label} is true; the table says it fails"));
                    }
                    break;
                default:
                    failures.Add(string.Create(CultureInfo.InvariantCulture,
                        $"{label} states result [{row.Text("result")}], which is not pass, fail or error"));
                    break;
            }
        }

        var missing = Comparer.Operators
            .Where(name => !string.Equals(name, "script", StringComparison.Ordinal) && !used.Contains(name))
            .ToList();
        Assert.True(missing.Count == 0, $"the table has no row for: {string.Join(", ", missing)}");
        Assert.True(failures.Count == 0,
            $"{failures.Count} of {rows.Count} rows differ:\n{string.Join('\n', failures)}");
    }
}
