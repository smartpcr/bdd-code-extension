using System.Globalization;
using System.Text;
using Bdd.Suite.Model;

namespace Bdd.Suite.Values;

/// <summary>
/// One value as the text every binding writes it as.
///
/// A suite compares values that arrived as YAML, as JSON from an API, and as
/// whatever an action returned. The rules here are what keeps `equals` meaning
/// the same thing in four languages: a whole number never grows a `.0`, a
/// boolean is lowercase, and nothing at all is the empty string rather than the
/// word null.
/// </summary>
public static class Value
{
    /// <summary>A value as text.</summary>
    public static string Text(object? value)
    {
        switch (value)
        {
            case null:
                return string.Empty;
            case bool yes:
                return yes ? "true" : "false";
            case string text:
                return text;
            case long whole:
                return whole.ToString(CultureInfo.InvariantCulture);
            case int whole:
                return whole.ToString(CultureInfo.InvariantCulture);
            case double fraction:
                return Number(fraction);
            case List<object?> items:
                return string.Join(", ", items.Select(Text));
            case OrderedMap map:
                return map.ToJson();
            default:
                var built = new StringBuilder();
                OrderedMap.WriteJson(value, built);
                return built.ToString();
        }
    }

    /// <summary>A number as text: a whole number keeps no decimal part, and a
    /// fraction keeps the shortest spelling that reads back as itself.</summary>
    public static string Number(double number)
    {
        if (Math.Truncate(number) == number && Math.Abs(number) < 9.2e18)
        {
            return ((long)number).ToString(CultureInfo.InvariantCulture);
        }
        return number.ToString("R", CultureInfo.InvariantCulture);
    }

    /// <summary>Read a value as a number, when it is one.</summary>
    public static bool TryNumber(object? value, out double number)
    {
        switch (value)
        {
            case long whole:
                number = whole;
                return true;
            case int whole:
                number = whole;
                return true;
            case double fraction:
                number = fraction;
                return true;
            case string text:
                return double.TryParse(text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out number);
            default:
                number = 0;
                return false;
        }
    }

    /// <summary>Read one named member of a value, whether it arrived from YAML as
    /// an ordered map or from JSON as a plain one.</summary>
    public static bool TryField(object? value, string key, out object? found)
    {
        switch (value)
        {
            case OrderedMap map:
                return map.TryGet(key, out found);
            case IReadOnlyDictionary<string, object?> plain:
                return plain.TryGetValue(key, out found);
            default:
                found = null;
                return false;
        }
    }

    /// <summary>The keys of a value that is an object, sorted, for anything that
    /// has to walk them in one order.</summary>
    public static IReadOnlyList<string>? SortedKeys(object? value)
    {
        switch (value)
        {
            case OrderedMap map:
            {
                var names = map.Keys.ToList();
                names.Sort(StringComparer.Ordinal);
                return names;
            }
            case IReadOnlyDictionary<string, object?> plain:
            {
                var names = plain.Keys.ToList();
                names.Sort(StringComparer.Ordinal);
                return names;
            }
            default:
                return null;
        }
    }

    /// <summary>Read one named member of a value as text.</summary>
    public static string TextOf(object? value, string key) =>
        TryField(value, key, out var found) ? found as string ?? string.Empty : string.Empty;
}
