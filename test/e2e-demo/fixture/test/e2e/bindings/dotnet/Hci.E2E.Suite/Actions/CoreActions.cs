using System;
using System.Collections.Generic;

namespace Demo.Suite.Actions;

public sealed record ActionRequest(IReadOnlyDictionary<string, object?> Params);

public sealed class ActionException : Exception
{
    private ActionException(string message) : base(message) { }
    public static ActionException Failed(string message) => new(message);
}

public static class CoreActions
{
    /// <summary>Every action this binding implements, by name.</summary>
    public static IReadOnlyDictionary<string, Func<ActionRequest, object?>> Registry { get; } =
        new Dictionary<string, Func<ActionRequest, object?>>(StringComparer.Ordinal)
        {
            ["demo.greet"] = DemoGreet,
            ["orders.create"] = OrdersCreate,
        };

    private static object? DemoGreet(ActionRequest request) =>
        new Dictionary<string, object?> { ["greeting"] = $"Hello, {request.Params["name"]}" };

    /// <summary>Creates an order for the step's item; the step captures it as `order`.</summary>
    private static object? OrdersCreate(ActionRequest request)
    {
        var quantity = request.Params.TryGetValue("quantity", out var q) ? q : 1;
        return new Dictionary<string, object?>
        {
            ["id"] = Guid.NewGuid().ToString("N"),
            ["item"] = request.Params["item"],
            ["quantity"] = quantity,
        };
    }
}
