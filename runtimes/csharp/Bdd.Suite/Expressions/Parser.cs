using System.Globalization;
using System.Text;
using Bdd.Suite.Model;
using Bdd.Suite.Values;

namespace Bdd.Suite.Expressions;

/// <summary>
/// The parser and the evaluator behind <see cref="Expression"/>.
///
/// One class rather than two, because in this language a node is evaluated the
/// moment it is parsed: there is no tree to keep and nothing that would read one
/// twice.
/// </summary>
internal sealed class Parser(List<Token> tokens, string source, Scope scope)
{
    private int _at;

    internal Token Peek() => _at < tokens.Count ? tokens[_at] : new Token(TokenKind.End, string.Empty, null);

    private Token Next()
    {
        var found = Peek();
        _at++;
        return found;
    }

    private bool IsOperator(params string[] values)
    {
        var found = Peek();
        return found.Kind is TokenKind.Operator or TokenKind.Name
            && values.Contains(found.Text, StringComparer.Ordinal);
    }

    internal object? Ternary()
    {
        var condition = Or();
        if (!IsOperator("?"))
        {
            return condition;
        }
        _at++;
        var taken = scope.SyntaxOnly || Truthy(condition);
        var whenTrue = TernaryBranch(taken);
        if (!IsOperator(":"))
        {
            throw new ExpressionException("E305",
                string.Create(CultureInfo.InvariantCulture, $"a ? needs a : after it, in '{source}'"));
        }
        _at++;
        var whenFalse = TernaryBranch(!taken);
        return taken ? whenTrue : whenFalse;
    }

    private object? TernaryBranch(bool evaluate)
    {
        if (evaluate || scope.SyntaxOnly) return Ternary();
        var skipped = new Parser(tokens, source, new Scope
        {
            Value = scope.Value,
            AllowNonDeterministic = scope.AllowNonDeterministic,
            SyntaxOnly = true,
            Roots = scope.Roots,
        }) { _at = _at };
        var result = skipped.Ternary();
        _at = skipped._at;
        return result;
    }

    private object? Or()
    {
        var left = And();
        while (IsOperator("or"))
        {
            _at++;
            var right = And();
            left = Truthy(left) || Truthy(right);
        }
        return left;
    }

    private object? And()
    {
        var left = Comparison();
        while (IsOperator("and"))
        {
            _at++;
            var right = Comparison();
            left = Truthy(left) && Truthy(right);
        }
        return left;
    }

    /// <summary>One comparison, and only one. `1 &lt; 2 == true` is refused rather
    /// than read as something, because two bindings would chain it
    /// differently.</summary>
    private object? Comparison()
    {
        var left = Additive();
        foreach (var operator_ in new[] { "==", "!=", "<=", ">=", "<", ">" })
        {
            if (!IsOperator(operator_))
            {
                continue;
            }
            _at++;
            var right = Additive();
            return Compare(operator_, left, right, scope.SyntaxOnly);
        }
        return left;
    }

    private object? Additive()
    {
        var left = Multiplicative();
        while (true)
        {
            if (IsOperator("+"))
            {
                _at++;
                left = Add(left, Multiplicative(), scope.SyntaxOnly);
            }
            else if (IsOperator("-"))
            {
                _at++;
                left = Arithmetic("-", left, Multiplicative(), scope.SyntaxOnly);
            }
            else
            {
                return left;
            }
        }
    }

    private object? Multiplicative()
    {
        var left = Unary();
        while (true)
        {
            string operator_;
            if (IsOperator("*"))
            {
                operator_ = "*";
            }
            else if (IsOperator("/"))
            {
                operator_ = "/";
            }
            else if (IsOperator("%"))
            {
                operator_ = "%";
            }
            else
            {
                return left;
            }
            _at++;
            left = Arithmetic(operator_, left, Unary(), scope.SyntaxOnly);
        }
    }

    private object? Unary()
    {
        if (IsOperator("-"))
        {
            _at++;
            return Arithmetic("-", 0L, Unary(), scope.SyntaxOnly);
        }
        if (IsOperator("not"))
        {
            _at++;
            var held = Unary();
            return scope.SyntaxOnly ? true : !Truthy(held);
        }
        return Primary();
    }

    private object? Primary()
    {
        var found = Next();
        switch (found.Kind)
        {
            case TokenKind.Number:
                return found.Number;
            case TokenKind.Text:
                return found.Text;
            case TokenKind.Operator:
                if (string.Equals(found.Text, "(", StringComparison.Ordinal))
                {
                    var inside = Ternary();
                    if (!IsOperator(")"))
                    {
                        throw new ExpressionException("E305",
                            string.Create(CultureInfo.InvariantCulture, $"a ( is never closed, in '{source}'"));
                    }
                    _at++;
                    return inside;
                }
                throw new ExpressionException("E305", string.Create(CultureInfo.InvariantCulture,
                    $"'{found.Text}' has nothing to work on, in '{source}'"));
            case TokenKind.Name:
            {
                switch (found.Text)
                {
                    case "true":
                        return true;
                    case "false":
                        return false;
                    case "null":
                        return null;
                }
                if (IsOperator("("))
                {
                    _at++;
                    var arguments = new List<object?>();
                    if (!IsOperator(")"))
                    {
                        while (true)
                        {
                            arguments.Add(Ternary());
                            if (IsOperator(","))
                            {
                                _at++;
                                continue;
                            }
                            break;
                        }
                    }
                    if (!IsOperator(")"))
                    {
                        throw new ExpressionException("E305", string.Create(CultureInfo.InvariantCulture,
                            $"a call to {found.Text} is never closed, in '{source}'"));
                    }
                    _at++;
                    return Call(found.Text, arguments, scope);
                }
                var segments = new List<string> { found.Text };
                while (IsOperator("."))
                {
                    _at++;
                    var segment = Next();
                    if (segment.Kind == TokenKind.Name)
                    {
                        segments.Add(segment.Text);
                    }
                    else if (segment.Kind == TokenKind.Number)
                    {
                        segments.Add(Value.Text(segment.Number));
                    }
                    else
                    {
                        throw new ExpressionException("E305",
                            string.Create(CultureInfo.InvariantCulture, $"a path ends with a dot, in '{source}'"));
                    }
                }
                return Resolve(segments, scope);
            }
            default:
                throw new ExpressionException("E305",
                    string.Create(CultureInfo.InvariantCulture, $"'{source}' ends before it says anything"));
        }
    }

    /// <summary>Whether a value counts as true, by the one rule bool()
    /// states.</summary>
    internal static bool Truthy(object? value)
    {
        if (TryBool(value, out var yes))
        {
            return yes;
        }
        throw new ExpressionException("E307", string.Create(CultureInfo.InvariantCulture,
            $"bool cannot read '{Value.Text(value)}' as true or false"));
    }

    internal static bool TryBool(object? value, out bool yes)
    {
        if (value is bool held)
        {
            yes = held;
            return true;
        }
        switch (Value.Text(value).Trim().ToLowerInvariant())
        {
            case "true":
            case "yes":
            case "1":
                yes = true;
                return true;
            case "false":
            case "no":
            case "0":
            case "":
                yes = false;
                return true;
            default:
                yes = false;
                return false;
        }
    }

    /// <summary>Whether a value carries a fraction, which decides whether an
    /// arithmetic result keeps one.</summary>
    private static bool IsFraction(object? value) => value switch
    {
        double => true,
        long or int => false,
        string text => !long.TryParse(text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out _)
            && double.TryParse(text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out _),
        _ => false,
    };

    /// <summary>
    /// One arithmetic result as the type it should keep.
    ///
    /// The two returns are written out rather than put in a conditional on
    /// purpose: a conditional with a long on one side and a double on the other
    /// has one type, and it is double, so every whole number would come back a
    /// fraction.
    /// </summary>
    private static object Number(double result, bool whole)
    {
        if (whole && Math.Truncate(result) == result && Math.Abs(result) < 9.2e18)
        {
            return (long)result;
        }
        return result;
    }

    /// <summary>`+` is numeric when both sides are numbers and textual
    /// otherwise.</summary>
    private static object? Add(object? left, object? right, bool syntaxOnly)
    {
        if (syntaxOnly)
        {
            return 1L;
        }
        if (Value.TryNumber(left, out var one) && Value.TryNumber(right, out var other))
        {
            return Number(one + other, !IsFraction(left) && !IsFraction(right));
        }
        return Value.Text(left) + Value.Text(right);
    }

    private static object? Arithmetic(string operator_, object? left, object? right, bool syntaxOnly)
    {
        if (syntaxOnly)
        {
            return 1L;
        }
        if (!Value.TryNumber(left, out var one) || !Value.TryNumber(right, out var other))
        {
            throw new ExpressionException("E307", string.Create(CultureInfo.InvariantCulture,
                $"{operator_} takes numbers, and '{Value.Text(left)}' or '{Value.Text(right)}' is not one"));
        }
        var whole = !IsFraction(left) && !IsFraction(right);
        switch (operator_)
        {
            case "-":
                return Number(one - other, whole);
            case "*":
                return Number(one * other, whole);
            case "/":
                if (other == 0)
                {
                    throw new ExpressionException("E307", "division by zero");
                }
                return Number(one / other, whole);
            case "%":
                if (other == 0)
                {
                    throw new ExpressionException("E307", "division by zero");
                }
                return Number(one % other, whole);
            default:
                throw new ExpressionException("E305",
                    string.Create(CultureInfo.InvariantCulture, $"'{operator_}' is not an operator"));
        }
    }

    /// <summary>Numbers compare as numbers; anything else compares as text,
    /// ignoring case, which is what the suites in the tree were written
    /// against.</summary>
    private static object? Compare(string operator_, object? left, object? right, bool syntaxOnly)
    {
        if (syntaxOnly)
        {
            return true;
        }
        var numeric = Value.TryNumber(left, out var one) & Value.TryNumber(right, out var other);
        switch (operator_)
        {
            case "==":
                return numeric
                    ? one == other
                    : string.Equals(Value.Text(left), Value.Text(right), StringComparison.OrdinalIgnoreCase);
            case "!=":
                return numeric
                    ? one != other
                    : !string.Equals(Value.Text(left), Value.Text(right), StringComparison.OrdinalIgnoreCase);
        }
        if (!numeric)
        {
            throw new ExpressionException("E307", string.Create(CultureInfo.InvariantCulture,
                $"{operator_} compares numbers, and '{Value.Text(left)}' or '{Value.Text(right)}' is not one"));
        }
        return operator_ switch
        {
            "<" => one < other,
            "<=" => one <= other,
            ">" => one > other,
            _ => one >= other,
        };
    }

    /// <summary>Walk one path against the scope.</summary>
    private static object? Resolve(List<string> segments, Scope scope)
    {
        var whole = string.Join('.', segments);
        if (scope.SyntaxOnly)
        {
            return 1L;
        }
        if (!scope.Roots.Contains(segments[0], StringComparer.Ordinal))
        {
            throw new ExpressionException("E301", string.Create(CultureInfo.InvariantCulture,
                $"${{{whole}}} resolves to nothing. A path starts at {string.Join(", ", scope.Roots)}."));
        }
        var current = scope.Value;
        foreach (var segment in segments)
        {
            if (current is null)
            {
                throw new ExpressionException("E301",
                    string.Create(CultureInfo.InvariantCulture, $"${{{whole}}} resolves to nothing."));
            }
            if (current is List<object?> items
                && int.TryParse(segment, NumberStyles.Integer, CultureInfo.InvariantCulture, out var index))
            {
                if (index < 0 || index >= items.Count)
                {
                    throw new ExpressionException("E301", string.Create(CultureInfo.InvariantCulture,
                        $"${{{whole}}} resolves to nothing: the list has {items.Count} entries."));
                }
                current = items[index];
                continue;
            }
            if (!Value.TryField(current, segment, out var found))
            {
                throw new ExpressionException("E301", string.Create(CultureInfo.InvariantCulture,
                    $"${{{whole}}} resolves to nothing: no {segment} there."));
            }
            current = found;
        }
        return current;
    }

    private static List<object?> AsList(object? value) => value switch
    {
        List<object?> items => items,
        null => [],
        _ => [value],
    };

    /// <summary>Run one function of the closed list.</summary>
    private static object? Call(string name, List<object?> arguments, Scope scope)
    {
        if (!Expression.Functions.TryGetValue(name, out var spec))
        {
            var prefix = name.Length > 2 ? name[..2].ToLowerInvariant() : name.ToLowerInvariant();
            var nearest = Expression.FunctionNames()
                .FirstOrDefault(candidate => candidate.ToLowerInvariant()
                    .StartsWith(prefix, StringComparison.Ordinal));
            var suggestion = nearest is null
                ? string.Empty
                : string.Create(CultureInfo.InvariantCulture, $" Did you mean {nearest}?");
            throw new ExpressionException("E306", string.Create(CultureInfo.InvariantCulture,
                $"there is no function called {name}.{suggestion}"));
        }
        if (arguments.Count < spec.Min || arguments.Count > spec.Max)
        {
            var expected = spec.Min == spec.Max
                ? spec.Min.ToString(CultureInfo.InvariantCulture)
                : string.Create(CultureInfo.InvariantCulture, $"{spec.Min} to {spec.Max}");
            throw new ExpressionException("E307", string.Create(CultureInfo.InvariantCulture,
                $"{name} takes {expected} argument(s), not {arguments.Count}"));
        }
        if (!spec.Deterministic && !scope.AllowNonDeterministic)
        {
            throw new ExpressionException("E309", string.Create(CultureInfo.InvariantCulture,
                $"{name} is not deterministic, and this value has to be stable"));
        }
        if (scope.SyntaxOnly)
        {
            return 1L;
        }

        string Text(int index) => Value.Text(arguments[index]);
        switch (name)
        {
            case "lower":
                return Text(0).ToLowerInvariant();
            case "upper":
                return Text(0).ToUpperInvariant();
            case "trim":
                return Text(0).Trim();
            case "replace":
                return Text(0).Replace(Text(1), Text(2), StringComparison.Ordinal);
            case "format":
            {
                var out_ = Text(0);
                for (var index = 1; index < arguments.Count; index++)
                {
                    out_ = out_.Replace(
                        string.Create(CultureInfo.InvariantCulture, $"{{{index - 1}}}"),
                        Value.Text(arguments[index]), StringComparison.Ordinal);
                }
                return out_;
            }
            case "split":
                return Text(0).Split(Text(1)).Select(piece => (object?)piece).ToList();
            case "join":
                return string.Join(Text(1), AsList(arguments[0]).Select(Value.Text));
            case "startsWith":
                return Text(0).StartsWith(Text(1), StringComparison.OrdinalIgnoreCase);
            case "endsWith":
                return Text(0).EndsWith(Text(1), StringComparison.OrdinalIgnoreCase);
            case "contains":
                if (arguments[0] is List<object?> haystack)
                {
                    return haystack.Any(item => string.Equals(Value.Text(item), Text(1), StringComparison.Ordinal));
                }
                return Text(0).Contains(Text(1), StringComparison.OrdinalIgnoreCase);
            case "len":
                return arguments[0] switch
                {
                    null => 0L,
                    string text => (long)text.Length,
                    List<object?> items => (long)items.Count,
                    OrderedMap map => (long)map.Count,
                    _ => throw new ExpressionException("E307", "len takes a string or a list"),
                };
            case "first":
            case "last":
            {
                var items = AsList(arguments[0]);
                if (items.Count == 0)
                {
                    throw new ExpressionException("E307", string.Create(CultureInfo.InvariantCulture,
                        $"{name} takes a list with something in it"));
                }
                return string.Equals(name, "first", StringComparison.Ordinal) ? items[0] : items[^1];
            }
            case "int":
                if (Value.TryNumber(arguments[0], out var whole))
                {
                    return (long)Math.Truncate(whole);
                }
                throw new ExpressionException("E307",
                    string.Create(CultureInfo.InvariantCulture, $"int cannot read '{Text(0)}' as a number"));
            case "float":
                if (Value.TryNumber(arguments[0], out var fraction))
                {
                    return fraction;
                }
                throw new ExpressionException("E307",
                    string.Create(CultureInfo.InvariantCulture, $"float cannot read '{Text(0)}' as a number"));
            case "str":
                return Text(0);
            case "bool":
                if (TryBool(arguments[0], out var yes))
                {
                    return yes;
                }
                throw new ExpressionException("E307", string.Create(CultureInfo.InvariantCulture,
                    $"bool cannot read '{Text(0)}' as true or false"));
            case "default":
            {
                var first = arguments[0];
                return first is null || Value.Text(first).Length == 0 ? arguments[1] : first;
            }
            case "env":
                return Environment.GetEnvironmentVariable(Text(0)) ?? string.Empty;
            case "uuid":
                return NewIdentifier();
            case "nowIso":
                return DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
            default:
                throw new ExpressionException("E306",
                    string.Create(CultureInfo.InvariantCulture, $"there is no function called {name}."));
        }
    }

    /// <summary>A 32-character identifier, from the clock and a counter. A test
    /// tool needs an identifier nobody else has this second, not a cryptographic
    /// one.</summary>
    private static string NewIdentifier()
    {
        var minted = Interlocked.Increment(ref _minted);
        var built = new StringBuilder();
        built.Append(DateTime.UtcNow.Ticks.ToString("x16", CultureInfo.InvariantCulture));
        built.Append(minted.ToString("x16", CultureInfo.InvariantCulture));
        return built.ToString(0, 32);
    }

    private static long _minted;
}
