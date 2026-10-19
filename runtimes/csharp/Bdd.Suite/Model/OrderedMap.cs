using System.Text;
using System.Text.Json;

namespace Bdd.Suite.Model;

/// <summary>
/// An object that remembers the order its keys were written in.
///
/// The order matters twice. It decides which of two findings in one object comes
/// first, which the diagnostic sort then has to break ties on; and it decides
/// what a captured value serialises to, which a report carries.
/// </summary>
public sealed class OrderedMap
{
    private readonly List<string> _keys = [];
    private readonly Dictionary<string, object?> _values = [];

    /// <summary>The keys in the order they were written.</summary>
    public IReadOnlyList<string> Keys => _keys;

    /// <summary>How many keys it holds.</summary>
    public int Count => _keys.Count;

    /// <summary>Write one key, keeping its first position when it is already there.</summary>
    public void Set(string key, object? value)
    {
        if (!_values.ContainsKey(key))
        {
            _keys.Add(key);
        }
        _values[key] = value;
    }

    /// <summary>Read one key.</summary>
    public bool TryGet(string key, out object? value) => _values.TryGetValue(key, out value);

    /// <summary>Read one key, or nothing.</summary>
    public object? Value(string key) => _values.TryGetValue(key, out var value) ? value : null;

    /// <summary>Whether a key is there at all, which is not the same as its value
    /// being something.</summary>
    public bool Has(string key) => _values.ContainsKey(key);

    /// <summary>Whether a key is there and is something.</summary>
    public bool Present(string key) => _values.TryGetValue(key, out var value) && value is not null;

    /// <summary>Remove one key.</summary>
    public void Remove(string key)
    {
        if (_values.Remove(key))
        {
            _keys.Remove(key);
        }
    }

    /// <summary>Copy the map one level deep, which is what a step that is about
    /// to be rewritten needs.</summary>
    public OrderedMap Clone()
    {
        var copied = new OrderedMap();
        foreach (var key in _keys)
        {
            copied.Set(key, _values[key]);
        }
        return copied;
    }

    /// <summary>
    /// Copy the map and every map and list inside it, so nothing the copy holds is
    /// shared with the original. What a case starts from: an action that changes a
    /// nested value it was given in place cannot reach another case or the
    /// teardown (spec/session.md, rule 5).
    /// </summary>
    public OrderedMap DeepClone() => (OrderedMap)DeepCopy(this)!;

    private static object? DeepCopy(object? value) => value switch
    {
        OrderedMap map => map._keys.Aggregate(new OrderedMap(), (copied, key) =>
        {
            copied.Set(key, DeepCopy(map._values[key]));
            return copied;
        }),
        List<object?> items => items.Select(DeepCopy).ToList(),
        _ => value,
    };

    /// <summary>Read one key as text, or the empty string.</summary>
    public string Text(string key) => Value(key) as string ?? string.Empty;

    /// <summary>Read one key as a list, or nothing.</summary>
    public List<object?>? List(string key) => Value(key) as List<object?>;

    /// <summary>Read one key as an object, or nothing.</summary>
    public OrderedMap? Map(string key) => Value(key) as OrderedMap;

    /// <summary>
    /// The JSON this object serialises to, keys in their own order rather than
    /// sorted, because that is the order the file declared them in.
    /// </summary>
    public string ToJson()
    {
        var out_ = new StringBuilder();
        WriteJson(this, out_);
        return out_.ToString();
    }

    internal static void WriteJson(object? value, StringBuilder into)
    {
        switch (value)
        {
            case null:
                into.Append("null");
                return;
            case OrderedMap map:
                into.Append('{');
                for (var index = 0; index < map._keys.Count; index++)
                {
                    if (index > 0)
                    {
                        into.Append(',');
                    }
                    into.Append(JsonSerializer.Serialize(map._keys[index]));
                    into.Append(':');
                    WriteJson(map._values[map._keys[index]], into);
                }
                into.Append('}');
                return;
            case List<object?> items:
                into.Append('[');
                for (var index = 0; index < items.Count; index++)
                {
                    if (index > 0)
                    {
                        into.Append(',');
                    }
                    WriteJson(items[index], into);
                }
                into.Append(']');
                return;
            case string text:
                into.Append(JsonSerializer.Serialize(text));
                return;
            case bool yes:
                into.Append(yes ? "true" : "false");
                return;
            case long whole:
                into.Append(whole.ToString(System.Globalization.CultureInfo.InvariantCulture));
                return;
            case double fraction:
                into.Append(Values.Value.Number(fraction));
                return;
            default:
                into.Append(JsonSerializer.Serialize(value));
                return;
        }
    }
}
