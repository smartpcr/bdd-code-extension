using System.Text;
using System.Text.Json;

namespace Bdd.Suite.Tests;

/// <summary>
/// The canonical report form, implemented here rather than in the binding.
///
/// conformance/report/canonicalise.md is the definition all four
/// bindings implement from. It lives in the test because the shipped output
/// keeps its timestamps: a person reading a report wants them, and only a
/// comparison does not.
/// </summary>
public static class Canonical
{
    /// <summary>When, how long, and on what. None of it is behaviour.</summary>
    private static readonly string[] VolatileAttributes =
    [
        "start-time", "end-time", "duration", "time", "timestamp",
        "hostname", "id", "clr-version", "engine-version",
    ];

    /// <summary>A stack trace belongs to the host runtime rather than to the
    /// suite, and JUnit puts the same thing in the text of a failure.</summary>
    private static readonly string[] VolatileElements = ["stack-trace"];

    private static readonly string[] TextlessElements = ["failure"];

    /// <summary>A small reader, which is all a report needs: elements,
    /// attributes and text, with no namespaces and no entities beyond the
    /// five.</summary>
    private sealed class Element
    {
        public string Name { get; set; } = string.Empty;
        public List<KeyValuePair<string, string>> Attributes { get; } = [];
        public List<Element> Children { get; } = [];
        public StringBuilder Text { get; } = new();
    }

    private static string Unescape(string text) => text
        .Replace("&lt;", "<", StringComparison.Ordinal)
        .Replace("&gt;", ">", StringComparison.Ordinal)
        .Replace("&quot;", "\"", StringComparison.Ordinal)
        .Replace("&apos;", "'", StringComparison.Ordinal)
        .Replace("&amp;", "&", StringComparison.Ordinal);

    private static Element Parse(string document)
    {
        var stack = new Stack<Element>();
        Element? root = null;
        var at = 0;
        while (at < document.Length)
        {
            if (document[at] != '<')
            {
                var start = at;
                while (at < document.Length && document[at] != '<')
                {
                    at++;
                }
                if (stack.Count > 0)
                {
                    stack.Peek().Text.Append(Unescape(document[start..at]));
                }
                continue;
            }
            var open = at;
            while (at < document.Length && document[at] != '>')
            {
                at++;
            }
            var tag = document[(open + 1)..Math.Min(at, document.Length)];
            at++;
            if (tag.StartsWith('?') || tag.StartsWith('!'))
            {
                continue;
            }
            if (tag.StartsWith('/'))
            {
                var finished = stack.Pop();
                if (stack.Count > 0)
                {
                    stack.Peek().Children.Add(finished);
                }
                else
                {
                    root = finished;
                }
                continue;
            }
            var empty = tag.EndsWith('/');
            var body = tag.TrimEnd('/');
            var space = body.IndexOf(' ', StringComparison.Ordinal);
            var element = new Element { Name = space < 0 ? body : body[..space] };
            if (space >= 0)
            {
                ParseAttributes(body[(space + 1)..], element);
            }
            if (empty)
            {
                if (stack.Count > 0)
                {
                    stack.Peek().Children.Add(element);
                }
                else
                {
                    root = element;
                }
                continue;
            }
            stack.Push(element);
        }
        return root ?? throw new InvalidOperationException("a report has a root element");
    }

    private static void ParseAttributes(string rest, Element element)
    {
        var index = 0;
        while (index < rest.Length)
        {
            while (index < rest.Length && char.IsWhiteSpace(rest[index]))
            {
                index++;
            }
            var start = index;
            while (index < rest.Length && rest[index] != '=')
            {
                index++;
            }
            if (index >= rest.Length)
            {
                break;
            }
            var key = rest[start..index].Trim();
            // Past the equals sign and the opening quote.
            index += 2;
            start = index;
            while (index < rest.Length && rest[index] != '"')
            {
                index++;
            }
            var value = rest[start..Math.Min(index, rest.Length)];
            index++;
            element.Attributes.Add(new KeyValuePair<string, string>(key, Unescape(value)));
        }
    }

    /// <summary>
    /// One line of captured output, with a JSON object's keys put in order.
    ///
    /// What a step captured is behaviour; the order a hash map happened to
    /// enumerate it in is not, and four bindings enumerate in four orders.
    /// </summary>
    private static string SortedJsonLine(string line)
    {
        var trimmed = line.Trim();
        if (!trimmed.StartsWith('{') || !trimmed.EndsWith('}'))
        {
            return line;
        }
        try
        {
            using var document = JsonDocument.Parse(trimmed);
            var built = new StringBuilder();
            WriteSorted(document.RootElement, built);
            return built.ToString();
        }
        catch (JsonException)
        {
            return line;
        }
    }

    /// <summary>The same value with every object's keys in ascending order. An
    /// array keeps the order it was written in, because that order is
    /// behaviour.</summary>
    private static void WriteSorted(JsonElement element, StringBuilder into)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
            {
                into.Append('{');
                var first = true;
                foreach (var property in element.EnumerateObject()
                             .OrderBy(property => property.Name, StringComparer.Ordinal))
                {
                    if (!first)
                    {
                        into.Append(',');
                    }
                    first = false;
                    into.Append(JsonSerializer.Serialize(property.Name));
                    into.Append(':');
                    WriteSorted(property.Value, into);
                }
                into.Append('}');
                return;
            }
            case JsonValueKind.Array:
            {
                into.Append('[');
                var first = true;
                foreach (var item in element.EnumerateArray())
                {
                    if (!first)
                    {
                        into.Append(',');
                    }
                    first = false;
                    WriteSorted(item, into);
                }
                into.Append(']');
                return;
            }
            default:
                into.Append(element.GetRawText());
                return;
        }
    }

    private static void Lines(Element element, int depth, List<string> lines)
    {
        var indent = new string(' ', 2 * depth);
        var attributes = element.Attributes
            .Where(pair => !VolatileAttributes.Contains(pair.Key, StringComparer.Ordinal))
            .Select(pair => pair.Key + "=\"" + pair.Value.Replace("\r\n", "\n", StringComparison.Ordinal) + "\"")
            .ToList();
        attributes.Sort(StringComparer.Ordinal);
        var open = attributes.Count == 0 ? element.Name : element.Name + " " + string.Join(' ', attributes);
        var children = element.Children
            .Where(child => !VolatileElements.Contains(child.Name, StringComparer.Ordinal))
            .ToList();
        var text = string.Empty;
        if (!TextlessElements.Contains(element.Name, StringComparer.Ordinal))
        {
            var flat = element.Text.ToString().Replace("\r\n", "\n", StringComparison.Ordinal).Trim().Split('\n');
            text = string.Join('\n', flat.Select(SortedJsonLine));
        }

        if (children.Count == 0 && text.Length == 0)
        {
            lines.Add(indent + "<" + open + "/>");
            return;
        }
        if (children.Count == 0)
        {
            var flat = text.Split('\n').Select(line => line.TrimEnd(' ', '\t')).ToList();
            if (flat.Count == 1)
            {
                lines.Add(indent + "<" + open + ">" + flat[0] + "</" + element.Name + ">");
                return;
            }
            lines.Add(indent + "<" + open + ">");
            foreach (var line in flat)
            {
                lines.Add(new string(' ', 2 * (depth + 1)) + line);
            }
            lines.Add(indent + "</" + element.Name + ">");
            return;
        }
        lines.Add(indent + "<" + open + ">");
        if (text.Length > 0)
        {
            lines.Add(new string(' ', 2 * (depth + 1)) + text);
        }
        foreach (var child in children)
        {
            Lines(child, depth + 1, lines);
        }
        lines.Add(indent + "</" + element.Name + ">");
    }

    /// <summary>One report as the text two reports are compared as.</summary>
    public static string Of(string document)
    {
        var lines = new List<string>();
        Lines(Parse(document), 0, lines);
        return string.Join('\n', lines) + "\n";
    }
}
