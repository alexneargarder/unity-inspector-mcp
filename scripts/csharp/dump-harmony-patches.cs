// #name Dump Harmony Patches
// #description List all Harmony patches on a specified method, showing patch owner, type, and priority
// #tags harmony, debugging
// #args typeName: Full type name containing the method (e.g., "TestVanDammeAnim")
// #args methodName: Method name to inspect (e.g., "Damage")

using System.Collections.ObjectModel;

public static class DumpHarmonyPatches
{
    public static void Main()
    {
        var typeName = ScriptContext.GetArg("typeName");
        var methodName = ScriptContext.GetArg("methodName");

        if (string.IsNullOrEmpty(typeName) || string.IsNullOrEmpty(methodName))
        {
            ScriptContext.Logger("Usage: provide typeName and methodName args");
            ScriptContext.Logger("Example: typeName=TestVanDammeAnim methodName=Damage");

            ScriptContext.Logger("\nAll patched methods:");
            var allPatched = Harmony.GetAllPatchedMethods().ToList();
            ScriptContext.Logger("Total: " + allPatched.Count);
            foreach (var m in allPatched.Take(50))
            {
                ScriptContext.Logger("  " + m.DeclaringType.FullName + "." + m.Name);
            }
            if (allPatched.Count > 50)
                ScriptContext.Logger("  ... and " + (allPatched.Count - 50) + " more");
            return;
        }

        var type = AppDomain.CurrentDomain.GetAssemblies()
            .SelectMany(a =>
            {
                try { return a.GetTypes(); }
                catch { return new Type[0]; }
            })
            .FirstOrDefault(t => t.Name == typeName || t.FullName == typeName);

        if (type == null)
        {
            ScriptContext.Logger("Type not found: " + typeName);
            return;
        }

        var methods = type.GetMethods(BindingFlags.Instance | BindingFlags.Static |
                                       BindingFlags.Public | BindingFlags.NonPublic |
                                       BindingFlags.DeclaredOnly)
            .Where(m => m.Name == methodName)
            .ToList();

        if (methods.Count == 0)
        {
            ScriptContext.Logger("Method not found: " + typeName + "." + methodName);
            return;
        }

        foreach (var method in methods)
        {
            var patches = Harmony.GetPatchInfo(method);
            if (patches == null)
            {
                ScriptContext.Logger(typeName + "." + methodName + ": No patches");
                continue;
            }

            ScriptContext.Logger(typeName + "." + methodName + ":");
            LogPatches("  Prefixes", patches.Prefixes);
            LogPatches("  Postfixes", patches.Postfixes);
            LogPatches("  Transpilers", patches.Transpilers);
            LogPatches("  Finalizers", patches.Finalizers);
        }
    }

    private static void LogPatches(string label, System.Collections.ObjectModel.ReadOnlyCollection<Patch> patches)
    {
        if (patches == null || patches.Count == 0) return;
        ScriptContext.Logger(label + " (" + patches.Count + "):");
        foreach (var p in patches)
        {
            ScriptContext.Logger("    [" + p.priority + "] " + p.owner +
                " -> " + p.PatchMethod.DeclaringType.FullName + "." + p.PatchMethod.Name);
        }
    }
}
