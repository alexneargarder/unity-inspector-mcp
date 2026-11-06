// #name Spawn Capture
// #description Capture what a spawn-style method was called with and what it produced: logs the call arguments and a dump of the returned object's initial state. Every overload of the name is patched; a method the type inherits is patched on its declaring type and only calls on the named type are captured.
// #tags harmony, debugging, spawning, inspection
// #args typeName: Full type name containing the method (e.g., "ProjectileController")
// #args methodName: Method name to capture, all overloads (e.g., "SpawnProjectileLocally")
// #args captureCount: Number of invocations to record before recording stops (default: 10)

public static class SpawnCapture
{
    private const int MaxFields = 40;
    private const int MaxValueLength = 200;

    private class TargetInfo
    {
        public string Label;
        public string[] ParamNames;
        public bool HasResult;
    }

    private static int captureLimit;
    private static int recorded;
    public static int Recorded { get { return recorded; } }
    private static bool stopped;
    private static string targetLabel;
    private static Type targetType;
    // __originalMethod is materialized from a handle, so MethodBase identity is not guaranteed
    private static Dictionary<IntPtr, TargetInfo> targets;
    // ScriptContext.Logger only carries the [Script:name] prefix while Main()/Unload() is running
    private static System.Action<string> cachedLogger;

    public static void Main()
    {
        cachedLogger = ScriptContext.Logger;
        var typeName = ScriptContext.GetArg("typeName");
        var methodName = ScriptContext.GetArg("methodName");
        var captureCountStr = ScriptContext.GetArg("captureCount", "10");

        if (string.IsNullOrEmpty(typeName) || string.IsNullOrEmpty(methodName))
        {
            ScriptContext.Logger("Usage: provide typeName and methodName args (captureCount optional)");
            return;
        }

        if (!int.TryParse(captureCountStr, out captureLimit) || captureLimit < 1)
            captureLimit = 10;

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

        targetLabel = type.Name + "." + methodName;
        targetType = type;
        targets = new Dictionary<IntPtr, TargetInfo>();
        recorded = 0;
        stopped = false;

        // BroMakerLib's default-priority prefixes do the spawn and return false, so this must sort above them
        var prefix = new HarmonyMethod(typeof(SpawnCapture).GetMethod("CapturePrefix",
            BindingFlags.Public | BindingFlags.Static))
        {
            priority = int.MaxValue
        };

        var harmonyVersion = typeof(HarmonyLib.Harmony).Assembly.GetName().Version;
        var supportsRunOriginal = harmonyVersion != null &&
            (harmonyVersion.Major > 2 || (harmonyVersion.Major == 2 && harmonyVersion.Minor >= 2));

        // __runOriginal only became injectable in Harmony 2.2; older versions refuse to apply the patch
        var postfixName = supportsRunOriginal ? "CapturePostfix" : "CapturePostfixNoRunOriginal";
        var postfix = new HarmonyMethod(typeof(SpawnCapture).GetMethod(postfixName,
            BindingFlags.Public | BindingFlags.Static));

        var patchedLines = new List<string>();
        foreach (var candidate in candidates)
        {
            try
            {
                var info = BuildTarget(candidate);
                var key = candidate.MethodHandle.Value;

                if (info.HasResult)
                    ScriptContext.Harmony.Patch(AccessTools.GetDeclaredMember(candidate), prefix: prefix, postfix: postfix);
                else
                    ScriptContext.Harmony.Patch(AccessTools.GetDeclaredMember(candidate), prefix: prefix);

                targets[key] = info;
                patchedLines.Add("  " + Describe(candidate) +
                    (info.HasResult ? "" : "  [void: arguments only, no __result]"));
            }
            catch (Exception ex)
            {
                patchedLines.Add("  FAILED " + Describe(candidate) + " — " + ex.Message);
            }
        }

        if (targets.Count == 0)
        {
            ScriptContext.Logger("No overload of " + targetLabel + " could be patched:");
            foreach (var line in patchedLines)
                ScriptContext.Logger(line);
            return;
        }

        ScriptContext.Logger("Capturing " + targets.Count + " of " + candidates.Count +
            " overload(s) of " + targetLabel + ", " + captureLimit +
            " invocation(s) total across them. Reaching the limit only stops the logging — the " +
            "patches keep running on every call until unload_script.");
        var inherited = candidates.Where(m => m.DeclaringType != type).Select(m => m.DeclaringType.Name).Distinct().ToList();
        if (inherited.Count > 0)
            ScriptContext.Logger("Declared on " + string.Join(", ", inherited.ToArray()) + ": only calls on a " + type.Name + " are captured.");
        foreach (var line in patchedLines)
            ScriptContext.Logger(line);

        if (!supportsRunOriginal)
            ScriptContext.Logger("Harmony " + harmonyVersion +
                " does not support __runOriginal — captures cannot report whether the original ran.");
    }

    public static void CapturePrefix(object __instance, object[] __args,
        MethodBase __originalMethod, out int __state)
    {
        __state = 0;
        if (stopped) return;
        if (__instance != null && targetType != null && !targetType.IsInstanceOfType(__instance)) return;

        recorded++;
        __state = recorded;
        if (recorded >= captureLimit)
            stopped = true;

        var info = LookUp(__originalMethod);
        var instanceName = __instance != null ? Stringify(__instance) : "static";
        var argsStr = "";
        if (__args != null && __args.Length > 0)
        {
            var names = info.ParamNames;
            var parts = new string[__args.Length];
            for (int i = 0; i < __args.Length; i++)
            {
                var name = names != null && i < names.Length ? names[i] : "arg" + i;
                parts[i] = name + "=" + Stringify(__args[i]);
            }
            argsStr = " args: [" + string.Join(", ", parts) + "]";
        }

        cachedLogger("[capture #" + __state + " f:" + Time.frameCount + "] " +
            info.Label + " on " + instanceName + argsStr);

        if (!info.HasResult && stopped)
            LogLimitReached();
    }

    private static void LogLimitReached()
    {
        cachedLogger("Capture limit reached (" + captureLimit + "). Recording stopped, but the " +
            "patches are still applied: every call of every patched overload still pays for " +
            "Harmony's argument array and the boxing of its value arguments. Use unload_script " +
            "to remove them.");
    }

    private static Type FindType(string typeName, out string refusal)
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

    private static TargetInfo BuildTarget(MethodInfo method)
    {
        var parameters = method.GetParameters();
        var names = new string[parameters.Length];
        var types = new string[parameters.Length];
        for (int i = 0; i < parameters.Length; i++)
        {
            names[i] = parameters[i].Name;
            types[i] = parameters[i].ParameterType.Name;
        }

        var info = new TargetInfo();
        info.Label = method.DeclaringType.Name + "." + method.Name + "(" + string.Join(", ", types) + ")";
        info.ParamNames = names;
        info.HasResult = method.ReturnType != typeof(void);
        return info;
    }

    private static TargetInfo LookUp(MethodBase method)
    {
        if (targets != null && method != null)
        {
            try
            {
                TargetInfo info;
                if (targets.TryGetValue(method.MethodHandle.Value, out info) && info != null)
                    return info;
            }
            catch
            {
            }
        }

        var fallback = new TargetInfo();
        fallback.Label = method != null ? method.DeclaringType.Name + "." + method.Name + "(?)" : targetLabel;
        fallback.ParamNames = null;
        fallback.HasResult = true;
        return fallback;
    }

    public static void CapturePostfix(object __result, bool __runOriginal, int __state)
    {
        RecordResult(__result, __state,
            __runOriginal ? "original ran" : "original skipped; result supplied by a prefix");
    }

    public static void CapturePostfixNoRunOriginal(object __result, int __state)
    {
        RecordResult(__result, __state, "original-ran status unavailable: Harmony < 2.2");
    }

    private static void RecordResult(object result, int index, string ranNote)
    {
        if (index == 0) return;

        if (result == null)
        {
            cachedLogger("  [#" + index + "] " + ranNote + " — nothing to capture (result null)");
        }
        else
        {
            var resultType = result.GetType();
            cachedLogger("  [#" + index + "] " + ranNote + " — spawned " + resultType.FullName +
                " \"" + DescribeName(result) + "\"");
            LogTransform(result);
            LogFields(result, resultType);
        }

        if (index >= captureLimit)
            LogLimitReached();
    }

    private static string DescribeName(object result)
    {
        try
        {
            var unityObject = result as UnityEngine.Object;
            if (unityObject != null)
                return unityObject.name;
        }
        catch
        {
            return "<error>";
        }
        return Stringify(result);
    }

    private static void LogTransform(object result)
    {
        var component = result as Component;
        if (component == null) return;

        try
        {
            cachedLogger("    gameObject: " + component.gameObject.name +
                " position: " + component.transform.position);
        }
        catch (Exception ex)
        {
            cachedLogger("    gameObject: <error: " + ex.Message + ">");
        }
    }

    private static void LogFields(object result, Type resultType)
    {
        var fields = resultType.GetFields(BindingFlags.Instance | BindingFlags.Public)
            .Where(f => IsSimpleType(f.FieldType))
            .OrderBy(f => f.Name)
            .ToList();

        var shown = 0;
        foreach (var field in fields)
        {
            if (shown >= MaxFields)
            {
                cachedLogger("    ... " + (fields.Count - shown) + " more field(s) omitted");
                break;
            }

            try
            {
                var value = field.GetValue(result);
                cachedLogger("    " + field.FieldType.Name + " " + field.Name + " = " + Stringify(value));
                shown++;
            }
            catch
            {
            }
        }
    }

    private static bool IsSimpleType(Type type)
    {
        if (type == null) return false;
        if (type.IsPrimitive || type.IsEnum) return true;
        if (type == typeof(string) || type == typeof(decimal)) return true;
        if (type == typeof(Vector2) || type == typeof(Vector3)) return true;
        return false;
    }

    private static string Describe(MethodInfo method)
    {
        var parameters = method.GetParameters();
        var parts = new string[parameters.Length];
        for (int i = 0; i < parameters.Length; i++)
            parts[i] = parameters[i].ParameterType.Name + " " + parameters[i].Name;
        return method.ReturnType.Name + " " + method.Name + "(" + string.Join(", ", parts) + ")";
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
        if (ScriptContext.Harmony != null)
            ScriptContext.Harmony.UnpatchAll(ScriptContext.Harmony.Id);
        ScriptContext.Logger("Spawn capture stopped. " + recorded + " invocation(s) recorded.");
    }
}
