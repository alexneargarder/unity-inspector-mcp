// #name Trace Method Calls
// #description Harmony-patch every overload of a method to log each call with its arguments, up to a number of calls. A method the type inherits is patched on its declaring type and only calls on the named type are logged
// #tags profiling, debugging, harmony
// #args typeName: Full type name containing the method (e.g., "TestVanDammeAnim")
// #args methodName: Method name to trace, all overloads (e.g., "FireWeapon")
// #args maxCalls: Maximum number of calls to log before logging stops (default: 100)

public static class TraceMethodCalls
{
    private const int MaxValueLength = 200;

    private static int maxCalls;
    private static int callCount;
    public static int CallCount { get { return callCount; } }
    private static bool stopped;
    private static Type targetType;
    // __originalMethod is materialized from a handle, so MethodBase identity is not guaranteed
    private static Dictionary<IntPtr, string> labels;
    // ScriptContext.Logger only carries the [Script:name] prefix while Main()/Unload() is running
    private static System.Action<string> cachedLogger;

    public static void Main()
    {
        cachedLogger = ScriptContext.Logger;
        var typeName = ScriptContext.GetArg("typeName");
        var methodName = ScriptContext.GetArg("methodName");
        var maxCallsStr = ScriptContext.GetArg("maxCalls", "100");

        if (string.IsNullOrEmpty(typeName) || string.IsNullOrEmpty(methodName))
        {
            ScriptContext.Logger("Usage: provide typeName and methodName args");
            return;
        }

        if (!int.TryParse(maxCallsStr, out maxCalls) || maxCalls < 1)
            maxCalls = 100;

        string refusal;
        var type = FindType(typeName, out refusal);
        if (type == null)
        {
            ScriptContext.Logger(refusal);
            return;
        }

        var candidates = type.GetMethods(BindingFlags.Instance | BindingFlags.Static |
                                         BindingFlags.Public | BindingFlags.NonPublic)
            .Where(m => m.Name == methodName)
            .ToList();

        if (candidates.Count == 0)
        {
            ScriptContext.Logger("Method not found: " + typeName + "." + methodName);
            return;
        }

        targetType = type;
        labels = new Dictionary<IntPtr, string>();
        callCount = 0;
        stopped = false;

        var prefix = new HarmonyMethod(typeof(TraceMethodCalls).GetMethod("TracePrefix",
            BindingFlags.Public | BindingFlags.Static));

        var lines = new List<string>();
        foreach (var method in candidates)
        {
            var label = Describe(method);
            try
            {
                ScriptContext.Harmony.Patch(AccessTools.GetDeclaredMember(method), prefix: prefix);
                labels[method.MethodHandle.Value] = label;
                lines.Add("  " + label);
            }
            catch (Exception ex)
            {
                lines.Add("  FAILED " + label + " — " + ex.Message);
            }
        }

        if (labels.Count == 0)
        {
            ScriptContext.Logger("No overload of " + type.Name + "." + methodName + " could be patched:");
            foreach (var line in lines)
                ScriptContext.Logger(line);
            return;
        }

        var inherited = candidates.Where(m => m.DeclaringType != type).Select(m => m.DeclaringType.Name).Distinct().ToList();
        ScriptContext.Logger("Tracing " + labels.Count + " of " + candidates.Count + " overload(s) of " + type.Name + "." + methodName +
            " (max " + maxCalls + " calls). Use unload_script to stop early.");
        if (inherited.Count > 0)
            ScriptContext.Logger("Declared on " + string.Join(", ", inherited.ToArray()) + ": only calls on a " + type.Name + " are logged.");
        foreach (var line in lines)
            ScriptContext.Logger(line);
    }

    internal static Type FindType(string typeName, out string refusal)
    {
        refusal = null;
        Type dynamicMatch = null;
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            Type[] types;
            try { types = assembly.GetTypes(); }
            catch { continue; }
            var match = types.FirstOrDefault(t => t.Name == typeName || t.FullName == typeName);
            if (match == null) continue;
            if (!(assembly is System.Reflection.Emit.AssemblyBuilder)) return match;
            if (dynamicMatch == null) dynamicMatch = match;
        }

        refusal = dynamicMatch != null
            ? typeName + " is compiled by the script system; Harmony cannot patch it"
            : "Type not found: " + typeName;
        return null;
    }

    public static void TracePrefix(object __instance, MethodBase __originalMethod, object[] __args)
    {
        if (stopped) return;
        if (__instance != null && targetType != null && !targetType.IsInstanceOfType(__instance)) return;

        callCount++;

        var instanceName = __instance != null ? Stringify(__instance) : "static";
        var argsStr = "";
        if (__args != null && __args.Length > 0)
        {
            var parts = new string[__args.Length];
            for (int i = 0; i < __args.Length; i++)
                parts[i] = Stringify(__args[i]);
            argsStr = " args: [" + string.Join(", ", parts) + "]";
        }

        cachedLogger("[#" + callCount + " f:" + Time.frameCount + "] " +
            LabelOf(__originalMethod) + " on " + instanceName + argsStr);

        if (callCount >= maxCalls)
        {
            stopped = true;
            cachedLogger("Max calls reached (" + maxCalls + "). Logging stopped. Use unload_script to clean up patches.");
        }
    }

    private static string LabelOf(MethodBase method)
    {
        if (method == null) return "?";
        try
        {
            string label;
            if (labels != null && labels.TryGetValue(method.MethodHandle.Value, out label)) return label;
        }
        catch
        {
        }
        return method.DeclaringType.Name + "." + method.Name;
    }

    private static string Describe(MethodInfo method)
    {
        var parameters = method.GetParameters();
        var parts = new string[parameters.Length];
        for (int i = 0; i < parameters.Length; i++)
            parts[i] = parameters[i].ParameterType.Name;
        return method.DeclaringType.Name + "." + method.Name + "(" + string.Join(", ", parts) + ")";
    }

    private static string Stringify(object value)
    {
        if (value == null) return "null";
        try
        {
            var text = value.ToString();
            if (text == null) return "null";
            if (text.Length > MaxValueLength)
                text = text.Substring(0, MaxValueLength) + "...";
            return text;
        }
        catch
        {
            return "<error>";
        }
    }

    public static void Unload()
    {
        ScriptContext.Logger("Trace complete. " + callCount + " calls recorded.");
    }
}
