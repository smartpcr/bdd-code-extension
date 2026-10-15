using System.Globalization;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace Bdd.Suite.Model;

/// <summary>A one-based place in a file. Zero would be somewhere no editor can
/// go to.</summary>
public readonly record struct Position(int Line, int Column)
{
    /// <summary>Both fields clamped to one.</summary>
    public static Position At(int line, int column) =>
        new(line < 1 ? 1 : line, column < 1 ? 1 : column);

    /// <summary>The position of a file that could not be read far enough to have
    /// one.</summary>
    public static Position Start { get; } = new(1, 1);
}

/// <summary>Where a value and the key that names it are.</summary>
public readonly record struct NodePosition(Position Key, Position Value);

/// <summary>Why a file could not be read as a suite. Always E100: nothing below
/// can be checked, so there is no second finding to report beside it.</summary>
public sealed class LoadException(string message, Position position) : Exception(message)
{
    public Position Position { get; } = position;
}

/// <summary>
/// One suite file, read once as a value and as a map of where everything is.
///
/// Two things come out of a parse. The value is what the schema is checked
/// against and what every pass walks. The position map is what turns a finding
/// into a place an editor can go to: a JSON pointer to the line and column of
/// the key that names a value and of the value itself, because a structural
/// finding points at the misspelled key and a dataflow finding points at the
/// value that carries the reference.
/// </summary>
public sealed class SuiteDocument
{
    private readonly Dictionary<string, NodePosition> _positions = [];

    public object? Value { get; private set; }

    /// <summary>The position of one pointer, or the start of the file when the
    /// pointer names nothing. A finding always has somewhere to point.</summary>
    public NodePosition At(string pointer) =>
        _positions.TryGetValue(pointer, out var found)
            ? found
            : new NodePosition(Position.Start, Position.Start);

    /// <summary>One pointer segment, escaped the way JSON pointers escape.</summary>
    public static string Escape(string segment) =>
        segment.Replace("~", "~0", StringComparison.Ordinal).Replace("/", "~1", StringComparison.Ordinal);

    /// <summary>A pointer built from a parent and one more segment.</summary>
    public static string Child(string parent, string segment) => parent + "/" + Escape(segment);

    /// <summary>Read one suite file.</summary>
    public static SuiteDocument Load(string text)
    {
        var stream = new YamlStream();
        try
        {
            stream.Load(new StringReader(text));
        }
        catch (Exception failure) when (failure is YamlException or InvalidOperationException
                                            or ArgumentException or FormatException)
        {
            // The start of the file, not where this parser stopped. Four YAML
            // parsers stop in four places on the same broken file, and a position
            // two bindings cannot agree on is not a contract (diagnostics.md).
            //
            // More than YamlException is caught because YamlDotNet's scanner does
            // not always reach the point where it would raise one: a flow
            // sequence that is never closed comes out of the scanner as an
            // InvalidOperationException. To a suite author all of these are the
            // same thing, which is a file that is not YAML.
            throw new LoadException(failure.Message, Position.Start);
        }
        if (stream.Documents.Count == 0)
        {
            throw new LoadException("the file holds no YAML document.", Position.Start);
        }

        var document = new SuiteDocument();
        var root = stream.Documents[0].RootNode;
        document.Value = document.Build(root, string.Empty);
        var position = PositionOf(root);
        document._positions[string.Empty] = new NodePosition(position, position);
        return document;
    }

    private static Position PositionOf(YamlNode node) =>
        Position.At((int)node.Start.Line, (int)node.Start.Column);

    /// <summary>Turn one node into a value, recording where each part of it is.</summary>
    private object? Build(YamlNode node, string pointer)
    {
        switch (node)
        {
            case YamlMappingNode mapping:
            {
                // YamlDotNet gives a block mapping its first key's position, which
                // is where a reader would say it begins, and a flow mapping its
                // brace.
                var result = new OrderedMap();
                foreach (var pair in mapping.Children)
                {
                    var name = pair.Key is YamlScalarNode key ? key.Value ?? string.Empty : pair.Key.ToString();
                    var keyPointer = Child(pointer, name);
                    _positions[keyPointer] = new NodePosition(PositionOf(pair.Key), PositionOf(pair.Value));
                    result.Set(name, Build(pair.Value, keyPointer));
                }
                return result;
            }
            case YamlSequenceNode sequence:
            {
                var items = new List<object?>(sequence.Children.Count);
                for (var index = 0; index < sequence.Children.Count; index++)
                {
                    var item = sequence.Children[index];
                    var itemPointer = string.Create(CultureInfo.InvariantCulture, $"{pointer}/{index}");
                    var position = PositionOf(item);
                    _positions[itemPointer] = new NodePosition(position, position);
                    items.Add(Build(item, itemPointer));
                }
                return items;
            }
            case YamlScalarNode scalar:
                return Scalar(scalar);
            default:
                // An alias resolves to nothing here. The suite format has no use
                // for one, and a suite that used one is a suite two bindings
                // would read differently.
                return null;
        }
    }

    /// <summary>
    /// Resolve one YAML scalar to the value it names.
    ///
    /// The core schema: null and ~ and nothing at all are null, true and false
    /// are booleans, a whole number is an integer and a decimal one is a float.
    /// Anything quoted is a string whatever it looks like, which is what makes
    /// timeoutSec: "30" a type error rather than a number.
    /// </summary>
    private static object? Scalar(YamlScalarNode node)
    {
        var text = node.Value ?? string.Empty;
        var quoted = node.Style is ScalarStyle.SingleQuoted or ScalarStyle.DoubleQuoted
            or ScalarStyle.Literal or ScalarStyle.Folded;
        if (quoted)
        {
            return text;
        }
        switch (text)
        {
            case "":
            case "~":
            case "null":
            case "Null":
            case "NULL":
                return null;
            case "true":
            case "True":
            case "TRUE":
                return true;
            case "false":
            case "False":
            case "FALSE":
                return false;
        }
        if (long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var whole))
        {
            return whole;
        }
        if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var fraction))
        {
            return fraction;
        }
        return text;
    }

    /// <summary>Read one pointer out of this document.</summary>
    public bool TryGet(string pointer, out object? value) => Pointer.TryWalk(Value, pointer, out value);
}

/// <summary>Walking a JSON pointer into a value.</summary>
public static class Pointer
{
    /// <summary>Walk a JSON pointer into a value.</summary>
    public static bool TryWalk(object? value, string pointer, out object? found)
    {
        found = value;
        if (pointer.Length == 0)
        {
            return true;
        }
        foreach (var raw in pointer.TrimStart('/').Split('/'))
        {
            var segment = raw.Replace("~1", "/", StringComparison.Ordinal)
                .Replace("~0", "~", StringComparison.Ordinal);
            switch (found)
            {
                case OrderedMap map:
                    if (!map.TryGet(segment, out found))
                    {
                        found = null;
                        return false;
                    }
                    break;
                case List<object?> items:
                    if (!int.TryParse(segment, NumberStyles.Integer, CultureInfo.InvariantCulture, out var index)
                        || index < 0 || index >= items.Count)
                    {
                        found = null;
                        return false;
                    }
                    found = items[index];
                    break;
                default:
                    found = null;
                    return false;
            }
        }
        return true;
    }
}
