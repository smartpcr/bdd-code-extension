using System.Globalization;
using System.Text;
using Bdd.Suite.Model;
using Bdd.Suite.Values;

namespace Bdd.Suite.Expressions;

/// <summary>A refusal, carrying the code it is reported as.</summary>
public sealed class ExpressionException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;

    public override string ToString() => Code + ": " + Message;
}

/// <summary>How many arguments one function takes, and whether it gives the same
/// answer twice.</summary>
public readonly record struct FunctionSpec(int Min, int Max, bool Deterministic);

/// <summary>How an expression is evaluated: against what, and whether a value
/// that changes between runs is allowed.</summary>
public sealed class Scope
{
    public object? Value { get; init; }

    /// <summary>Whether uuid, nowIso and env may run. A vars value is compared
    /// between runs, so it gets a scope where they are E309.</summary>
    public bool AllowNonDeterministic { get; init; } = true;

    /// <summary>Checked rather than run. Every value underneath is a benign 1, so
    /// a missing operand or an unclosed bracket is reported without a model.</summary>
    public bool SyntaxOnly { get; init; }

    /// <summary>The names a path may start at: the core's roots and every
    /// context key the runtime's extensions declare. Anything else is
    /// E301.</summary>
    public IReadOnlyList<string> Roots { get; init; } = Expression.CoreRoots;

    public static Scope Against(object? value) => new() { Value = value };

    /// <summary>A scope whose paths may also start at the given roots, which
    /// is how an extension's context keys become readable.</summary>
    public static Scope Against(object? value, IReadOnlyList<string> roots) => new() { Value = value, Roots = roots };

    public Scope Stable() => new() { Value = Value, AllowNonDeterministic = false, SyntaxOnly = SyntaxOnly, Roots = Roots };
}

/// <summary>What one expression reads, and whether it parses at all.</summary>
public sealed class Reading
{
    public List<List<string>> Paths { get; } = [];
    public List<string> Functions { get; } = [];
    public ExpressionException? Error { get; set; }
}

/// <summary>One ${...} and the pointer it was written at.</summary>
public readonly record struct Reference(string Pointer, string Text);

internal enum TokenKind
{
    Number,
    Text,
    Name,
    Operator,
    End,
}

internal readonly record struct Token(TokenKind Kind, string Text, object? Number);

/// <summary>
/// The expression language, from ${...}.
///
/// A tokeniser, a Pratt parser and a closed list of functions. The grammar is
/// described in the design; conformance/expressions/cases.yaml is the
/// specification, and when the two disagree the table is what four bindings are
/// held to.
///
/// Two rules decide what a string becomes. A string that is exactly one
/// expression yields that expression's value with its type intact, so
/// ${timeoutSec} is a number. A string with an expression inside other text is
/// substituted into and stays a string.
/// </summary>
public static class Expression
{
    /// <summary>
    /// Every function the language has, and how many arguments each takes.
    ///
    /// Closed because four bindings must agree; an open list would drift to
    /// whatever each language's standard library happens to call things. Matched
    /// case-sensitively, so LOWER is E306 rather than a second spelling.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, FunctionSpec> Functions =
        new Dictionary<string, FunctionSpec>(StringComparer.Ordinal)
        {
            ["lower"] = new(1, 1, true),
            ["upper"] = new(1, 1, true),
            ["trim"] = new(1, 1, true),
            ["replace"] = new(3, 3, true),
            ["format"] = new(1, 99, true),
            ["split"] = new(2, 2, true),
            ["join"] = new(2, 2, true),
            ["startsWith"] = new(2, 2, true),
            ["endsWith"] = new(2, 2, true),
            ["contains"] = new(2, 2, true),
            ["len"] = new(1, 1, true),
            ["first"] = new(1, 1, true),
            ["last"] = new(1, 1, true),
            ["int"] = new(1, 1, true),
            ["float"] = new(1, 1, true),
            ["str"] = new(1, 1, true),
            ["bool"] = new(1, 1, true),
            ["default"] = new(2, 2, true),
            ["env"] = new(1, 1, false),
            ["uuid"] = new(0, 0, false),
            ["nowIso"] = new(0, 0, false),
        };

    /// <summary>
    /// Every name a path may start at before any extension adds a context key.
    /// Anything else is E301. A product's context keys (a lab, a target host)
    /// are not here: they come from the runtime's extensions (DEC-S03), and a
    /// scope carries them in <see cref="Scope.Roots"/>.
    /// </summary>
    public static readonly IReadOnlyList<string> CoreRoots =
        ["capture", "param", "var", "row", "timeoutSec", "defaults"];

    private static readonly string[] Keywords = ["and", "or", "not", "true", "false", "null"];

    /// <summary>Every function name, sorted, for a suggestion and for the
    /// reference.</summary>
    public static List<string> FunctionNames()
    {
        var names = Functions.Keys.ToList();
        names.Sort(StringComparer.Ordinal);
        return names;
    }

    /// <summary>One expression as the pieces it is made of, which the reference
    /// renders.</summary>
    public static List<string> Tokenise(string text) =>
        Scan(text).Select(one => one.Kind switch
        {
            TokenKind.Number => Value.Text(one.Number),
            TokenKind.End => string.Empty,
            _ => one.Text,
        }).ToList();

    private static bool IsNameStart(char character) =>
        character is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or '_';

    private static bool IsNameRest(char character) =>
        IsNameStart(character) || character is >= '0' and <= '9';

    private static List<Token> Scan(string text)
    {
        var tokens = new List<Token>();
        var at = 0;
        while (at < text.Length)
        {
            var character = text[at];
            if (char.IsWhiteSpace(character))
            {
                at++;
                continue;
            }
            if (character is '\'' or '"')
            {
                var quote = character;
                var held = new StringBuilder();
                at++;
                var closed = false;
                while (at < text.Length)
                {
                    if (text[at] == quote)
                    {
                        closed = true;
                        at++;
                        break;
                    }
                    held.Append(text[at]);
                    at++;
                }
                if (!closed)
                {
                    throw new ExpressionException("E305",
                        string.Create(CultureInfo.InvariantCulture, $"a string is never closed, in '{text}'"));
                }
                tokens.Add(new Token(TokenKind.Text, held.ToString(), null));
                continue;
            }
            if (char.IsAsciiDigit(character))
            {
                var held = new StringBuilder();
                while (at < text.Length)
                {
                    // A dot joins a number only when a digit follows, so that
                    // sessionResults.0.value keeps its segments.
                    var joins = text[at] == '.' && at + 1 < text.Length && char.IsAsciiDigit(text[at + 1])
                        && !held.ToString().Contains('.', StringComparison.Ordinal);
                    if (!char.IsAsciiDigit(text[at]) && !joins)
                    {
                        break;
                    }
                    held.Append(text[at]);
                    at++;
                }
                var written = held.ToString();
                if (written.Contains('.', StringComparison.Ordinal))
                {
                    if (!double.TryParse(written, NumberStyles.Float, CultureInfo.InvariantCulture, out var fraction))
                    {
                        throw new ExpressionException("E305", string.Create(CultureInfo.InvariantCulture,
                            $"'{written}' is not a number this language can read, in '{text}'"));
                    }
                    tokens.Add(new Token(TokenKind.Number, written, fraction));
                }
                else
                {
                    if (!long.TryParse(written, NumberStyles.Integer, CultureInfo.InvariantCulture, out var whole))
                    {
                        throw new ExpressionException("E305", string.Create(CultureInfo.InvariantCulture,
                            $"'{written}' is not a number this language can read, in '{text}'"));
                    }
                    tokens.Add(new Token(TokenKind.Number, written, whole));
                }
                continue;
            }
            if (IsNameStart(character))
            {
                var held = new StringBuilder();
                while (at < text.Length && IsNameRest(text[at]))
                {
                    held.Append(text[at]);
                    at++;
                }
                tokens.Add(new Token(TokenKind.Name, held.ToString(), null));
                continue;
            }
            var two = text.Substring(at, Math.Min(2, text.Length - at));
            if (two is "==" or "!=" or "<=" or ">=")
            {
                tokens.Add(new Token(TokenKind.Operator, two, null));
                at += 2;
                continue;
            }
            if ("+-*/%<>?:(),.".Contains(character, StringComparison.Ordinal))
            {
                tokens.Add(new Token(TokenKind.Operator, character.ToString(), null));
                at++;
                continue;
            }
            throw new ExpressionException("E305", string.Create(CultureInfo.InvariantCulture,
                $"'{character}' is not part of this language, at position {at + 1} of '{text}'"));
        }
        tokens.Add(new Token(TokenKind.End, string.Empty, null));
        return tokens;
    }

    /// <summary>Run one expression.</summary>
    public static object? Evaluate(string text, Scope scope)
    {
        var reader = new Parser(Scan(text), text, scope);
        var result = reader.Ternary();
        var left = reader.Peek();
        if (left.Kind == TokenKind.End)
        {
            return result;
        }
        var shown = left.Kind == TokenKind.Number ? Value.Text(left.Number) : left.Text;
        throw new ExpressionException("E305", string.Create(CultureInfo.InvariantCulture,
            $"'{shown}' is left over at the end of '{text}'"));
    }

    /// <summary>
    /// One value with every ${...} in it substituted.
    ///
    /// A string that is exactly one expression keeps that expression's type; a
    /// string with an expression inside text becomes a string.
    /// </summary>
    public static object? Expand(object? value, Scope scope)
    {
        switch (value)
        {
            case string text:
            {
                var trimmed = text.Trim();
                if (string.Equals(text, trimmed, StringComparison.Ordinal)
                    && trimmed.StartsWith("${", StringComparison.Ordinal)
                    && trimmed.EndsWith('}'))
                {
                    var inside = text[2..^1];
                    if (!inside.Contains("${", StringComparison.Ordinal))
                    {
                        return Evaluate(inside, scope);
                    }
                }
                var built = new StringBuilder();
                var at = 0;
                while (at < text.Length)
                {
                    if (text[at] == '$' && at + 1 < text.Length && text[at + 1] == '{')
                    {
                        var end = at + 2;
                        while (end < text.Length && text[end] != '}')
                        {
                            end++;
                        }
                        if (end < text.Length)
                        {
                            built.Append(Value.Text(Evaluate(text[(at + 2)..end], scope)));
                            at = end + 1;
                            continue;
                        }
                    }
                    built.Append(text[at]);
                    at++;
                }
                return built.ToString();
            }
            case List<object?> items:
                return items.Select(item => Expand(item, scope)).ToList();
            case OrderedMap map:
            {
                var expanded = new OrderedMap();
                foreach (var key in map.Keys)
                {
                    expanded.Set(key, Expand(map.Value(key), scope));
                }
                return expanded;
            }
            default:
                return value;
        }
    }

    /// <summary>Every ${...} in a value, with the pointer it was written
    /// at.</summary>
    public static List<Reference> References(object? value, string pointer)
    {
        var found = new List<Reference>();
        switch (value)
        {
            case string text:
            {
                var at = 0;
                while (at < text.Length)
                {
                    if (text[at] == '$' && at + 1 < text.Length && text[at + 1] == '{')
                    {
                        var end = at + 2;
                        while (end < text.Length && text[end] != '}')
                        {
                            end++;
                        }
                        if (end < text.Length)
                        {
                            found.Add(new Reference(pointer, text[(at + 2)..end]));
                            at = end + 1;
                            continue;
                        }
                    }
                    at++;
                }
                break;
            }
            case List<object?> items:
                for (var index = 0; index < items.Count; index++)
                {
                    found.AddRange(References(items[index],
                        string.Create(CultureInfo.InvariantCulture, $"{pointer}/{index}")));
                }
                break;
            case OrderedMap map:
                foreach (var key in map.Keys)
                {
                    found.AddRange(References(map.Value(key), SuiteDocument.Child(pointer, key)));
                }
                break;
        }
        return found;
    }

    /// <summary>What one expression reads, and whether it parses at all.</summary>
    public static Reading Read(string text, bool stable)
    {
        var reading = new Reading();
        List<Token> tokens;
        try
        {
            tokens = Scan(text);
        }
        catch (ExpressionException failure)
        {
            reading.Error = failure;
            return reading;
        }
        var scope = new Scope { Value = null, AllowNonDeterministic = !stable, SyntaxOnly = true };
        try
        {
            Evaluate(text, scope);
        }
        catch (ExpressionException failure)
        {
            reading.Error = failure;
            return reading;
        }

        var at = 0;
        while (at < tokens.Count)
        {
            if (tokens[at].Kind != TokenKind.Name)
            {
                at++;
                continue;
            }
            var name = tokens[at].Text;
            if (Keywords.Contains(name, StringComparer.Ordinal))
            {
                at++;
                continue;
            }
            if (at + 1 < tokens.Count && tokens[at + 1].Kind == TokenKind.Operator
                && string.Equals(tokens[at + 1].Text, "(", StringComparison.Ordinal))
            {
                reading.Functions.Add(name);
                at++;
                continue;
            }
            var segments = new List<string> { name };
            at++;
            while (at < tokens.Count && tokens[at].Kind == TokenKind.Operator
                   && string.Equals(tokens[at].Text, ".", StringComparison.Ordinal))
            {
                if (at + 1 >= tokens.Count)
                {
                    break;
                }
                if (tokens[at + 1].Kind == TokenKind.Name)
                {
                    segments.Add(tokens[at + 1].Text);
                    at += 2;
                }
                else if (tokens[at + 1].Kind == TokenKind.Number)
                {
                    segments.Add(Value.Text(tokens[at + 1].Number));
                    at += 2;
                }
                else
                {
                    break;
                }
            }
            reading.Paths.Add(segments);
        }
        return reading;
    }
}
