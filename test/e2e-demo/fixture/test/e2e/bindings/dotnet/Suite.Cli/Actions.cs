using Bdd.Suite.Actions;
using Bdd.Suite.Extensions;
using Bdd.Suite.Model;

namespace Suite.Cli;

/// <summary>The demo workspace's actions: its extension of the C# runtime.</summary>
public static class Actions
{
    /// <summary>Every action the workspace adds to the runtime.</summary>
    public static IReadOnlyList<ActionRegistration> All { get; } =
    [
        new ActionRegistration("demo.greet", DemoGreet),
        new ActionRegistration("orders.create", OrdersCreate),
    ];

    private static object? DemoGreet(ActionRequest request) =>
        Result("greeting", $"Hello, {request.Step.Text("name")}");

    /// <summary>Creates an order for the step's item; the step captures it as `order`.</summary>
    private static object? OrdersCreate(ActionRequest request)
    {
        var order = new OrderedMap();
        order.Set("id", Guid.NewGuid().ToString("N"));
        order.Set("item", request.Step.Value("item"));
        order.Set("quantity", request.Step.Value("quantity") ?? 1L);
        return order;
    }

    private static OrderedMap Result(string key, object? value)
    {
        var map = new OrderedMap();
        map.Set(key, value);
        return map;
    }
}
