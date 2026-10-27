namespace Inventory.Suite;

using System.Text.Json;

/// <summary>
/// The system under test: a store of stock levels by SKU, kept in one JSON
/// file. Every action loads it, changes it and saves it, so the state lives
/// in the file and not in the process: a case's steps see one store, and two
/// cases never share one.
/// </summary>
internal sealed class Store
{
    private readonly Dictionary<string, long> levels;

    private Store(string path, string name, Dictionary<string, long> levels)
    {
        Path = path;
        Name = name;
        this.levels = levels;
    }

    public string Path { get; }

    public string Name { get; }

    public int Count => levels.Count;

    /// <summary>The folder every store lives in, under the system temp folder.</summary>
    public static string Folder => System.IO.Path.Combine(System.IO.Path.GetTempPath(), "bdd-inventory");

    public static Store Create(string name)
    {
        Directory.CreateDirectory(Folder);
        var path = System.IO.Path.Combine(Folder, $"{name}-{Guid.NewGuid():N}.json");
        var store = new Store(path, name, new Dictionary<string, long>(StringComparer.Ordinal));
        store.Save();
        return store;
    }

    public static Store Load(string path)
    {
        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"no store at {path}: open one with store.open first");
        }
        var levels = JsonSerializer.Deserialize<Dictionary<string, long>>(File.ReadAllText(path)) ?? [];
        var name = System.IO.Path.GetFileNameWithoutExtension(path);
        return new Store(path, name[..Math.Max(0, name.LastIndexOf('-'))], new Dictionary<string, long>(levels, StringComparer.Ordinal));
    }

    /// <summary>Deletes the store and what a sync left beside it; false when it was already gone.</summary>
    public static bool Delete(string path)
    {
        var existed = File.Exists(path);
        File.Delete(path);
        File.Delete(path + ".sync.json");
        return existed;
    }

    public long Level(string sku) => levels.GetValueOrDefault(sku);

    /// <summary>Adds (or, negative, takes) units and returns the new level.</summary>
    public long Add(string sku, long delta) => levels[sku] = Level(sku) + delta;

    public string ToJson() => JsonSerializer.Serialize(levels);

    public void Save() => File.WriteAllText(Path, ToJson());
}
