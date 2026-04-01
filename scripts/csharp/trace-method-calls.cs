// #name Trace Method Calls
// #description Harmony-patch a method to log every call with arguments for a specified number of frames
// #tags profiling, debugging, harmony
// #args typeName: Full type name containing the method (e.g., "TestVanDammeAnim")
// #args methodName: Method name to trace (e.g., "FireWeapon")
// #args maxCalls: Maximum number of calls to log before auto-stopping (default: 100)

public static class TraceMethodCalls
{
    private static int maxCalls;
    private static int callCount;
    private static string tracedMethod;
    private static bool stopped;

    public static void Main()
    {
        var typeName = ScriptContext.GetArg("typeName");
        var methodName = ScriptContext.GetArg("methodName");
        var maxCallsStr = ScriptContext.GetArg("maxCalls", "100");

        if (string.IsNullOrEmpty(typeName) || string.IsNullOrEmpty(methodName))
        {
            ScriptContext.Logger("Usage: provide typeName and methodName args");
            return;
        }

        if (!int.TryParse(maxCallsStr, out maxCalls))
            maxCalls = 100;

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

        var method = type.GetMethod(methodName,
            BindingFlags.Instance | BindingFlags.Static |
            BindingFlags.Public | BindingFlags.NonPublic);

        if (method == null)
        {
            ScriptContext.Logger("Method not found: " + typeName + "." + methodName);
            return;
        }

        tracedMethod = typeName + "." + methodName;
        callCount = 0;
        stopped = false;

        var prefix = new HarmonyMethod(typeof(TraceMethodCalls).GetMethod("TracePrefix",
            BindingFlags.Public | BindingFlags.Static));

        ScriptContext.Harmony.Patch(method, prefix: prefix);
        ScriptContext.Logger("Tracing " + tracedMethod + " (max " + maxCalls + " calls). Use unload_script to stop early.");
    }

    public static void TracePrefix(object __instance, MethodBase __originalMethod, object[] __args)
    {
        if (stopped) return;

        callCount++;

        var instanceName = __instance != null ? __instance.ToString() : "static";
        var argsStr = "";
        if (__args != null && __args.Length > 0)
        {
            var parts = new string[__args.Length];
            for (int i = 0; i < __args.Length; i++)
                parts[i] = __args[i] != null ? __args[i].ToString() : "null";
            argsStr = " args: [" + string.Join(", ", parts) + "]";
        }

        if (ScriptContext.Logger != null)
        {
            ScriptContext.Logger("[#" + callCount + " f:" + Time.frameCount + "] " +
                tracedMethod + " on " + instanceName + argsStr);
        }

        if (callCount >= maxCalls)
        {
            stopped = true;
            if (ScriptContext.Logger != null)
                ScriptContext.Logger("Max calls reached (" + maxCalls + "). Logging stopped. Use unload_script to clean up patches.");
        }
    }

    public static void Unload()
    {
        ScriptContext.Logger("Trace complete. " + callCount + " calls recorded.");
    }
}
