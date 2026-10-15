using System.Globalization;
using System.Text;
using Bdd.Suite.Model;

namespace Bdd.Suite.Diagnostics;

/// <summary>Whether a finding fails the validation, or only fails it under
/// --strict.</summary>
public enum Severity
{
    Error,
    Warning,
}

/// <summary>
/// One thing wrong with one suite.
///
/// The codes and the positions are the contract between four bindings; the
/// message wording is not (spec/diagnostics.md). Everything here
/// follows from that: the sort is total so that two bindings that find the same
/// problems write byte-identical JSON, and paths are relative with forward
/// slashes so that three operating systems produce one string.
/// </summary>
public sealed record Diagnostic(
    string Code,
    Severity Severity,
    string File,
    Position Position,
    string Message,
    string Suggestion = "")
{
    /// <summary>One finding that fails the validation.</summary>
    public static Diagnostic Error(string code, string file, Position position, string message) =>
        new(code, Diagnostics.Severity.Error, file, position, message);

    /// <summary>One that only fails it under --strict.</summary>
    public static Diagnostic Warning(string code, string file, Position position, string message) =>
        new(code, Diagnostics.Severity.Warning, file, position, message);

    /// <summary>Add the nearest legal spelling, when there is one. Never part of
    /// what two bindings are compared on: it is help, and help may differ.</summary>
    public Diagnostic Suggest(string suggestion) =>
        suggestion.Length == 0 ? this : this with { Suggestion = suggestion };

    /// <summary>The word the schema and the report use for this severity.</summary>
    public string SeverityName => Severity == Diagnostics.Severity.Warning ? "warning" : "error";

    /// <summary>`file:line:column  CODE  message`, with the suggestion indented
    /// under it.</summary>
    public string Human()
    {
        var head = string.Create(CultureInfo.InvariantCulture,
            $"{File}:{Position.Line}:{Position.Column}  {Code}  {Message}");
        return Suggestion.Length == 0 ? head : head + "\n    " + Suggestion;
    }
}

/// <summary>The two ways a set of findings is written, and the order they are
/// written in.</summary>
public static class Findings
{
    /// <summary>Order by file, then line, then column, then code, then message.
    /// Total, so that two bindings cannot disagree by ordering.</summary>
    public static int Compare(Diagnostic left, Diagnostic right)
    {
        var byFile = string.CompareOrdinal(left.File, right.File);
        if (byFile != 0)
        {
            return byFile;
        }
        if (left.Position.Line != right.Position.Line)
        {
            return left.Position.Line - right.Position.Line;
        }
        if (left.Position.Column != right.Position.Column)
        {
            return left.Position.Column - right.Position.Column;
        }
        var byCode = string.CompareOrdinal(left.Code, right.Code);
        return byCode != 0 ? byCode : string.CompareOrdinal(left.Message, right.Message);
    }

    /// <summary>The same findings, in the one order every binding writes them
    /// in, each once.</summary>
    public static List<Diagnostic> Sorted(IEnumerable<Diagnostic> findings)
    {
        var out_ = findings.ToList();
        // A stable sort, so two findings that compare equal keep the order they
        // were found in rather than swapping between runs.
        var ordered = out_.OrderBy(finding => finding, Comparer<Diagnostic>.Create(Compare)).ToList();
        // Two findings with the same file, position, code and message are one
        // finding, as in the PowerShell binding. The structural pass checks a
        // step's common fields twice (against the envelope, then against its
        // action's branch), so a refused `why` would otherwise be reported twice.
        var unique = new List<Diagnostic>(ordered.Count);
        foreach (var finding in ordered)
        {
            if (unique.Count > 0 && Compare(unique[^1], finding) == 0)
            {
                continue;
            }
            unique.Add(finding);
        }
        return unique;
    }

    /// <summary>Whether a set of findings fails the validation. A warning only
    /// does under --strict.</summary>
    public static bool Fails(IEnumerable<Diagnostic> findings, bool strict) =>
        findings.Any(finding => strict || finding.Severity == Severity.Error);

    /// <summary>The document `lint --json` writes.</summary>
    public static string ToJson(IReadOnlyList<Diagnostic> findings)
    {
        if (findings.Count == 0)
        {
            return "[]";
        }
        var built = new StringBuilder("[\n");
        for (var index = 0; index < findings.Count; index++)
        {
            var finding = findings[index];
            var one = new OrderedMap();
            one.Set("code", finding.Code);
            one.Set("severity", finding.SeverityName);
            one.Set("file", finding.File);
            one.Set("line", (long)finding.Position.Line);
            one.Set("column", (long)finding.Position.Column);
            one.Set("message", finding.Message);
            if (finding.Suggestion.Length > 0)
            {
                one.Set("suggestion", finding.Suggestion);
            }
            built.Append(Indent(Pretty(one), "  "));
            built.Append(index + 1 < findings.Count ? ",\n" : "\n");
        }
        built.Append(']');
        return built.ToString();
    }

    /// <summary>One object as the indented JSON `--json` writes, key order
    /// kept.</summary>
    private static string Pretty(OrderedMap map)
    {
        var built = new StringBuilder("{\n");
        for (var index = 0; index < map.Keys.Count; index++)
        {
            var key = map.Keys[index];
            built.Append("  ");
            built.Append(System.Text.Json.JsonSerializer.Serialize(key));
            built.Append(": ");
            var value = new StringBuilder();
            OrderedMap.WriteJson(map.Value(key), value);
            built.Append(value);
            built.Append(index + 1 < map.Keys.Count ? ",\n" : "\n");
        }
        built.Append('}');
        return built.ToString();
    }

    private static string Indent(string text, string prefix) =>
        string.Join("\n", text.Split('\n').Select(line => prefix + line));

    /// <summary>A path as a diagnostic carries it: relative to the repository
    /// root when it is under it, and with forward slashes wherever it came
    /// from.</summary>
    public static string RelativePath(string full, string root)
    {
        var relative = Path.GetRelativePath(root, full);
        if (relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative))
        {
            return full.Replace('\\', '/');
        }
        return relative.Replace('\\', '/');
    }
}
