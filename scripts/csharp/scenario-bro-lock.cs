// #name Scenario Bro Lock
// #description Bro-swap scenario helper: locks one installed custom bro in BroMakerLib's memory with its save paths blocked; ScenarioBroLock.Unlock() restores it and returns the report JSON
// #tags scenario
// #args bro: the custom bro's name as BroMakerLib stores it

using System.Collections;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

public static class ScenarioBroLock
{
    public static bool Locked;
    public static string Status = "idle";
    public static string ReportJson = "";

    private const BindingFlags Any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;

    private static Action<string> log = delegate { };
    private static Type unlockManager;
    private static Type spawnManager;
    private static string broName;
    private static object state;
    private static bool wasUnlocked;
    private static object savedDate;
    private static int nameIndex = -1;
    private static int heroIndex = -1;
    private static object hero;
    private static string savePath;
    private static string hashAtLock;
    private static int blockedSaves;
    private static int blockedUnlocks;
    private static bool restored;
    private static readonly List<object> checks = new List<object>();
    private static readonly List<string> errors = new List<string>();
    private static readonly List<string> notes = new List<string>();

    public static void Main()
    {
        log = ScriptContext.Logger;
        Locked = false;
        restored = false;
        Status = "locking";
        ReportJson = "";
        checks.Clear();
        errors.Clear();
        notes.Clear();
        blockedSaves = 0;
        blockedUnlocks = 0;
        state = null;
        hero = null;
        broName = ScriptContext.GetArg("bro", "").Trim();
        try
        {
            if (broName.Length == 0) throw new InvalidOperationException("no bro named: pass bro=<custom bro name>");
            Lock(ScriptContext.Harmony);
            Status = Locked ? "locked" : "failed";
        }
        catch (Exception e)
        {
            errors.Add(e.Message);
            Status = "failed";
            log("lock failed: " + e.Message);
        }
    }

    public static string Unlock()
    {
        try
        {
            if (Locked) Restore();
        }
        catch (Exception e)
        {
            errors.Add("unlock: " + e.Message);
        }
        ReportJson = Json.Write(BuildReport());
        Status = "unlocked";
        return ReportJson;
    }

    public static void Unload()
    {
        if (!Locked) return;
        try { Restore(); }
        catch (Exception e) { log("restore on unload failed: " + e.Message); }
    }

    private static void Lock(Harmony harmony)
    {
        Assembly bml = FindAssembly("BroMakerLib");
        if (bml == null) throw new InvalidOperationException("BroMakerLib is not loaded");
        unlockManager = bml.GetType("BroMakerLib.Unlocks.BroUnlockManager");
        spawnManager = bml.GetType("BroMakerLib.Storages.BroSpawnManager");
        Type bmlMain = bml.GetType("BroMakerLib.Main");
        if (unlockManager == null || spawnManager == null) throw new InvalidOperationException("BroMakerLib has no BroUnlockManager or BroSpawnManager");

        state = Call(unlockManager, "GetBroUnlockState", broName);
        if (state == null)
        {
            foreach (object stored in (IEnumerable)Call(spawnManager, "GetAllBros"))
            {
                string n = (string)Prop(stored, "name");
                if (string.Equals(n, broName, StringComparison.OrdinalIgnoreCase)) { broName = n; break; }
            }
            state = Call(unlockManager, "GetBroUnlockState", broName);
        }
        if (state == null) throw new InvalidOperationException("BroMakerLib has no unlock state for '" + broName + "': it is not installed or is always unlocked");

        FieldInfo pathField = unlockManager.GetField("saveFilePath", Any);
        savePath = pathField == null ? null : pathField.GetValue(null) as string;
        hashAtLock = HashFile(savePath);

        Patch(harmony, unlockManager, "SaveProgressData", "SkipSave");
        if (bmlMain != null) Patch(harmony, bmlMain, "SaveAll", "SkipSave");
        else errors.Add("BroMakerLib.Main not found: SaveAll is not blocked");
        Patch(harmony, unlockManager, "UnlockBro", "GuardUnlock");

        wasUnlocked = (bool)Prop(state, "IsUnlocked");
        savedDate = Prop(state, "UnlockedDate");
        var names = (IList)Prop(null, "UnlockedBroNames", unlockManager);
        var heroes = (IList)Prop(null, "UnlockedBros", unlockManager);
        nameIndex = names.IndexOf(broName);
        heroIndex = -1;
        for (int i = 0; i < heroes.Count; i++)
        {
            if ((string)Prop(heroes[i], "name") == broName) { heroIndex = i; hero = heroes[i]; break; }
        }
        if (!wasUnlocked) notes.Add("the bro was already locked; the lock changes nothing and the unlock restores it locked");

        Locked = true;
        SetProp(state, "IsUnlocked", false);
        SetProp(state, "UnlockedDate", null);
        if (nameIndex >= 0) names.RemoveAt(nameIndex);
        if (heroIndex >= 0) heroes.RemoveAt(heroIndex);
        Call(spawnManager, "BroStatusChanged");
        RefreshSwapBros();

        bool unlocked = (bool)Call(spawnManager, "IsBroUnlocked", broName);
        bool spawnable = (bool)Call(spawnManager, "IsBroSpawnable", broName);
        bool listed = ((IList)Call(spawnManager, "GetAllUnlockedBrosNames")).Contains(broName);
        checks.Add(Check("locked", !unlocked, "IsBroUnlocked reads " + unlocked));
        checks.Add(Check("notSpawnable", !spawnable, "IsBroSpawnable reads " + spawnable));
        checks.Add(Check("absentFromUnlockedList", !listed, listed ? "still in GetAllUnlockedBrosNames" : "not in GetAllUnlockedBrosNames"));

        int probes = bmlMain == null ? 1 : 2;
        int before = blockedSaves;
        TrySave(unlockManager, "SaveProgressData");
        if (bmlMain != null) TrySave(bmlMain, "SaveAll");
        checks.Add(Check("saveGuards", blockedSaves - before == probes, "SaveProgressData" + (bmlMain == null ? "" : " and SaveAll") + " called while locked: "
            + (blockedSaves - before) + " of " + probes + " skipped"));
        log("locked '" + broName + "' in memory (was unlocked: " + wasUnlocked + ")");
    }

    private static void Restore()
    {
        SetProp(state, "IsUnlocked", wasUnlocked);
        SetProp(state, "UnlockedDate", savedDate);
        var names = (IList)Prop(null, "UnlockedBroNames", unlockManager);
        var heroes = (IList)Prop(null, "UnlockedBros", unlockManager);
        if (nameIndex >= 0 && !names.Contains(broName)) names.Insert(System.Math.Min(nameIndex, names.Count), broName);
        if (heroIndex >= 0 && hero != null && !heroes.Contains(hero)) heroes.Insert(System.Math.Min(heroIndex, heroes.Count), hero);
        Call(spawnManager, "BroStatusChanged");
        Locked = false;
        RefreshSwapBros();
        restored = true;

        bool unlocked = (bool)Call(spawnManager, "IsBroUnlocked", broName);
        bool listed = names.Contains(broName);
        bool heroBack = heroIndex < 0 || heroes.Contains(hero);
        checks.Add(Check("restored", unlocked == wasUnlocked && listed == (nameIndex >= 0) && heroBack,
            "IsBroUnlocked " + unlocked + " (was " + wasUnlocked + "), in unlocked names " + listed + ", stored hero back " + heroBack));
        string hashNow = HashFile(savePath);
        checks.Add(Check("saveFileUnchanged", hashNow == hashAtLock,
            (savePath == null ? "no save path found" : savePath) + ": " + (hashNow == hashAtLock ? "unchanged" : "changed while locked")
            + "; blocked saves " + blockedSaves + ", blocked unlocks " + blockedUnlocks));
        log("restored '" + broName + "'");
    }

    private static void RefreshSwapBros()
    {
        try
        {
            Assembly sb = FindAssembly("Swap Bros Mod");
            Type main = sb == null ? null : sb.GetType("Swap_Bros_Mod.Main");
            if (main == null) { notes.Add("Swap Bros Mod is not loaded"); return; }
            object settings = main.GetField("settings", Any).GetValue(null);
            FieldInfo enable = settings == null ? null : settings.GetType().GetField("enableBromaker", Any);
            if (enable != null && !(bool)enable.GetValue(settings)) { notes.Add("Swap Bros Mod's enableBromaker is off"); return; }
            // Swap Bros Mod rebuilds its roster from BroMakerLib's unlocked list only when the count changes
            main.GetMethod("LoadCustomBros", Any, null, Type.EmptyTypes, null).Invoke(null, null);
            main.GetMethod("CreateBroList", Any, null, Type.EmptyTypes, null).Invoke(null, null);
        }
        catch (Exception e)
        {
            errors.Add("Swap Bros Mod refresh: " + (e.InnerException ?? e).Message);
        }
    }

    private static bool SkipSave()
    {
        if (!Locked) return true;
        blockedSaves++;
        return false;
    }

    private static bool GuardUnlock(object[] __args)
    {
        if (!Locked || __args == null || __args.Length == 0 || __args[0] == null) return true;
        if ((string)Prop(__args[0], "BroName") != broName) return true;
        blockedUnlocks++;
        return false;
    }

    private static void TrySave(Type type, string method)
    {
        MethodInfo m = AccessTools.DeclaredMethod(type, method);
        if (m == null) throw new InvalidOperationException(type.Name + "." + method + " not found");
        // A bool parameter is BroMakerLib's synchronous flag, so the save lands before the hash is read
        m.Invoke(null, m.GetParameters().Select(p => p.ParameterType == typeof(bool) ? (object)true : p.IsOptional ? p.DefaultValue : null).ToArray());
    }

    private static void Patch(Harmony harmony, Type type, string method, string prefix)
    {
        MethodInfo target = AccessTools.DeclaredMethod(type, method);
        if (target == null) throw new InvalidOperationException(type.Name + "." + method + " not found, so it cannot be blocked");
        harmony.Patch(target, new HarmonyMethod(typeof(ScenarioBroLock).GetMethod(prefix, Any)));
    }

    private static Assembly FindAssembly(string name)
    {
        foreach (var a in AppDomain.CurrentDomain.GetAssemblies()) if (a.GetName().Name == name) return a;
        return null;
    }

    private static object Call(Type type, string method, params object[] args)
    {
        foreach (var m in type.GetMethods(Any))
        {
            if (m.Name == method && m.GetParameters().Length == args.Length) return m.Invoke(null, args);
        }
        throw new InvalidOperationException(type.Name + "." + method + " not found");
    }

    private static object Prop(object target, string name, Type staticType = null)
    {
        Type t = target == null ? staticType : target.GetType();
        PropertyInfo p = t.GetProperty(name, Any);
        if (p != null) return p.GetValue(target, null);
        FieldInfo f = t.GetField(name, Any);
        if (f != null) return f.GetValue(target);
        throw new InvalidOperationException(t.Name + "." + name + " not found");
    }

    private static void SetProp(object target, string name, object value)
    {
        PropertyInfo p = target.GetType().GetProperty(name, Any);
        if (p == null) throw new InvalidOperationException(target.GetType().Name + "." + name + " not found");
        p.SetValue(target, value, null);
    }

    private static string HashFile(string path)
    {
        if (path == null || !System.IO.File.Exists(path)) return "absent";
        using (var md5 = MD5.Create())
        {
            byte[] hash = md5.ComputeHash(System.IO.File.ReadAllBytes(path));
            var sb = new StringBuilder();
            foreach (byte b in hash) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }

    private static Dictionary<string, object> Check(string name, bool passed, string detail)
    {
        return new Dictionary<string, object> { { "name", name }, { "passed", passed }, { "detail", detail } };
    }

    private static Dictionary<string, object> BuildReport()
    {
        bool passed = errors.Count == 0 && checks.Count > 0;
        foreach (Dictionary<string, object> c in checks) if (!(bool)c["passed"]) passed = false;
        if (!restored) passed = false;
        var report = new Dictionary<string, object>();
        report["scenario"] = "bro-lock";
        report["passed"] = passed;
        report["bro"] = broName;
        report["wasUnlocked"] = wasUnlocked;
        report["restored"] = restored;
        report["checks"] = checks;
        report["blockedSaves"] = blockedSaves;
        report["blockedUnlocks"] = blockedUnlocks;
        report["notes"] = notes;
        report["errors"] = errors;
        return report;
    }

    internal static class Json
    {
        public static string Write(object value)
        {
            var sb = new StringBuilder();
            Append(sb, value);
            return sb.ToString();
        }

        private static void Append(StringBuilder sb, object v)
        {
            if (v == null) { sb.Append("null"); return; }
            if (v is string) { AppendString(sb, (string)v); return; }
            if (v is bool) { sb.Append((bool)v ? "true" : "false"); return; }
            if (v is float || v is double)
            {
                double d = Convert.ToDouble(v);
                if (double.IsNaN(d) || double.IsInfinity(d)) sb.Append("null");
                else sb.Append(System.Math.Round(d, 3).ToString("0.###", CultureInfo.InvariantCulture));
                return;
            }
            if (v is int || v is long) { sb.Append(Convert.ToInt64(v).ToString(CultureInfo.InvariantCulture)); return; }
            var dict = v as IDictionary;
            if (dict != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (DictionaryEntry e in dict)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    AppendString(sb, Convert.ToString(e.Key, CultureInfo.InvariantCulture));
                    sb.Append(':');
                    Append(sb, e.Value);
                }
                sb.Append('}');
                return;
            }
            var list = v as IEnumerable;
            if (list != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (object item in list)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Append(sb, item);
                }
                sb.Append(']');
                return;
            }
            AppendString(sb, v.ToString());
        }

        private static void AppendString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else if (c == '\t') sb.Append("\\t");
                else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            sb.Append('"');
        }
    }
}
