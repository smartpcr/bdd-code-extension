namespace {{Namespace}}.Suite;

using Bdd.Suite.Actions;
using Bdd.Suite.Model;

/// <summary>
/// The handlers of the {{name}} actions. Each reads its step's parameters (the
/// keys the catalog declares, after substitution) from
/// <see cref="ActionRequest.Step"/>, does its work, and returns the capture
/// shape the catalog declares as an <see cref="OrderedMap"/>. A failure is
/// <see cref="ActionException.Failed"/>; the environment the run targets is
/// <see cref="ActionRequest.State"/> (a <see cref="Target"/>).
/// </summary>
public static class {{Namespace}}Actions
{
    internal static object? {{ActionName}}(ActionRequest request)
    {
        var text = request.Step.Text("text");
        if (text.Length == 0)
        {
            throw ActionException.Failed("{{action}}: text is required");
        }
        var result = new OrderedMap();
        result.Set("text", text);
        return result;
    }
}
