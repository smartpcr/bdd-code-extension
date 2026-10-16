using System.Globalization;
using Bdd.Suite.Actions;
using Bdd.Suite.Extensions;
using Bdd.Suite.Model;

namespace Shop.Suite;

/// <summary>
/// The shop's actions, C# binding. Every handler is small and deterministic,
/// and returns what the other four bindings return for the same step, so one
/// suite gives one result everywhere.
/// </summary>
public static class Actions
{
    /// <summary>Every action this binding implements.</summary>
    public static IReadOnlyList<ActionRegistration> All { get; } =
    [
        new ActionRegistration("inventory.get", InventoryGet),
        new ActionRegistration("cart.add", CartAdd),
        new ActionRegistration("order.place", OrderPlace),
        new ActionRegistration("price.quote", PriceQuote),
        new ActionRegistration("shipping.quote", ShippingQuote),
        new ActionRegistration("customer.lookup", CustomerLookup),
        new ActionRegistration("audit.log", AuditLog),
    ];

    /// <summary>A parameter as text, or null when it is absent or empty.</summary>
    private static string? Given(ActionRequest request, string name)
    {
        var value = request.Step.Value(name);
        var text = value switch
        {
            null => null,
            string s => s,
            bool b => b ? "true" : "false",
            IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
            _ => value.ToString(),
        };
        return string.IsNullOrEmpty(text) ? null : text;
    }

    /// <summary>A required text parameter.</summary>
    private static string Text(ActionRequest request, string name) =>
        Given(request, name) ?? throw ActionException.Failed($"{request.Action} needs a {name}.");

    /// <summary>An integer parameter, given as a number or as a numeric string.</summary>
    private static long Integer(ActionRequest request, string name, long fallback)
    {
        switch (request.Step.Value(name))
        {
            case null:
                return fallback;
            case long l:
                return l;
            case int i:
                return i;
            case double d:
                return (long)d;
        }
        var raw = Given(request, name)?.Trim();
        return long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : throw ActionException.Failed($"{request.Action}: {name} is not a whole number.");
    }

    private static OrderedMap Map(params (string Key, object? Value)[] pairs)
    {
        var map = new OrderedMap();
        foreach (var (key, value) in pairs)
        {
            map.Set(key, value);
        }
        return map;
    }

    private static object? InventoryGet(ActionRequest request)
    {
        var sku = Text(request, "sku");
        return Map(("sku", sku), ("quantity", (long)sku.Length * 10), ("inStock", true));
    }

    private static object? CartAdd(ActionRequest request)
    {
        var sku = Text(request, "sku");
        var quantity = Integer(request, "quantity", 1);
        return Map(("sku", sku), ("quantity", quantity),
            ("line", string.Create(CultureInfo.InvariantCulture, $"{sku}x{quantity}")));
    }

    private static object? OrderPlace(ActionRequest request)
    {
        var sku = Text(request, "sku");
        var quantity = Integer(request, "quantity", 1);
        return Map(("orderId", string.Create(CultureInfo.InvariantCulture, $"ORD-{sku}-{quantity}")), ("status", "placed"));
    }

    private static object? PriceQuote(ActionRequest request)
    {
        var sku = Text(request, "sku");
        var quantity = Integer(request, "quantity", 1);
        return Map(("sku", sku), ("total", quantity * 3));
    }

    private static object? ShippingQuote(ActionRequest request)
    {
        var weight = Integer(request, "weightKg", 0);
        if (weight <= 0)
        {
            throw ActionException.Failed("shipping.quote needs a weightKg above zero.");
        }
        var policy = Given(request, "policy") ?? "Standard";
        long rate = policy switch
        {
            "Standard" => 5,
            "Express" => 10,
            _ => throw ActionException.Failed($"shipping.quote: unknown policy {policy}."),
        };
        return Map(("policy", policy), ("cost", weight * rate));
    }

    private static object? CustomerLookup(ActionRequest request)
    {
        var id = Text(request, "id");
        var tier = id.StartsWith('G') ? "gold" : "standard";
        return Map(("id", id), ("name", "Customer " + id), ("tier", tier));
    }

    private static object? AuditLog(ActionRequest request)
    {
        _ = Text(request, "message");
        return Map(("logged", true));
    }
}
