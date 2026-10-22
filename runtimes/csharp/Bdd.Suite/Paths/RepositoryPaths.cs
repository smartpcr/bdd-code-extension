using System.Globalization;

namespace Bdd.Suite.Paths;

/// <summary>
/// Where a workspace's schema is, and which files a glob names.
///
/// The workspace root is found by walking up until test/e2e/schema appears
/// (the layout a workspace uses by default), so the runtime works from any
/// working directory and needs no environment variable set first; --schema-root
/// names another place, and then no walk is needed.
/// </summary>
public static class RepositoryPaths
{
    /// <summary>The nearest ancestor of a directory holding test/e2e/schema.</summary>
    public static string? FindRoot(string start)
    {
        var here = Path.GetFullPath(start);
        while (true)
        {
            if (Directory.Exists(Path.Combine(here, "test", "e2e", "schema")))
            {
                return here;
            }
            var parent = Path.GetDirectoryName(here);
            if (parent is null || string.Equals(parent, here, StringComparison.Ordinal))
            {
                return null;
            }
            here = parent;
        }
    }

    /// <summary>The root, found from the working directory.</summary>
    public static string? FindRoot() => FindRoot(Directory.GetCurrentDirectory());

    /// <summary>Where suite.schema.json and actions.catalog.yaml are.</summary>
    public static string SchemaRoot(string root) => Path.Combine(root, "test", "e2e", "schema");

    /// <summary>
    /// A suite and its schema where a test assembly runs (docs/test-providers
    /// DEC-T13). Generated tests name both by the paths they had on the machine
    /// that built them; a test package copied to another machine carries the
    /// suites beside its assembly instead. When the generated paths are there,
    /// they are used as they are. Otherwise the schema is the nearest
    /// test/e2e/schema above <paramref name="assemblyDirectory"/>, and the suite
    /// keeps its place relative to the schema's parent folder, so
    /// <c>suites/orders.yml</c> beside <c>schema</c> at build time is
    /// <c>test/e2e/suites/orders.yml</c> beside <c>test/e2e/schema</c> there.
    /// When neither is found the generated paths are returned, and opening the
    /// suite reports the path it was built with.
    /// </summary>
    public static (string Suite, string SchemaRoot) Locate(string suitePath, string schemaRoot, string assemblyDirectory)
    {
        if (File.Exists(suitePath) && Directory.Exists(schemaRoot))
        {
            return (suitePath, schemaRoot);
        }
        var root = FindRoot(assemblyDirectory);
        var builtParent = Path.GetDirectoryName(Path.GetFullPath(schemaRoot));
        if (root is null || builtParent is null)
        {
            return (suitePath, schemaRoot);
        }
        var deployedSchema = SchemaRoot(root);
        var relative = Path.GetRelativePath(builtParent, Path.GetFullPath(suitePath));
        var deployedSuite = Path.GetFullPath(Path.Combine(root, "test", "e2e", relative));
        return File.Exists(deployedSuite) ? (deployedSuite, deployedSchema) : (suitePath, schemaRoot);
    }

    /// <summary>
    /// Whether a name matches a glob of the kind a --path takes: `*` for any run
    /// of characters inside one segment, `?` for one, and nothing else.
    ///
    /// Written out rather than taken from a library because the whole vocabulary
    /// is two characters, and because a library that treats `**` or `[a-z]` as
    /// meaningful would quietly accept patterns the other bindings do not.
    /// </summary>
    public static bool MatchesGlob(string pattern, string name)
    {
        int atPattern = 0, atName = 0, star = -1, starAtName = 0;
        while (atName < name.Length)
        {
            if (atPattern < pattern.Length && (pattern[atPattern] == '?' || pattern[atPattern] == name[atName]))
            {
                atPattern++;
                atName++;
            }
            else if (atPattern < pattern.Length && pattern[atPattern] == '*')
            {
                star = atPattern;
                starAtName = atName;
                atPattern++;
            }
            else if (star >= 0)
            {
                atPattern = star + 1;
                starAtName++;
                atName = starAtName;
            }
            else
            {
                return false;
            }
        }
        while (atPattern < pattern.Length && pattern[atPattern] == '*')
        {
            atPattern++;
        }
        return atPattern == pattern.Length;
    }

    /// <summary>Every file a --path names, in one order on every machine.</summary>
    public static List<string> Resolve(string pattern, string workingDirectory)
    {
        var raw = pattern.Replace('\\', '/');
        var full = Path.IsPathRooted(raw) ? raw : Path.Combine(workingDirectory, raw);
        var leaf = Path.GetFileName(full);
        if (leaf.IndexOfAny(['*', '?']) < 0)
        {
            if (File.Exists(full))
            {
                return [Path.GetFullPath(full)];
            }
            throw new IOException(string.Create(CultureInfo.InvariantCulture, $"{pattern} names no file"));
        }
        var directory = Path.GetDirectoryName(full);
        if (directory is null || !Directory.Exists(directory))
        {
            throw new IOException(string.Create(CultureInfo.InvariantCulture, $"{directory} cannot be read"));
        }
        var found = Directory.EnumerateFiles(directory)
            .Where(path => MatchesGlob(leaf, Path.GetFileName(path)))
            .Select(Path.GetFullPath)
            .ToList();
        // Sorted, because a run's report lists its suites in the order they ran
        // and two machines must not order them differently.
        found.Sort(StringComparer.Ordinal);
        if (found.Count == 0)
        {
            throw new IOException(string.Create(CultureInfo.InvariantCulture, $"{pattern} names no file"));
        }
        return found;
    }
}
