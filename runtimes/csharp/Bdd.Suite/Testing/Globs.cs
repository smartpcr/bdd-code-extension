using System.Text;
using System.Text.RegularExpressions;

namespace Bdd.Suite.Testing;

/// <summary>
/// The globs a test-generation config names (spec/test-plan.md, Building the
/// plan, step 1): <c>**</c> any number of folders, <c>*</c> any text inside one
/// name, <c>?</c> one character; relative to the config's folder, forward
/// slashes, and <c>..</c> allowed before the first wildcard. Every runtime
/// implements the same rules, so they select the same files.
/// </summary>
public static class Globs
{
    /// <summary>The files the includes match and the excludes do not, as paths
    /// relative to the folder with forward slashes, in ordinal order.</summary>
    public static List<string> Select(string folder, IEnumerable<string> includes, IEnumerable<string> excludes)
    {
        var root = Path.GetFullPath(folder);
        var rejected = excludes.Select(pattern => Matcher(root, pattern)).ToList();
        var found = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var pattern in includes)
        {
            var (start, _) = Split(root, pattern);
            if (!Directory.Exists(start))
            {
                continue;
            }
            var accept = Matcher(root, pattern);
            foreach (var file in Directory.EnumerateFiles(start, "*", SearchOption.AllDirectories))
            {
                var full = Normal(file);
                if (accept(full) && !rejected.Any(reject => reject(full)))
                {
                    found.Add(Relative(root, file));
                }
            }
        }
        return [.. found];
    }

    /// <summary>A path relative to a folder, with forward slashes.</summary>
    public static string Relative(string folder, string path) =>
        Path.GetRelativePath(folder, path).Replace('\\', '/');

    private static string Normal(string path) => Path.GetFullPath(path).Replace('\\', '/');

    /// <summary>The folder a pattern starts in (its segments before the first
    /// wildcard) and the rest.</summary>
    private static (string Start, string Remainder) Split(string root, string pattern)
    {
        var segments = pattern.Split('/');
        var fixedCount = 0;
        while (fixedCount < segments.Length - 1 && segments[fixedCount].IndexOfAny(['*', '?']) < 0)
        {
            fixedCount++;
        }
        var start = Path.GetFullPath(Path.Combine([root, .. segments.Take(fixedCount)]));
        return (start, string.Join('/', segments.Skip(fixedCount)));
    }

    private static Func<string, bool> Matcher(string root, string pattern)
    {
        var (start, rest) = Split(root, pattern);
        var regex = new StringBuilder("^").Append(Regex.Escape(Normal(start).TrimEnd('/'))).Append('/');
        for (var index = 0; index < rest.Length; index++)
        {
            var one = rest[index];
            if (one == '*' && index + 1 < rest.Length && rest[index + 1] == '*')
            {
                var slash = index + 2 < rest.Length && rest[index + 2] == '/';
                regex.Append(slash ? "(?:.*/)?" : ".*");
                index += slash ? 2 : 1;
            }
            else if (one == '*')
            {
                regex.Append("[^/]*");
            }
            else if (one == '?')
            {
                regex.Append("[^/]");
            }
            else
            {
                regex.Append(Regex.Escape(one.ToString()));
            }
        }
        regex.Append('$');
        var options = OperatingSystem.IsWindows() ? RegexOptions.IgnoreCase : RegexOptions.None;
        var compiled = new Regex(regex.ToString(), options | RegexOptions.CultureInvariant);
        return compiled.IsMatch;
    }
}
