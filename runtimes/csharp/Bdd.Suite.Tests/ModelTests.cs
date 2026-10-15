using Bdd.Suite.Model;

namespace Bdd.Suite.Tests;

public sealed class ModelTests
{
    private static SuiteDocument Load(string text) => SuiteDocument.Load(text);

    [Fact]
    public void AMappingRecordsTheKeyAndTheValueApart()
    {
        var document = Load("suite: typos\ntests:\n  - name: a\n    timeout: 30\n");
        Assert.True(document.TryGet("/suite", out var suite));
        Assert.Equal("typos", suite);
        Assert.Equal(new NodePosition(new Position(1, 1), new Position(1, 8)), document.At("/suite"));
        Assert.Equal(new NodePosition(new Position(4, 5), new Position(4, 14)), document.At("/tests/0/timeout"));
    }

    [Fact]
    public void ASequenceItemIsAtItsOwnEntry()
    {
        var document = Load("tests:\n  - name: a\n  - name: b\n");
        Assert.Equal(new Position(2, 5), document.At("/tests/0").Value);
        Assert.Equal(new Position(3, 5), document.At("/tests/1").Value);
    }

    [Fact]
    public void AnEmptySequenceEntryIsAtItsDash()
    {
        var document = Load("tests:\n  -\n  - name: b\n");
        Assert.Equal(new Position(2, 4), document.At("/tests/0").Value);
    }

    [Fact]
    public void ScalarsResolveToTheTypesTheSchemaChecks()
    {
        var document = Load("a: 30\nb: '30'\nc: 1.5\nd: true\ne: false\nf: null\ng: ~\nh:\ni: text\nj: \"true\"\n");
        var wanted = new (string Pointer, object? Want)[]
        {
            ("/a", 30L),
            ("/b", "30"),
            ("/c", 1.5),
            ("/d", true),
            ("/e", false),
            ("/f", null),
            ("/g", null),
            ("/h", null),
            ("/i", "text"),
            ("/j", "true"),
        };
        foreach (var (pointer, want) in wanted)
        {
            document.TryGet(pointer, out var got);
            Assert.Equal(want, got);
        }
    }

    [Fact]
    public void AFlowMappingIsReadLikeABlockOne()
    {
        var document = Load("params:\n  - { name: region, default: west }\n");
        Assert.True(document.TryGet("/params/0/name", out var name));
        Assert.Equal("region", name);
        Assert.Equal(new Position(2, 7), document.At("/params/0/name").Key);
        Assert.Equal(new Position(2, 5), document.At("/params/0").Value);
    }

    [Fact]
    public void AFileThatIsNotYamlSaysSoAtTheStart()
    {
        var refused = Assert.Throws<LoadException>(() => Load("suite: [unclosed\ntests: 1"));
        Assert.Equal(Position.Start, refused.Position);
        Assert.NotEqual(string.Empty, refused.Message);
    }

    [Fact]
    public void AnEmptyFileHoldsNoDocument()
    {
        Assert.Throws<LoadException>(() => Load(string.Empty));
        Assert.Throws<LoadException>(() => Load("# only a comment\n"));
    }

    [Fact]
    public void ADocumentThatIsAListStillParses()
    {
        var document = Load("- just\n- a\n- list\n");
        Assert.IsType<List<object?>>(document.Value);
    }

    [Fact]
    public void PointersEscapeAndWalk()
    {
        Assert.Equal("a~1b", SuiteDocument.Escape("a/b"));
        Assert.Equal("a~0b", SuiteDocument.Escape("a~b"));
        Assert.Equal("/x/a~1b", SuiteDocument.Child("/x", "a/b"));

        var document = Load("tests:\n  - steps:\n      - action: core.noop\n");
        Assert.True(document.TryGet("/tests/0/steps/0/action", out var action));
        Assert.Equal("core.noop", action);
        Assert.False(document.TryGet("/tests/9", out _));
        Assert.False(document.TryGet("/tests/0/steps/0/action/deeper", out _));
        Assert.True(Pointer.TryWalk(document.Value, string.Empty, out _));
    }

    [Fact]
    public void AnOrderedMapKeepsItsOrder()
    {
        var ordered = new OrderedMap();
        foreach (var key in new[] { "b", "a", "c" })
        {
            ordered.Set(key, key);
        }
        ordered.Set("b", "again");
        Assert.Equal(["b", "a", "c"], ordered.Keys);
        Assert.Equal("again", ordered.Value("b"));
        Assert.Equal(3, ordered.Count);
        Assert.True(ordered.Has("a"));
        Assert.False(ordered.Has("z"));
        Assert.Equal("""{"b":"again","a":"a","c":"c"}""", ordered.ToJson());
    }

    [Fact]
    public void AnOrderedMapDeletesAndClones()
    {
        var ordered = new OrderedMap();
        ordered.Set("a", 1L);
        ordered.Set("b", 2L);
        var copied = ordered.Clone();
        ordered.Remove("a");
        ordered.Remove("nosuch");
        Assert.Equal(1, ordered.Count);
        Assert.False(ordered.Has("a"));
        Assert.Equal(2, copied.Count);
    }

    [Fact]
    public void APositionIsOneBased()
    {
        Assert.Equal(new Position(1, 1), Position.At(0, 0));
        Assert.Equal(new Position(4, 7), Position.At(4, 7));
    }

    [Fact]
    public void AnAbsentKeyAndAKeyThatIsNothingAreDifferentThings()
    {
        var document = Load("a:\nb: x\n");
        var map = Assert.IsType<OrderedMap>(document.Value);
        Assert.True(map.Has("a"));
        Assert.False(map.Present("a"));
        Assert.True(map.Present("b"));
        Assert.False(map.Has("c"));
    }
}
