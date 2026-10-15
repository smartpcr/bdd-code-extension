using Bdd.Suite.Expressions;
using Bdd.Suite.Model;

namespace Bdd.Suite.Tests;

/// <summary>
/// The corpus table in conformance/expressions is the specification and
/// is enumerated by ExpressionCorpusTests. What is here is the rest: the paths a
/// shared table cannot reach because they are about this language rather than
/// about the expression grammar.
/// </summary>
public sealed class ExpressionTests
{
    private static OrderedMap ScopeValue() =>
        SuiteDocument.Load("""
            capture:
              cs:
                State: Up
                Nodes: [N1, N2, N3]
            param:
              site: lab1
            var:
              deadline: 240
            row:
              node: N2
            host: HOST-CL01
            member: HOST-N1
            timeoutSec: 300
            defaults:
              member: HOST-N1
            """).Value as OrderedMap ?? throw new InvalidOperationException("the scope is a mapping");

    /// <summary>The two context keys a test extension would declare: host and
    /// member, readable beside the core's roots.</summary>
    private static readonly string[] Roots = [.. Expression.CoreRoots, "host", "member"];

    private static Scope Scoped() => Scope.Against(ScopeValue(), Roots);

    [Fact]
    public void AContextKeyIsARootOnlyWhenTheScopeDeclaresIt()
    {
        Assert.Equal("HOST-CL01", Expression.Evaluate("host", Scoped()));
        // The core alone knows no context key beyond timeoutSec and defaults.
        var refused = Assert.Throws<ExpressionException>(() =>
            Expression.Evaluate("host", Scope.Against(ScopeValue())));
        Assert.Equal("E301", refused.Code);
        Assert.Contains("A path starts at capture, param, var, row, timeoutSec, defaults.", refused.Message,
            StringComparison.Ordinal);
        Assert.Equal(300L, Expression.Evaluate("timeoutSec", Scope.Against(ScopeValue())));
        // A stable scope keeps its roots.
        Assert.Equal("HOST-N1", Expression.Evaluate("member", Scoped().Stable()));
        // So does the branch a ternary does not take, which is only checked.
        Assert.Equal("HOST-CL01", Expression.Evaluate("true ? host : member", Scoped()));
    }

    [Fact]
    public void ARefusalCarriesItsCode()
    {
        var refused = Assert.Throws<ExpressionException>(() => Expression.Evaluate("@", Scope.Against(null)));
        Assert.Equal("E305", refused.Code);
        Assert.StartsWith("E305: ", refused.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void AnExpressionComesApartIntoItsPieces()
    {
        var pieces = string.Join('|', Expression.Tokenise("lower('A') + 1.5 == x.y"));
        foreach (var want in new[] { "lower", "A", "1.5", "==", "x", "y" })
        {
            Assert.Contains(want, pieces, StringComparison.Ordinal);
        }
        Assert.Throws<ExpressionException>(() => Expression.Tokenise("'unclosed"));
    }

    [Fact]
    public void AnExpressionThatEndsEarlyOrLateIsRefused()
    {
        var scope = Scoped();
        foreach (var text in new[] { "", "1 +", "(1", "lower(", "1 2", "1 ? 2", "x.", "@" })
        {
            Assert.Throws<ExpressionException>(() => Expression.Evaluate(text, scope));
        }
    }

    [Fact]
    public void AFailureInsideAnExpressionReachesTheTopOfIt()
    {
        var scope = Scoped();
        // One per level of the parser, so a refusal raised deep in a nested
        // expression is the one reported rather than being swallowed on the way
        // up.
        foreach (var text in new[]
                 {
                     "nosuch.thing ? 1 : 2", "true ? nosuch.thing : 2", "false ? 1 : nosuch.thing",
                     "nosuch.thing or true", "false or nosuch.thing",
                     "nosuch.thing and true", "true and nosuch.thing",
                     "nosuch.thing == 1", "1 == nosuch.thing",
                     "nosuch.thing + 1", "1 + nosuch.thing",
                     "nosuch.thing - 1", "1 - nosuch.thing",
                     "nosuch.thing * 2", "2 * nosuch.thing",
                     "- nosuch.thing", "not nosuch.thing", "(nosuch.thing)",
                     "lower(nosuch.thing)", "lower('a') + nosuch.thing",
                 })
        {
            Assert.Throws<ExpressionException>(() => Expression.Evaluate(text, scope));
        }
        // A value that is not true or false stops an and or an or rather than
        // being guessed at.
        foreach (var text in new[]
                 {
                     "'maybe' and true", "true and 'maybe'", "'maybe' or true",
                     "false or 'maybe'", "not 'maybe'", "'maybe' ? 1 : 2",
                 })
        {
            Assert.Equal("E307",
                Assert.Throws<ExpressionException>(() => Expression.Evaluate(text, scope)).Code);
        }
    }

    [Fact]
    public void APathThatRunsIntoNothingStopsThere()
    {
        var held = SuiteDocument.Load("capture:\n  nothing:\n  cs:\n    State: Up\n").Value;
        var scope = Scope.Against(held);
        Assert.Throws<ExpressionException>(() => Expression.Evaluate("capture.nothing.deeper", scope));
        // len() of an object is how many keys it has, which is the one place the
        // language looks at a mapping rather than through it.
        Assert.Equal(1L, Expression.Evaluate("len(capture.cs)", scope));
        // An index past the end of a list says how long the list is.
        var list = Scope.Against(SuiteDocument.Load("capture:\n  items: [a, b]\n").Value);
        Assert.Throws<ExpressionException>(() => Expression.Evaluate("capture.items.9", list));
    }

    [Fact]
    public void TheNonDeterministicFunctionsProduceSomethingWhenTheyAreAllowed()
    {
        var scope = Scope.Against(new OrderedMap());
        var identifier = Expression.Evaluate("uuid()", scope) as string;
        Assert.NotNull(identifier);
        Assert.Equal(32, identifier!.Length);
        Assert.NotEqual(identifier, Expression.Evaluate("uuid()", scope) as string);

        var stamp = Expression.Evaluate("nowIso()", scope) as string;
        Assert.NotNull(stamp);
        Assert.Equal(20, stamp!.Length);
        Assert.EndsWith("Z", stamp, StringComparison.Ordinal);

        Environment.SetEnvironmentVariable("BDD_SUITE_EXPR_PROBE", "seen");
        try
        {
            Assert.Equal("seen", Expression.Evaluate("env('BDD_SUITE_EXPR_PROBE')", scope));
        }
        finally
        {
            Environment.SetEnvironmentVariable("BDD_SUITE_EXPR_PROBE", null);
        }
        Assert.Equal(string.Empty, Expression.Evaluate("env('BDD_SUITE_EXPR_NOTHING_AT_ALL')", scope));
    }

    [Fact]
    public void ATemplateSubstitutesAndKeepsBeingAString()
    {
        var scope = Scoped();
        Assert.Equal("the host is HOST-CL01", Expression.Expand("the host is ${host}", scope));
        // A whole-string expression keeps its type; anything else is text.
        Assert.Equal(300L, Expression.Expand("${timeoutSec}", scope));
        // A brace with nothing closing it is text, not a refusal.
        Assert.Equal("${unclosed", Expression.Expand("${unclosed", scope));
        Assert.Throws<ExpressionException>(() => Expression.Expand("a ${nosuch.thing} b", scope));
    }

    [Fact]
    public void AValueIsWalkedWhereverAReferenceIsWritten()
    {
        var scope = Scoped();
        var nested = new OrderedMap();
        nested.Set("name", "${host}");
        nested.Set("items", new List<object?> { "${member}", 2L });
        var expanded = Expression.Expand(nested, scope) as OrderedMap;
        Assert.NotNull(expanded);
        Assert.Equal("HOST-CL01", expanded!.Value("name"));
        var items = expanded.List("items")!;
        Assert.Equal("HOST-N1", items[0]);
        Assert.Equal(2L, items[1]);
        Assert.Equal(4L, Expression.Expand(4L, scope));

        // A list or a map with a bad reference inside it reports rather than
        // silently keeping the text.
        Assert.Throws<ExpressionException>(() =>
            Expression.Expand(new List<object?> { "${nosuch.thing}" }, scope));
        var broken = new OrderedMap();
        broken.Set("x", "${nosuch.thing}");
        Assert.Throws<ExpressionException>(() => Expression.Expand(broken, scope));
    }

    [Fact]
    public void EveryReferenceIsFoundWithThePointerItWasWrittenAt()
    {
        var held = new OrderedMap();
        held.Set("action", "core.set");
        held.Set("value", "${param.site} and ${host}");
        held.Set("list", new List<object?> { "${member}" });
        held.Set("number", 3L);
        var found = Expression.References(held, "/tests/0/steps/0");
        Assert.Equal(3, found.Count);
        Assert.Equal("/tests/0/steps/0/value", found[0].Pointer);
        Assert.Equal("param.site", found[0].Text);
        Assert.Equal("/tests/0/steps/0/list/0", found[2].Pointer);
        Assert.Empty(Expression.References("plain text", "/x"));
        Assert.Empty(Expression.References("${unclosed", "/x"));
    }

    [Fact]
    public void ReadingSaysWhatAnExpressionNamesWithoutRunningIt()
    {
        var reading = Expression.Read("lower(capture.cs.State) == 'up' and param.site", false);
        Assert.Null(reading.Error);
        Assert.Equal(["lower"], reading.Functions);
        Assert.Equal(2, reading.Paths.Count);
        Assert.Equal("capture.cs.State", string.Join('.', reading.Paths[0]));

        // The keywords are not paths.
        Assert.Empty(Expression.Read("true and not false or null", false).Paths);
        // An index in a path keeps its place.
        Assert.Equal("capture.cs.Nodes.1",
            string.Join('.', Expression.Read("capture.cs.Nodes.1", false).Paths[0]));
        // A path that ends at a dot stops rather than running off the end.
        Assert.NotNull(Expression.Read("capture.", false).Error);
        Assert.NotNull(Expression.Read("'unclosed", false).Error);
        Assert.Equal("E309", Expression.Read("uuid()", true).Error!.Code);
    }

    [Fact]
    public void AListFunctionReadsWhateverItWasGivenAsOne()
    {
        var scope = Scoped();
        // A scalar is a list of one, and nothing is an empty list.
        Assert.Equal("one", Expression.Evaluate("join('one', ',')", scope));
        Assert.Equal(string.Empty, Expression.Evaluate("join(null, ',')", scope));
        Assert.Equal("x", Expression.Evaluate("first('x')", scope));
        Assert.Equal("E307", Assert.Throws<ExpressionException>(() =>
            Expression.Evaluate("first(null)", scope)).Code);
        Assert.Equal("E307", Assert.Throws<ExpressionException>(() =>
            Expression.Evaluate("last(null)", scope)).Code);
    }

    [Fact]
    public void AFunctionNobodyHasIsRefusedWithTheNearestNameWhenThereIsOne()
    {
        var scope = Scoped();
        var near = Assert.Throws<ExpressionException>(() => Expression.Evaluate("lo()", scope));
        Assert.Equal("E306", near.Code);
        Assert.Contains("Did you mean lower", near.Message, StringComparison.Ordinal);

        // Nothing starts with these two letters, so the refusal offers nothing.
        var far = Assert.Throws<ExpressionException>(() => Expression.Evaluate("zz()", scope));
        Assert.Equal("E306", far.Code);
        Assert.DoesNotContain("Did you mean", far.Message, StringComparison.Ordinal);

        // A name of one letter takes the whole name as its prefix.
        Assert.Equal("E306", Assert.Throws<ExpressionException>(() =>
            Expression.Evaluate("q()", scope)).Code);
    }
}