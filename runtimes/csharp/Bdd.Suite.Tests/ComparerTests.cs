using Bdd.Suite.Assertions;

namespace Bdd.Suite.Tests;

/// <summary>
/// The corpus table in conformance/asserts is the specification and is
/// enumerated by AssertionCorpusTests. What is here is the rest: how a refusal
/// reads, and what a failed assertion says a person should look at.
/// </summary>
public sealed class ComparerTests
{
    [Fact]
    public void ARefusalReadsWithItsCodeWhenItHasOne()
    {
        Assert.Equal("it cannot be compared", new CompareException("it cannot be compared").ToString());
        Assert.Equal("E308: the pattern", new CompareException("the pattern", "E308").ToString());
    }

    [Theory]
    [InlineData(@"(a)\1", "a backreference")]
    [InlineData("a(?=b)", "a lookahead")]
    [InlineData("a(?!b)", "a lookahead")]
    [InlineData("(?<=a)b", "a lookbehind")]
    [InlineData("(?<!a)b", "a lookbehind")]
    [InlineData(@"^[A-Z]+-\d+$", "")]
    [InlineData(".*", "")]
    public void AnUnportablePatternIsNamedByWhatMakesItUnportable(string pattern, string want) =>
        Assert.Equal(want, Comparer.Unportable(pattern));

    [Fact]
    public void APatternThatWillNotCompileIsRefusedRatherThanFailed()
    {
        var illegal = Assert.Throws<CompareException>(() => Comparer.Compare("matches", "x", "([", true));
        Assert.Contains("cannot be read", illegal.Message, StringComparison.Ordinal);
        var unportable = Assert.Throws<CompareException>(() => Comparer.Compare("matches", "x", @"(a)\1", true));
        Assert.Equal("E308", unportable.Code);
    }

    [Fact]
    public void AnOperatorNobodyImplementsSaysSo()
    {
        var refused = Assert.Throws<CompareException>(() => Comparer.Compare("isBlue", "x", "y", true));
        Assert.Contains("Unknown assertion", refused.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(true, true)]
    [InlineData(false, false)]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("0", false)]
    [InlineData("yes", true)]
    [InlineData(1L, true)]
    public void AFlagOperatorReadsItsOwnExpectedValue(object? expected, bool want) =>
        Assert.Equal(want, Comparer.TruthOf(expected));

    [Fact]
    public void AFailureSaysWhatWasWantedAndWhatWasThere()
    {
        var rows = new (string Operator, object? Expected, object? Actual, bool Present, string[] Want)[]
        {
            ("equals", "Up", "Down", true, ["expected s equals 'Up'", "got 'Down'"]),
            ("isTrue", true, false, true, ["to be true", "got 'false'"]),
            ("isFalse", true, true, true, ["to be false"]),
            ("isNull", true, null, true, ["absent or null", "(null)"]),
            ("isNotNull", true, null, false, ["to be present", "(absent)"]),
            ("count", 3L, new List<object?> { "a", "b" }, true, ["to have 3 entries", "[a, b]"]),
            ("in", new List<object?> { "a", "b" }, "c", true, ["[a, b]"]),
        };
        foreach (var (operator_, expected, actual, present, want) in rows)
        {
            var said = Comparer.Describe("s", operator_, expected, actual, present);
            foreach (var piece in want)
            {
                Assert.Contains(piece, said, StringComparison.Ordinal);
            }
        }
    }

    [Fact]
    public void TheOperatorListIsWhatTheComparerImplements()
    {
        Assert.Equal(18, Comparer.Operators.Length);
        foreach (var name in Comparer.Operators)
        {
            if (string.Equals(name, "script", StringComparison.Ordinal))
            {
                // Implemented by the PowerShell binding only, and refused here by
                // the executor rather than by the comparer.
                continue;
            }
            try
            {
                Comparer.Compare(name, "1", "1", true);
            }
            catch (CompareException failure)
            {
                Assert.DoesNotContain("Unknown assertion", failure.Message, StringComparison.Ordinal);
            }
        }
    }
}
