// #name Utility Mod Save Guard
// #description While loaded, makes every save of Utility Mod's settings write the recorded disableEnemySpawn and the changeSpawn and changeSpawnFinal found at load, so a test script that changes them in memory never reaches the file. spawning.json and player-states.json load and unload it
// #tags test
// #args recordSlots: "true" also records Utility Mod's enabled and disableEnemySpawn in the uimtest.u3.ums slots, for a script that restores them from there

public static class UtilityModSaveGuard
{
    private static object settings;
    private static FieldInfo[] guarded;
    private static object[] recorded;
    private static object[] live;
    // SaveToProfile calls Save
    private static int depth;

    public static void Main()
    {
        const BindingFlags statics = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
        const BindingFlags instance = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        Type main = null;
        foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (a.GetName().Name == "Utility Mod") main = a.GetType("Utility_Mod.Main");
        }
        if (main == null)
        {
            ScriptContext.Logger("Utility Mod is not loaded, so there is nothing to guard");
            return;
        }

        settings = main.GetField("settings", statics).GetValue(null);
        var disableEnemySpawn = settings.GetType().GetField("disableEnemySpawn", instance);
        string snap = main.GetField("enabled", statics).GetValue(null) + "|" + disableEnemySpawn.GetValue(settings);

        var d = AppDomain.CurrentDomain;
        if (ScriptContext.GetArg("recordSlots") == "true")
        {
            if (d.GetData("uimtest.u3.ums") == null) d.SetData("uimtest.u3.ums", snap);
            d.SetData("uimtest.u3.ums.found", snap);
        }
        string ums = (d.GetData("uimtest.u3.ums") as string) ?? snap;

        guarded = new[]
        {
            disableEnemySpawn,
            settings.GetType().GetField("changeSpawn", instance),
            settings.GetType().GetField("changeSpawnFinal", instance)
        };
        recorded = guarded.Select(f => f.GetValue(settings)).ToArray();
        recorded[0] = ums.Split('|')[1] == "True";
        live = new object[guarded.Length];

        var prefix = new HarmonyMethod(typeof(UtilityModSaveGuard).GetMethod("SavePrefix", statics));
        var finalizer = new HarmonyMethod(typeof(UtilityModSaveGuard).GetMethod("SaveFinalizer", statics));
        var patched = new List<string>();
        foreach (var m in settings.GetType().GetMethods(instance | BindingFlags.DeclaredOnly))
        {
            if (!m.Name.StartsWith("Save") || m.IsAbstract) continue;
            ScriptContext.Harmony.Patch(m, prefix, null, null, finalizer);
            patched.Add(m.Name);
        }
        if (patched.Count == 0) throw new InvalidOperationException("Utility Mod's settings declare no save to patch");

        ScriptContext.Logger("recorded utility mod enabled|disableEnemySpawn=" + ums + " changeSpawn|changeSpawnFinal=" + recorded[1] + "|" + recorded[2] + ", guarding " + string.Join(", ", patched.ToArray()));
    }

    private static void SavePrefix()
    {
        if (depth++ > 0) return;
        for (int i = 0; i < guarded.Length; i++)
        {
            live[i] = guarded[i].GetValue(settings);
            guarded[i].SetValue(settings, recorded[i]);
        }
    }

    private static void SaveFinalizer()
    {
        if (--depth > 0) return;
        for (int i = 0; i < guarded.Length; i++)
        {
            guarded[i].SetValue(settings, live[i]);
        }
    }
}
