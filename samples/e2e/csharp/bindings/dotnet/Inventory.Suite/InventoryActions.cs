namespace Inventory.Suite;

using Bdd.Suite.Actions;
using Bdd.Suite.Model;
using Bdd.Suite.Values;

/// <summary>
/// The handlers of the inventory actions. Each reads its step's parameters
/// (the keys the catalog declares, after substitution), acts on the store the
/// step names, and returns the capture shape the catalog declares as an
/// <see cref="OrderedMap"/>.
/// </summary>
public static class InventoryActions
{
    private const string DefaultEndpoint = "https://warehouse.example/api/levels";

    internal static object? Open(ActionRequest request)
    {
        var name = request.Step.Text("name");
        var store = Store.Create(name.Length > 0 ? name : "main");
        var result = new OrderedMap();
        result.Set("name", store.Name);
        result.Set("path", store.Path);
        return result;
    }

    internal static object? Close(ActionRequest request)
    {
        var result = new OrderedMap();
        result.Set("removed", Store.Delete(Required(request, "store")));
        return result;
    }

    internal static object? Receive(ActionRequest request)
    {
        var store = Store.Load(Required(request, "store"));
        var sku = Required(request, "sku");
        var qty = Quantity(request);
        var onHand = store.Add(sku, qty);
        store.Save();

        var result = new OrderedMap();
        result.Set("sku", sku);
        result.Set("received", qty);
        result.Set("onHand", onHand);
        return result;
    }

    internal static object? Ship(ActionRequest request)
    {
        var store = Store.Load(Required(request, "store"));
        var sku = Required(request, "sku");
        var qty = Quantity(request);
        var onHand = store.Level(sku);

        var result = new OrderedMap();
        result.Set("sku", sku);
        if (onHand < qty)
        {
            // A refusal is an answer: the case asserts on it.
            result.Set("shipped", false);
            result.Set("onHand", onHand);
            result.Set("reason", $"{sku}: asked for {qty}, only {onHand} on hand");
            return result;
        }
        onHand = store.Add(sku, -qty);
        store.Save();
        result.Set("shipped", true);
        result.Set("onHand", onHand);
        return result;
    }

    internal static object? Level(ActionRequest request)
    {
        var store = Store.Load(Required(request, "store"));
        var sku = Required(request, "sku");
        var result = new OrderedMap();
        result.Set("sku", sku);
        result.Set("onHand", store.Level(sku));
        return result;
    }

    internal static object? Sync(ActionRequest request)
    {
        var store = Store.Load(Required(request, "store"));
        // The step's endpoint, else the run's --api-url, else the sample's default.
        var endpoint = request.Step.Text("endpoint");
        if (endpoint.Length == 0)
        {
            endpoint = request.State is Target { ApiUrl.Length: > 0 } target ? target.ApiUrl : DefaultEndpoint;
        }
        // The sample's stand-in for the service call: the payload is written beside the store.
        var payload = store.ToJson();
        File.WriteAllText(store.Path + ".sync.json", payload);

        var result = new OrderedMap();
        result.Set("endpoint", endpoint);
        result.Set("skus", (long)store.Count);
        result.Set("payload", payload);
        return result;
    }

    private static string Required(ActionRequest request, string key)
    {
        var value = request.Step.Text(key);
        return value.Length > 0 ? value : throw ActionException.Failed($"{request.Action}: {key} is required");
    }

    private static long Quantity(ActionRequest request)
    {
        if (!Value.TryNumber(request.Step.Value("qty"), out var qty) || qty != Math.Floor(qty) || qty <= 0)
        {
            throw ActionException.Failed($"{request.Action}: qty must be a whole number above zero, not '{Value.Text(request.Step.Value("qty"))}'");
        }
        return (long)qty;
    }
}
