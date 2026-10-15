using System.Globalization;
using Bdd.Suite.Expressions;
using Bdd.Suite.Model;
using Bdd.Suite.Values;

namespace Bdd.Suite.Tests;

/// <summary>
/// The expression table, row by row.
///
/// conformance/expressions/cases.yaml is the specification. Every row
/// states a value and its type, or the code it is refused with, and this binding
/// is held to all of them.
/// </summary>
public sealed class ExpressionCorpusTests
{
    /// <summary>What the table calls the type of a produced value.</summary>
    private static string Kind(object? produced) => produced switch
    {
        null => "null",
        bool => "bool",
        string => "string",
        long or int => "int",
        double => "float",
        List<object?> => "list",
        OrderedMap => "object",
        _ => produced.GetType().Name,
    };

    /// <summary>Compare a produced value with the one the table states, by the
    /// same rule the runner compares by.</summary>
    private static bool Same(object? produced, object? expected)
    {
        if (produced is null && expected is null)
        {
            return true;
        }
        if (Value.TryNumber(produced, out var one) && Value.TryNumber(expected, out var other))
        {
            return one.Equals(other);
        }
        return string.Equals(Value.Text(produced), Value.Text(expected), StringComparison.Ordinal);
    }

    [Fact]
    public void EveryRowOfTheExpressionTable()
    {
        var corpus = Corpus.Find();
        var context = corpus.Yaml("expressions/context.yaml");
        var cases = corpus.Yaml("expressions/cases.yaml");
        var rows = cases.List("cases") ?? [];
        Assert.True(rows.Count > 100, $"only {rows.Count} rows");

        var failures = new List<string>();
        var used = new HashSet<string>(StringComparer.Ordinal);
        foreach (var raw in rows)
        {
            if (raw is not OrderedMap row)
            {
                continue;
            }
            var template = row.Value("template") as string;
            var text = template ?? row.Text("expr");
            var label = template is not null
                ? string.Create(CultureInfo.InvariantCulture, $"template [{text}]")
                : string.Create(CultureInfo.InvariantCulture, $"expression [{text}]");
            foreach (var name in Expression.Read(text, false).Functions)
            {
                used.Add(name);
            }
            var scope = Scope.Against(context, Where.CorpusComposite.Roots);
            if (row.Value("stable") as bool? ?? false)
            {
                scope = scope.Stable();
            }

            object? produced = null;
            ExpressionException? refused = null;
            try
            {
                produced = template is not null
                    ? Expression.Expand(text, scope)
                    : Expression.Evaluate(text, scope);
            }
            catch (ExpressionException failure)
            {
                refused = failure;
            }

            if (row.Value("code") is string code)
            {
                if (refused is null)
                {
                    failures.Add(string.Create(CultureInfo.InvariantCulture,
                        $"{label} produced {Value.Text(produced)}; the table says {code}"));
                }
                else if (!string.Equals(refused.Code, code, StringComparison.Ordinal))
                {
                    failures.Add(string.Create(CultureInfo.InvariantCulture,
                        $"{label} is refused with {refused}; the table says {code}"));
                }
                continue;
            }
            if (refused is not null)
            {
                failures.Add(string.Create(CultureInfo.InvariantCulture,
                    $"{label} is refused with {refused}; the table says it produces a value"));
                continue;
            }
            if (row.Value("type") is string expectedType && !string.Equals(Kind(produced), expectedType, StringComparison.Ordinal))
            {
                failures.Add(string.Create(CultureInfo.InvariantCulture,
                    $"{label} has type {Kind(produced)}; the table says {expectedType}"));
                continue;
            }
            if (row.Has("value") && !Same(produced, row.Value("value")))
            {
                failures.Add(string.Create(CultureInfo.InvariantCulture,
                    $"{label} is [{Value.Text(produced)}]; the table says [{Value.Text(row.Value("value"))}]"));
            }
            if (row.Value("count") is long expectedCount)
            {
                var count = produced is List<object?> items ? items.Count : -1;
                if (count != expectedCount)
                {
                    failures.Add(string.Create(CultureInfo.InvariantCulture,
                        $"{label} holds {count} entries; the table says {expectedCount}"));
                }
            }
            if (row.Value("length") is long expectedLength)
            {
                var length = Value.Text(produced).Length;
                if (length != expectedLength)
                {
                    failures.Add(string.Create(CultureInfo.InvariantCulture,
                        $"{label} is {length} characters; the table says {expectedLength}"));
                }
            }
        }

        var missing = Expression.FunctionNames().Where(name => !used.Contains(name)).ToList();
        Assert.True(missing.Count == 0, $"the table calls no: {string.Join(", ", missing)}");
        Assert.True(failures.Count == 0,
            $"{failures.Count} of {rows.Count} rows differ:\n{string.Join('\n', failures)}");
    }
}
