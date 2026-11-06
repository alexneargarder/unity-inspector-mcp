// #name Scenario Level Run
// #description Level-run scenario driver: arm it before go_to_level, poll ScenarioLevelRun.Done, then read ScenarioLevelRun.ReportJson. survey=true only scans and reports the level. A run that reaches the exit leaves the level finished, its outcome held so nothing is saved, until the next load; from arming until the run's level is left, a won level's outcome, a campaign finish and a rescue's or unlock's progress record are skipped
// #tags scenario
// #args players: comma list of player numbers to drive (default 0)
// #args timeoutSec: seconds of driving, the pause menu excluded, before the run times out (default 240)
// #args durationSec: drive for N seconds with no exit or death goal (default 0, off)
// #args livesAtStart: lives set when driving starts, before the forced death (default 2)
// #args forceDeath: auto (10 s after driving starts, or 20 % of a shorter budget), off, or seconds after driving starts (default auto)
// #args requireMechanics: comma list of mechanic kinds that must be exercised
// #args exerciseAll: true to aim for every mechanic instance, not one per kind
// #args direct: true to use a zipline, elevator or switch the walk-in missed by a direct call
// #args survey: true to scan and report the level without driving

using System.Collections;
using System.Globalization;
using System.Text;
using UnityEngine.SceneManagement;

public static class ScenarioLevelRun
{
    public static string Phase = "idle";
    public static bool Done;
    public static bool Passed;
    public static string ReportJson = "";
    public static string Outcome;
    public static string HoldStatus = "idle";

    internal static Action<string> Log = delegate { };
    internal static ScenarioLevelRunner Runner;
    internal static readonly bool[] Owned = new bool[4];
    internal static readonly bool[][] Desired = { new bool[10], new bool[10], new bool[10], new bool[10] };
    internal static readonly List<string> Errors = new List<string>();
    internal static readonly List<Component> AddedAgents = new List<Component>();
    internal static readonly Dictionary<string, string> PatchKinds = new Dictionary<string, string>();

    private static Harmony kitHarmony;
    private static readonly HashSet<MethodBase> KitPatched = new HashSet<MethodBase>();

    private static object suppressionSettings;
    private static FieldInfo suppressionField;
    private static bool suppressionChanged;
    internal static Dictionary<string, object> Suppression = new Dictionary<string, object>();

    public static void Main()
    {
        Log = ScriptContext.Logger;
        Phase = "idle";
        Done = false;
        Passed = false;
        ReportJson = "";
        Outcome = null;
        HoldStatus = "idle";
        Errors.Clear();
        AddedAgents.Clear();
        PatchKinds.Clear();
        KitPatched.Clear();
        kitHarmony = ScriptContext.Harmony;
        for (int i = 0; i < 4; i++) { Owned[i] = false; Array.Clear(Desired[i], 0, 10); }

        var args = new Dictionary<string, string>();
        foreach (var key in new[] { "players", "timeoutSec", "durationSec", "livesAtStart", "forceDeath", "requireMechanics", "exerciseAll", "direct", "survey" })
        {
            string v = ScriptContext.GetArg(key, null);
            if (v != null) args[key] = v;
        }

        Patch(ScriptContext.Harmony);
        TurnOffEnemySuppression();
        PatchSuppressionSave(ScriptContext.Harmony);

        var go = new GameObject("ScenarioLevelRun");
        go.tag = "Unpausable";
        UnityEngine.Object.DontDestroyOnLoad(go);
        ScriptContext.GameObjects.Add(go);
        Runner = go.AddComponent<ScenarioLevelRunner>();
        Runner.Configure(args);
        Phase = "armed";
        Log("armed: waiting for a level load with a spawned hero");
    }

    public static void Unload()
    {
        for (int i = 0; i < 4; i++) Owned[i] = false;
        if (Runner != null)
        {
            Runner.ReleaseRescues();
            Runner.enabled = false;
        }
        foreach (var agent in AddedAgents)
        {
            if (agent != null) UnityEngine.Object.Destroy(agent);
        }
        AddedAgents.Clear();
        RestoreEnemySuppression();
        Runner = null;
        kitHarmony = null;
    }

    public static string HoldKit(string check, int player, string bro, double seconds)
    {
        if (Runner == null) return HoldStatus = "ended: " + check + " failed: no level run is armed";
        return Runner.StartHold(check, player, bro, (float)seconds);
    }

    public static string HoldRescues(int player)
    {
        if (Runner == null) return "refused: no level run is armed";
        return Runner.HoldRescues(player);
    }

    public static string LiveBro(int player)
    {
        return Runner == null ? null : Runner.LiveBro(player);
    }

    // Harmony injects arguments by name, so these match Player.GetInput's own parameter names.
    private static void InputPostfix(Player __instance, ref bool up, ref bool down, ref bool left, ref bool right,
        ref bool fire, ref bool buttonJump, ref bool special, ref bool highFive, ref bool buttonGesture, ref bool sprint)
    {
        try
        {
            int n = __instance.playerNum;
            if (n < 0 || n > 3 || !Owned[n] || __instance.UsingBotBrain) return;
            if (!InputAllowed(__instance)) return;
            bool[] d = Desired[n];
            up = d[0]; down = d[1]; left = d[2]; right = d[3]; fire = d[4];
            buttonJump = d[5]; special = d[6]; highFive = d[7]; buttonGesture = d[8]; sprint = d[9];
        }
        catch (Exception e)
        {
            NoteError("input postfix: " + e.Message);
        }
    }

    internal static bool InputAllowed(Player p)
    {
        if (!CutsceneController.PlayersCanMove()) return false;
        if (InputReader.IsBlocked || CutsceneController.InCutscene || PauseController.DelayInput) return false;
        if (PauseController.pauseStatus != PauseStatus.UnPaused) return false;
        if (p.controllerNum == NewChatController.ChatControlledBy) return false;
        if (p.controllerNum == PauseController.pausedByController) return false;
        return true;
    }

    private static void RefusalAwarePostfix(object __instance, object[] __args, MethodBase __originalMethod, bool __result)
    {
        if (__result) MechanicPostfix(__instance, __args, __originalMethod);
    }

    private static void MechanicPostfix(object __instance, object[] __args, MethodBase __originalMethod)
    {
        try
        {
            if (Runner == null || __originalMethod == null) return;
            string kind;
            if (!PatchKinds.TryGetValue(__originalMethod.DeclaringType.Name + "." + __originalMethod.Name, out kind)) return;
            Runner.OnMechanicCall(kind, __originalMethod.Name, __instance, __args);
        }
        catch (Exception e)
        {
            NoteError("mechanic postfix: " + e.Message);
        }
    }

    private static bool RescuePrefix(int playerNum, float x, float y, float range, ref bool __result)
    {
        try
        {
            if (Runner == null || !Runner.HoldsRescue(playerNum, x, y, range)) return true;
            __result = false;
            return false;
        }
        catch (Exception e)
        {
            NoteError("rescue prefix: " + e.Message);
            return true;
        }
    }

    private static bool OutcomePrefix()
    {
        try
        {
            if (Runner == null || !Runner.HoldsSave() || GameModeController.GetLevelResult() != LevelResult.Success) return true;
            Log("skipped the won level's outcome, which writes the save");
            return false;
        }
        catch (Exception e)
        {
            NoteError("outcome prefix: " + e.Message);
            return true;
        }
    }

    private static bool ProgressPrefix(MethodBase __originalMethod)
    {
        try
        {
            if (Runner == null || !Runner.HoldsSave()) return true;
            Log("skipped " + __originalMethod.DeclaringType.Name + "." + __originalMethod.Name + ", which changes progress and writes the save");
            return false;
        }
        catch (Exception e)
        {
            NoteError("progress prefix: " + e.Message);
            return true;
        }
    }

    internal static void PatchKit(TestVanDammeAnim bro, object ability)
    {
        if (kitHarmony == null) return;
        foreach (var name in new[] { "UseSpecial", "PressSpecial", "StartMelee" }) PatchKitMethod(bro.GetType(), name);
        if (ability != null) PatchKitMethod(ability.GetType(), "UseSpecial");
    }

    private static void PatchKitMethod(Type type, string name)
    {
        const BindingFlags flags = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
        try
        {
            MethodInfo m = AccessTools.Method(type, name, Type.EmptyTypes);
            if (m == null) { NoteError("no " + type.Name + "." + name + " to watch"); return; }
            // A custom bro's UseSpecial, PressSpecial or StartMelee need not call the base one, so the bro's own override is patched
            // Harmony patches a method on its declaring type, so an inherited one is patched once for every bro sharing it
            m = AccessTools.DeclaredMethod(m.DeclaringType, name, Type.EmptyTypes);
            if (m == null || m.IsAbstract || !KitPatched.Add(m)) return;
            if (name == "UseSpecial")
                kitHarmony.Patch(m, new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("SpecialPrefix", flags)),
                    new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("SpecialPostfix", flags)));
            else if (name == "PressSpecial")
                kitHarmony.Patch(m, new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("PressPrefix", flags)));
            else
                kitHarmony.Patch(m, null, new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("MeleePostfix", flags)));
        }
        catch (Exception e)
        {
            NoteError("patching " + name + " for " + type.Name + ": " + e.Message);
        }
    }

    private static int flashes;

    private static void SpecialPrefix(out int __state)
    {
        __state = flashes;
    }

    private static void SpecialPostfix(object __instance, int __state)
    {
        try
        {
            // A UseSpecial that refuses, for want of ammo or on a cooldown, flashes the ammo bar, in the base game and BroMaker's bros alike
            if (flashes == __state && Runner != null) Runner.OnKitCall(__instance, true);
        }
        catch (Exception e)
        {
            NoteError("special postfix: " + e.Message);
        }
    }

    private static void PressPrefix(TestVanDammeAnim __instance)
    {
        try
        {
            if (Runner != null) Runner.OnSpecialPress(__instance);
        }
        catch (Exception e)
        {
            NoteError("press prefix: " + e.Message);
        }
    }

    private static void AmmoPrefix(TestVanDammeAnim __instance, out int __state)
    {
        __state = __instance._specialAmmo;
    }

    private static void AmmoPostfix(TestVanDammeAnim __instance, int __state)
    {
        try
        {
            if (__state > 0 && __instance._specialAmmo < __state && Runner != null) Runner.OnAmmoSpent(__instance, __state - __instance._specialAmmo);
        }
        catch (Exception e)
        {
            NoteError("special ammo postfix: " + e.Message);
        }
    }

    private static void FlashPrefix()
    {
        flashes++;
    }

    private static void MeleePostfix(object __instance)
    {
        try
        {
            if (Runner != null) Runner.OnKitCall(__instance, false);
        }
        catch (Exception e)
        {
            NoteError("melee postfix: " + e.Message);
        }
    }

    internal static void NoteError(string message)
    {
        if (Errors.Count < 20 && !Errors.Contains(message))
        {
            Errors.Add(message);
            Log("error: " + message);
        }
    }

    private static void Patch(Harmony harmony)
    {
        const BindingFlags flags = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
        var input = new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("InputPostfix", flags));
        input.priority = Priority.Last;
        harmony.Patch(AccessTools.Method(typeof(Player), "GetInput"), null, input);
        harmony.Patch(AccessTools.Method(typeof(HeroController), "CheckRescueBros"),
            new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("RescuePrefix", flags)));
        var outcome = new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("OutcomePrefix", flags));
        outcome.priority = Priority.First;
        harmony.Patch(AccessTools.Method(typeof(GameModeController), "DetermineLevelOutcome"), outcome);
        var progress = new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("ProgressPrefix", flags));
        progress.priority = Priority.First;
        harmony.Patch(AccessTools.Method(typeof(WorldMapProgressController), "FinishCampaign"), progress);
        harmony.Patch(AccessTools.Method(typeof(PlayerProgress), "FreeBro"), progress);
        harmony.Patch(AccessTools.Method(typeof(PlayerProgress), "UnlockHero"), progress);
        harmony.Patch(AccessTools.Method(typeof(PlayerProgress), "SetLastArcadeFinishedLevel"), progress);
        harmony.Patch(AccessTools.PropertySetter(typeof(TestVanDammeAnim), "SpecialAmmo"),
            new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("AmmoPrefix", flags)), new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("AmmoPostfix", flags)));
        harmony.Patch(AccessTools.Method(typeof(HeroController), "FlashSpecialAmmo"), new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("FlashPrefix", flags)));

        var mech = new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("MechanicPostfix", flags));
        var mechResult = new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("RefusalAwarePostfix", flags));
        var targets = new[]
        {
            new[] { "ZipLine", "AttachUnit", "zipline" },
            new[] { "AssMouthOrifice", "ConsumeRPC", "wormTunnel" },
            new[] { "AssMouthOrifice", "Expel", "wormTunnel" },
            new[] { "Switch", "Activate", "switch" },
            new[] { "TeleportDoor", "Activate", "teleportDoor" },
            new[] { "DoorDoodad", "Open", "door" },
            new[] { "HatchDoodad", "Open", "hatch" },
            new[] { "Elevator", "GoUp", "elevator" },
            new[] { "Elevator", "GoDown", "elevator" },
            new[] { "Pickupable", "Collect", "pickup" },
            new[] { "Block", "BounceOn", "bouncy" }
        };
        foreach (var t in targets)
        {
            Type type = AccessTools.TypeByName(t[0]);
            MethodInfo m = type == null ? null : AccessTools.DeclaredMethod(type, t[1]);
            if (m == null) { NoteError("no " + t[0] + "." + t[1] + " to detect " + t[2]); continue; }
            foreach (var method in WithOverrides(type, m))
            {
                try
                {
                    // A bool result is the method refusing, as TeleportDoor.Activate does with an enemy near
                    harmony.Patch(method, null, method.ReturnType == typeof(bool) ? mechResult : mech);
                    PatchKinds[method.DeclaringType.Name + "." + method.Name] = t[2];
                }
                catch (Exception e)
                {
                    NoteError("patching " + method.DeclaringType.Name + "." + method.Name + ": " + e.Message);
                }
            }
        }
    }

    private static List<MethodInfo> WithOverrides(Type type, MethodInfo method)
    {
        var found = new List<MethodInfo> { method };
        Type[] parameters = method.GetParameters().Select(p => p.ParameterType).ToArray();
        Type[] types;
        try { types = type.Assembly.GetTypes(); }
        catch (ReflectionTypeLoadException e) { types = e.Types.Where(x => x != null).ToArray(); }
        // An override that skips base never reaches the base method's patch
        foreach (var sub in types)
        {
            if (sub == type || sub.ContainsGenericParameters || !type.IsAssignableFrom(sub)) continue;
            MethodInfo o = sub.GetMethod(method.Name, BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                | BindingFlags.DeclaredOnly, null, parameters, null);
            if (o != null && !o.IsAbstract) found.Add(o);
        }
        return found;
    }

    private static void TurnOffEnemySuppression()
    {
        Suppression = new Dictionary<string, object>();
        Suppression["setting"] = "Utility Mod disableEnemySpawn";
        Type mainType = null;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (asm.GetName().Name == "Utility Mod") { mainType = asm.GetType("Utility_Mod.Main"); break; }
        }
        if (mainType == null) { Suppression["found"] = false; Suppression["note"] = "Utility Mod is not loaded"; return; }
        const BindingFlags sf = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
        FieldInfo settingsField = mainType.GetField("settings", sf);
        object settings = settingsField == null ? null : settingsField.GetValue(null);
        FieldInfo field = settings == null ? null : settings.GetType().GetField("disableEnemySpawn",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        if (field == null || field.FieldType != typeof(bool))
        {
            Suppression["found"] = false;
            Suppression["note"] = "Utility Mod is loaded but its disableEnemySpawn setting could not be read";
            return;
        }
        FieldInfo enabledField = mainType.GetField("enabled", sf);
        object enabled = enabledField == null ? null : enabledField.GetValue(null);
        bool was = (bool)field.GetValue(settings);
        Suppression["found"] = true;
        Suppression["modEnabled"] = enabled is bool && (bool)enabled;
        Suppression["was"] = was;
        Suppression["turnedOff"] = was;
        Suppression["restored"] = false;
        if (was)
        {
            suppressionSettings = settings;
            suppressionField = field;
            field.SetValue(settings, false);
            suppressionChanged = true;
            Log("Utility Mod disableEnemySpawn turned off in memory for this run");
        }
    }

    private static void PatchSuppressionSave(Harmony harmony)
    {
        if (!suppressionChanged) return;
        const BindingFlags flags = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
        var prefix = new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("SuppressionSavePrefix", flags));
        var finalizer = new HarmonyMethod(typeof(ScenarioLevelRun).GetMethod("SuppressionSaveFinalizer", flags));
        int patched = 0;
        foreach (var m in suppressionSettings.GetType().GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
        {
            if (!m.Name.StartsWith("Save") || m.IsAbstract) continue;
            try
            {
                harmony.Patch(m, prefix, null, null, finalizer);
                patched++;
            }
            catch (Exception e)
            {
                NoteError("patching Utility Mod's " + m.Name + ": " + e.Message);
            }
        }
        Suppression["savePatched"] = patched > 0;
        if (patched == 0) NoteError("no Utility Mod settings save to patch: a settings save during the run would write disableEnemySpawn off");
    }

    private static void SuppressionSavePrefix()
    {
        if (suppressionChanged) suppressionField.SetValue(suppressionSettings, true);
    }

    private static void SuppressionSaveFinalizer()
    {
        if (suppressionChanged) suppressionField.SetValue(suppressionSettings, false);
    }

    internal static void RestoreEnemySuppression()
    {
        if (!suppressionChanged) return;
        try
        {
            suppressionField.SetValue(suppressionSettings, true);
            Suppression["restored"] = true;
            Log("Utility Mod disableEnemySpawn restored");
        }
        catch (Exception e)
        {
            NoteError("restoring disableEnemySpawn: " + e.Message);
        }
        suppressionChanged = false;
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
            if (v is int || v is long || v is short || v is byte)
            {
                sb.Append(Convert.ToInt64(v).ToString(CultureInfo.InvariantCulture));
                return;
            }
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
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }
    }
}

public class ScenarioLevelRunner : MonoBehaviour
{
    private const int Up = 0, Down = 1, Left = 2, Right = 3, Fire = 4, Jump = 5, Special = 6, Melee = 7;
    private const float ArmTimeoutSec = 90f;
    private const float StuckWindowSec = 2f;
    private const float StepSec = 1.2f;
    private const float MechanicGiveUpSec = 8f;
    private const float PatrolLegSec = 4f;
    private const float PatrolSpanPx = 48f;
    private const int MaxEvents = 200;

    private static readonly string[] StuckSteps = { "repath-further", "jump", "wall-climb", "reverse", "dig", "teleport" };
    private static readonly string[] ActionNames = { "fire", "jump", "special", "melee" };
    private const int FireSlot = 0, SpecialSlot = 2, MeleeSlot = 3;
    private static readonly FieldInfo UsingSpecialField = AccessTools.Field(typeof(TestVanDammeAnim), "usingSpecial");
    private static readonly FieldInfo DoingMeleeField = AccessTools.Field(typeof(TestVanDammeAnim), "doingMelee");
    private const int CallSignal = 1, StateSignal = 2;
    private static readonly int[] ActionIndex = { Fire, Jump, Special, Melee };
    private static readonly HashSet<string> DrivableKinds = new HashSet<string>
        { "ladder", "zipline", "wormTunnel", "switch", "mech", "elevator", "teleportDoor", "door", "hatch", "cage", "pickup", "quicksand", "bouncy" };
    private static readonly HashSet<string> IgnoredDoodads = new HashSet<string>
    {
        "Empty", "Mook", "Alien", "Animal", "Miniboss", "Villager", "PureEvil", "HellEnemy", "AlienBoss", "HellBoss", "ExpendabrosBoss",
        "ExperimentalTerrainBoss", "Agents", "OutdoorDoodad", "IndoorDoodad", "TreeBushes", "Tree", "Parallax1", "Parallax2", "Parallax3",
        "Cloud", "TreeBackground", "TreeBushBackground", "Fence", "Pole", "Scaffolding", "ScaffoldingBackground", "HangingDoodads",
        "TerrainRotators", "WaterSource", "SpawnPoint", "Signpost", "PureEvilDecor", "TreeFoliageBackground", "BackgroundWindowFactory",
        "BackgroundWindowStone", "TreeBushForeground", "CaveParallax1", "CaveParallax2", "CaveParallax3", "AlienFronds",
        "AlienBackgroundDecoration", "AlienTerrainDecoration", "Effects", "BackgroundWindowVault", "BackgroundPiecesAlien", "Fog",
        "HellDecoration", "ParallaxDecoration", "HellFog", "BackgroundWindowCity", "LightFog", "SetpieceBackground", "SafeArea",
        "SandstormDebris", "CityBackgroundProp", "RefugeeProps", "ShopProps", "DesertParallax", "DesertParallaxFiller", "BackgroundTrench",
        "RoguelikeBonusSpawnPoint", "ZoomAreas", "BackgroundTemple", "DesertFog"
    };
    private static readonly Dictionary<string, string> DoodadKinds = new Dictionary<string, string>
    {
        { "Cage", "cage" }, { "CageEmpty", "cage" }, { "AlienCage", "cage" }, { "VillagerCaptured", "cage" },
        { "CheckPoint", "checkpoint" }, { "VerticalCheckPoint", "checkpoint" }, { "HorizontalCheckPoint", "checkpoint" },
        { "CheckPointRunHorizontal", "checkpoint" }, { "CheckPointRunVertical", "checkpoint" }, { "CheckPointRunDescent", "checkpoint" },
        { "CheckPointAirdrop", "checkpoint" }, { "Switch", "switch" }, { "Door", "door" }, { "AlienDoor", "door" },
        { "Zipline", "zipline" }, { "Elevator", "elevator" }, { "AmmoCrate", "pickup" }, { "Crate", "pickup" },
        { "AlienGiantSandWorm", "sandworm" }
    };

    private class Mech
    {
        public string Kind;
        public Vector2 Pos;
        public Component Target;
        public bool Drivable = true;
        public bool Attempted;
        public bool Used;
    }

    private class SpecialCount
    {
        public int Runs;
        public bool On;
        private bool open, credited;
        private int lastFrame = -100;
        private float lastAt = -100f;

        public void Press(int frame, float now)
        {
            open = true;
            credited = false;
            lastFrame = frame;
            lastAt = now;
        }

        public void Signal(int frame, float now)
        {
            if (!open || credited || !Live(frame, now)) return;
            credited = true;
            Runs++;
        }

        public void Track(bool on, bool held, int frame, float now)
        {
            On = on;
            if (!open) return;
            if (on || held)
            {
                lastFrame = frame;
                lastAt = now;
            }
            else if (!Live(frame, now)) open = false;
        }

        private bool Live(int frame, float now)
        {
            return frame - lastFrame <= 3 || now - lastAt < 0.5f;
        }
    }

    private class MeleeCount
    {
        public int Runs;
        public bool On;
        private int kinds;
        private int lastFrame = -100;
        private float lastAt = -100f;
        private int callFrame = -1;

        public void Signal(int kind, int frame, float now)
        {
            if (kind == CallSignal)
            {
                // An override that calls the base one runs two patched methods in one frame.
                if (callFrame == frame) return;
                callFrame = frame;
            }
            if (kinds == 0 || (kinds & kind) != 0 || !Open(frame, now))
            {
                Runs++;
                kinds = 0;
            }
            kinds |= kind;
            lastFrame = frame;
            lastAt = now;
        }

        public void Track(bool on, int frame, float now)
        {
            if (on && kinds != 0 && Open(frame, now))
            {
                lastFrame = frame;
                lastAt = now;
            }
            On = on;
        }

        private bool Open(int frame, float now)
        {
            return frame - lastFrame <= 3 || now - lastAt < 0.25f;
        }
    }

    private class CharRecord
    {
        public int Index;
        public int Player;
        public string Name;
        public string Type;
        public string How;
        public object Char;
        public float StartT;
        public bool Ended;
        public float EndT;
        public string EndedBy;
        public readonly int[] Presses = new int[4];
        public readonly SpecialCount Special = new SpecialCount();
        public readonly MeleeCount Melee = new MeleeCount();
        public object Ability;
        public int AmmoSpent;
    }

    private class KitHold
    {
        public string Check;
        public string Bro;
        public int Player;
        public float Seconds;
        public float StartReal;
        public float EndReal;
        public CharRecord Rec;
        public string Result;
        public string Detail;
        public bool AmmoToppedUp;
        public bool RescueHeld;
        public readonly int[] Forced = new int[4];
        public readonly float[] LastForced = { -100f, -100f, -100f, -100f };
    }

    private class Driven
    {
        public int N;
        public CharRecord Record;
        public object LastCharObj;
        public TestVanDammeAnim LastChar;
        public bool DeathRecorded;
        public bool ForcedPending;
        public float SpawnedAt;
        public float LastDeathX = float.NaN;
        public int DeathRepeats;
        public float LoopX = float.NaN;
        public int LoopStuckIndex = -1;
        public float DeathAt;
        public int LastLives;
        public readonly int[] PressFrames = new int[10];
        public readonly int[] ReleaseFrames = new int[10];
        public readonly bool[] Prev = new bool[10];
        public Vector2 Anchor;
        public float AnchorAt;
        public int StuckLevel;
        public float StepUntil;
        public float StepStart;
        public int StuckIndex = -1;
        public Vector2 StuckPos;
        public int ResumeLevel;
        public int ResumeIndex = -1;
        public float ResumeAt = -100f;
        public float NextPathAt;
        public int PathCol = int.MinValue, PathRow = int.MinValue;
        public int WaypointBoost;
        public int TurnFrames;
        public int TurnDir;
        public float LastSpecialAt = -100f;
        public readonly Dictionary<string, bool> StatePrev = new Dictionary<string, bool>();
        public float TunnelStart = -1f;
    }

    private int[] players = { 0 };
    private float timeoutSec = 240f;
    private float durationSec;
    private int livesAtStart = 2;
    private string forceDeath = "auto";
    private float forceDeathAt = -1f;
    private List<string> required = new List<string>();
    private bool exerciseAll;
    private bool direct;
    private bool survey;
    private Dictionary<string, string> argsEcho = new Dictionary<string, string>();

    private string phase = "armed";
    private float gameNow;
    private float realNow;
    private bool driveStarted;
    private string armWait;
    private object armedHero;
    private float armStartReal;
    private float nextArmCheck;
    private float driveStartReal;
    private float driveStartTime;
    private float spawnSeenAt = -1f;
    private object runHero;
    private readonly List<Driven> driven = new List<Driven>();
    private string outcome;
    private string outcomeDetail;
    private bool helicopterVictory;
    private bool assisted;
    private readonly int[] actionCounts = new int[4];
    private readonly bool[] actionForced = new bool[4];
    private readonly List<CharRecord> characters = new List<CharRecord>();
    private readonly List<KitHold> holds = new List<KitHold>();
    private KitHold hold;
    private readonly bool[] rescuesHeld = new bool[4];
    private readonly bool[] rescueBlocked = new bool[4];
    private int actionsSinceSwap;
    private bool swapped;
    private bool coverageForced;
    private bool deathForced;
    private float deathForcedAt = -1f;
    private bool gibFallback;
    private bool forcedDeathSeen;
    private bool forcedRespawnSeen;
    private int forcedLivesBefore;
    private int naturalDeaths;
    private string deathDetail = "no death";
    private float furthestX;
    private float startX;
    private Vector2 startPos;
    private string progressTarget;
    private Vector2 progressTargetPos;
    private float progressStartDist;
    private float progressRemaining;
    private Vector2 lastRouteTarget;
    private bool hasRouteTarget;
    private bool patrolling;
    private Vector2 patrolAnchor;
    private int patrolBack;
    private bool patrolAway;
    private float patrolFlipAt;
    private readonly Dictionary<int, Unit> seenEnemies = new Dictionary<int, Unit>();
    private readonly HashSet<int> killedEnemies = new HashSet<int>();
    private readonly HashSet<int> despawnedEnemies = new HashSet<int>();
    private bool directCall;
    private int lastMechFrame = -1;
    private object lastMechInstance;
    private string lastMechKind;
    private float nextEnemyScan;
    private readonly List<object> events = new List<object>();
    private readonly List<object> stuckEvents = new List<object>();
    private Dictionary<string, object> context;
    private Dictionary<string, object> surveyBlock;

    private readonly Dictionary<string, int> found = new Dictionary<string, int>();
    private readonly Dictionary<string, Dictionary<string, object>> exercised = new Dictionary<string, Dictionary<string, object>>();
    private readonly Dictionary<string, int> unknownDoodads = new Dictionary<string, int>();
    private readonly Dictionary<string, int> unplacedDoodads = new Dictionary<string, int>();
    private readonly List<Mech> mechs = new List<Mech>();
    private readonly List<object> missed = new List<object>();
    private Mech mechTarget;
    private float mechTargetUntil;
    private float mechArrivedAt = -1f;
    private float nextMechPick;
    private int flagsTotal;
    private int lastFlagsActivated;
    private int lastFreed;
    private FieldInfo isFinalField;
    private HeroLevelExitPortal portal;
    private float nextPortalLook;
    private readonly List<Vector2> tunnelReps = new List<Vector2>();

    public void Configure(Dictionary<string, string> args)
    {
        argsEcho = args;
        string v;
        if (args.TryGetValue("players", out v) && v.Trim().Length > 0)
        {
            var list = new List<int>();
            foreach (var part in v.Split(','))
            {
                int n;
                if (int.TryParse(part.Trim(), out n) && n >= 0 && n <= 3 && !list.Contains(n)) list.Add(n);
            }
            if (list.Count > 0) players = list.ToArray();
        }
        timeoutSec = ParseFloat(args, "timeoutSec", 240f);
        durationSec = ParseFloat(args, "durationSec", 0f);
        livesAtStart = (int)ParseFloat(args, "livesAtStart", 2f);
        if (args.TryGetValue("forceDeath", out v) && v.Trim().Length > 0) forceDeath = v.Trim().ToLowerInvariant();
        if (args.TryGetValue("requireMechanics", out v))
        {
            foreach (var part in v.Split(','))
            {
                string k = part.Trim();
                if (k.Length > 0 && !required.Contains(k)) required.Add(k);
            }
        }
        exerciseAll = ParseBool(args, "exerciseAll");
        direct = ParseBool(args, "direct");
        survey = ParseBool(args, "survey");
        if (durationSec > 0f) forceDeath = "off";
        float seconds;
        if (forceDeath == "auto") forceDeathAt = Mathf.Min(10f, timeoutSec * 0.2f);
        else if (float.TryParse(forceDeath, NumberStyles.Float, CultureInfo.InvariantCulture, out seconds)) forceDeathAt = seconds;
        else forceDeathAt = -1f;

        armStartReal = realNow;
        armedHero = HeroController.Instance;
        isFinalField = AccessTools.Field(typeof(CheckPoint), "isFinal");
    }

    private static float ParseFloat(Dictionary<string, string> args, string key, float fallback)
    {
        string v;
        float f;
        if (args.TryGetValue(key, out v) && float.TryParse(v.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out f)) return f;
        return fallback;
    }

    private static bool ParseBool(Dictionary<string, string> args, string key)
    {
        string v;
        return args.TryGetValue(key, out v) && (v.Trim().ToLowerInvariant() == "true" || v.Trim() == "1");
    }

    private void Update()
    {
        if (phase == "done" || PauseController.Paused) return;
        gameNow += Time.deltaTime;
        realNow += Time.unscaledDeltaTime;
        try
        {
            if (phase == "armed") TickArmed();
            else if (phase == "settling") TickSettling();
            else if (phase == "driving") TickDriving();
        }
        catch (Exception e)
        {
            ScenarioLevelRun.NoteError(e.GetType().Name + ": " + e.Message);
            Finish("error", "runner threw: " + e.Message);
        }
    }

    private float Elapsed()
    {
        return realNow - driveStartReal;
    }

    private float T()
    {
        return Mathf.Round((realNow - driveStartReal) * 10f) / 10f;
    }

    private void TickArmed()
    {
        if (realNow - armStartReal > ArmTimeoutSec)
        {
            Finish("error", (armWait ?? "no level with a spawned hero") + " within " + ArmTimeoutSec + " s of arming");
            return;
        }
        if (realNow < nextArmCheck) return;
        nextArmCheck = realNow + 0.25f;
        var hero = HeroController.Instance;
        if (hero == null || ReferenceEquals(hero, armedHero) || Map.Instance == null || !LevelSelectionController.CurrentlyInGame) return;
        var waiting = new List<string>();
        foreach (int n in players)
        {
            var p = HeroController.players[n];
            if (!HeroController.IsPlaying(n)) waiting.Add("player " + n + " is not playing");
            else if (p == null || !p.IsAliveAndSpawnedHero()) waiting.Add("player " + n + " has no spawned hero");
        }
        if (waiting.Count > 0)
        {
            armWait = "a level loaded, but " + string.Join(" and ", waiting.ToArray());
            return;
        }
        if (!survey && GameModeController.IsHardcoreMode)
        {
            Finish("error", "the level is on an IronBro save, whose lives and dead bros a run would write; only survey=true runs there");
            return;
        }
        runHero = hero;
        phase = "settling";
        spawnSeenAt = gameNow;
    }

    private void TickSettling()
    {
        // CheckPoint marks itself final on its first Update, so the scan waits after the spawn
        if (gameNow - spawnSeenAt < 1.5f) return;
        driveStartReal = realNow;
        driveStartTime = gameNow;
        driveStarted = true;
        context = BuildContext();
        Scan();
        if (survey)
        {
            surveyBlock = BuildSurvey();
            Finish("survey", null);
            return;
        }
        foreach (int n in players)
        {
            var d = new Driven { N = n };
            var ch = HeroController.players[n].character;
            if (ch == null)
            {
                Finish("error", "player " + n + " has no character when driving starts");
                return;
            }
            d.LastChar = ch;
            d.LastCharObj = ch;
            d.Anchor = new Vector2(ch.X, ch.Y);
            d.AnchorAt = gameNow;
            d.SpawnedAt = gameNow;
            EnsureAgent(ch);
            NewRecord(d, ch, "start");
            driven.Add(d);
            if (livesAtStart > 0) HeroController.SetLives(n, livesAtStart);
            d.LastLives = HeroController.players[n].Lives;
            ScenarioLevelRun.Owned[n] = true;
        }
        startX = furthestX = driven[0].LastChar.X;
        startPos = new Vector2(startX, driven[0].LastChar.Y);
        lastFlagsActivated = CountFlagsActivated();
        lastFreed = CountFreed();
        phase = "driving";
        ScenarioLevelRun.Phase = "driving";
        ScenarioLevelRun.Log("driving players " + string.Join(",", players.Select(p => p.ToString()).ToArray()));
    }

    private void TickDriving()
    {
        if (!ReferenceEquals(HeroController.Instance, runHero) || !LevelSelectionController.CurrentlyInGame)
        {
            Finish("level-failed", "the level was left or reloaded before it finished");
            return;
        }
        if (LevelFinished()) return;

        float limit = durationSec > 0f ? durationSec : timeoutSec;
        if (Elapsed() >= limit)
        {
            Finish(durationSec > 0f ? "duration" : "timeout", null);
            return;
        }

        if (!coverageForced && (Elapsed() >= limit * 0.6f || (durationSec <= 0f && ExitNear()))) ForceCoverage();

        foreach (var d in driven) TickPlayer(d);
        TickHold();

        TrackFlagsAndRescues();
        if (gameNow >= nextEnemyScan) { nextEnemyScan = gameNow + 0.5f; ScanEnemies(); }
        if (!deathForced && forceDeathAt >= 0f && Elapsed() >= forceDeathAt) TryForceDeath();
        if (deathForced && !forcedDeathSeen && !gibFallback && gameNow - deathForcedAt > 1f) GibFallback();
    }

    private bool LevelFinished()
    {
        bool finished;
        try { finished = GameModeController.IsLevelFinished(); }
        catch { return false; }
        if (!finished) return false;
        LevelResult result = GameModeController.GetLevelResult();
        if (result == LevelResult.Success)
        {
            try { helicopterVictory = GameModeController.IsHelicopterVictory(); } catch { }
            if (helicopterVictory) RecordExercise("helicopter", "walk", null);
            HoldOutcome();
            Finish("finished", null);
        }
        else
        {
            Finish("level-failed", "level finished with " + result);
        }
        return true;
    }

    private static readonly FieldInfo WinTimerField = AccessTools.Field(typeof(GameModeController), "winTimer");

    private static void HoldOutcome()
    {
        if (WinTimerField == null) { ScenarioLevelRun.NoteError("no GameModeController.winTimer to hold the level's outcome"); return; }
        // The outcome of a won world-map level writes the save: the territory's start level, a finished campaign
        WinTimerField.SetValue(GameModeController.Instance, 999999f);
    }

    internal bool HoldsSave()
    {
        if (runHero == null) return phase != "done";
        var hero = HeroController.Instance;
        return hero != null && ReferenceEquals(hero, runHero);
    }

    private void TickPlayer(Driven d)
    {
        bool[] want = ScenarioLevelRun.Desired[d.N];
        Array.Clear(want, 0, 10);
        var player = HeroController.players[d.N];
        TestVanDammeAnim bro = player == null ? null : player.character;
        TrackCharacter(d, player, bro);

        // A piloting bro is disabled and the mech reads the player's input
        TestVanDammeAnim mech = bro == null || bro.health <= 0 ? null : bro.pilottedUnit as TestVanDammeAnim;
        if (mech == null && (bro == null || bro.health <= 0 || !bro.enabled || bro.isOnHelicopter))
        {
            if (bro != null && !bro.enabled && d.TunnelStart < 0f && IsTransported(bro)) d.TunnelStart = gameNow;
            ApplyPulses(d, want);
            return;
        }
        TestVanDammeAnim body = mech ?? bro;
        if (d.TunnelStart >= 0f)
        {
            Dictionary<string, object> ride;
            if (exercised.TryGetValue("wormTunnel", out ride)) ride["rideSeconds"] = gameNow - d.TunnelStart;
            else RecordExercise("wormTunnel", "walk", new Dictionary<string, object> { { "rideSeconds", gameNow - d.TunnelStart } });
            d.TunnelStart = -1f;
        }

        if (d == driven[0])
        {
            furthestX = Mathf.Max(furthestX, body.X);
            TrackProgress(body);
        }
        var rec = d.Record;
        if (rec != null && !rec.Ended && ReferenceEquals(bro, rec.Char)) TrackKit(rec, bro);

        ReadMechanicStates(d, bro);

        if (!ScenarioLevelRun.InputAllowed(player))
        {
            d.Anchor = new Vector2(body.X, body.Y);
            d.AnchorAt = gameNow;
            return;
        }
        if (mech != null) EnsureAgent(mech);

        Vector2 goal = Goal(body, d == driven[0]);
        int dir = Mathf.Abs(goal.x - body.X) < 6f ? 0 : (goal.x > body.X ? 1 : -1);

        if (!float.IsNaN(d.LoopX) && Mathf.Abs(body.X - d.LoopX) < 48f)
        {
            float loopX = d.LoopX;
            d.LoopX = float.NaN;
            d.LastDeathX = float.NaN;
            d.DeathRepeats = 0;
            Teleport(d, body, Map.GetCollumn(loopX), goal.x >= loopX ? 1 : -1, 16, d.LoopStuckIndex);
            ApplyPulses(d, want);
            return;
        }

        if (!StuckStep(d, body, goal, dir, want))
        {
            Move(d, body, goal, dir, want);
            UseMechanicOnArrival(d, body, want);
        }
        Combat(d, body, want);
        if (hold != null && hold.Player == d.N && hold.Rec == d.Record) DriveHold(d, bro, want);
        ApplyPulses(d, want);
        // Fire cancels a running special for some custom bros, refunding its ammo
        if (want[Special] || (rec != null && !rec.Ended && rec.Special.On)) want[Fire] = false;
        CountActions(d, want);
    }

    private void TrackCharacter(Driven d, Player player, TestVanDammeAnim bro)
    {
        // A destroyed character compares equal to null but keeps its reference, so the change is tested on the live one.
        object live = bro == null ? null : (object)bro;
        int lives = player == null ? 0 : player.Lives;
        bool livesLost = lives < d.LastLives;
        d.LastLives = lives;
        if (!d.DeathRecorded && d.LastCharObj != null
            && ((live != null && (bro.health <= 0 || bro.actionState == ActionState.Dead)) || live == null || livesLost))
        {
            d.DeathRecorded = true;
            d.DeathAt = gameNow;
            EndRecord(d, "died");
            d.ForcedPending = deathForced && !forcedDeathSeen && d == driven[0];
            if (d.ForcedPending) forcedDeathSeen = true;
            else
            {
                naturalDeaths++;
                NoteNaturalDeath(d, live != null ? bro : d.LastChar);
            }
            string how = live == null ? "character destroyed" : (bro.health <= 0 || bro.actionState == ActionState.Dead ? bro.GetType().Name + " died" : "a life was lost");
            AddEvent("death", "player " + d.N + " " + how + (d.ForcedPending ? " (forced)" : "") + ", lives " + lives);
        }
        if (ReferenceEquals(live, d.LastCharObj)) return;
        if (live == null)
        {
            d.LastCharObj = null;
            d.LastChar = null;
            return;
        }
        if (!player.IsAliveAndSpawnedHero()) return;

        if (d.DeathRecorded)
        {
            float delay = gameNow - d.DeathAt;
            if (d.ForcedPending)
            {
                forcedRespawnSeen = true;
                d.ForcedPending = false;
                deathDetail = "forced death at " + Mathf.Round((d.DeathAt - driveStartTime) * 10f) / 10f + " s, respawned as " + bro.GetType().Name
                    + " after " + Mathf.Round(delay * 10f) / 10f + " s, lives " + forcedLivesBefore + " -> " + lives
                    + (lives < forcedLivesBefore ? " (a life lost)" : " (no life lost)");
            }
            AddEvent("respawn", "player " + d.N + " as " + bro.GetType().Name + " after " + Mathf.Round(delay * 10f) / 10f + " s");
        }
        else
        {
            swapped = true;
            actionsSinceSwap = 0;
            AddEvent("swap", "player " + d.N + " character changed without a death: " + (d.LastChar == null ? "none" : d.LastChar.GetType().Name)
                + " -> " + bro.GetType().Name + ", lives " + lives);
            EndRecord(d, "was swapped out for " + DisplayName(bro));
        }
        NewRecord(d, bro, d.DeathRecorded ? "respawn" : "swap");
        d.DeathRecorded = false;
        d.LastCharObj = bro;
        d.LastChar = bro;
        d.Anchor = new Vector2(bro.X, bro.Y);
        d.AnchorAt = gameNow;
        d.SpawnedAt = gameNow;
        EndStuck(d);
        d.PathCol = int.MinValue;
        EnsureAgent(bro);
    }

    private static readonly FieldInfo TransportedField = AccessTools.Field(typeof(AssMouthTransportWrapper), "transportedObject");

    private static bool IsTransported(TestVanDammeAnim bro)
    {
        FieldInfo f = TransportedField;
        foreach (var w in AssMouthTransportWrapper.wrappers)
        {
            if (w != null && f != null && ReferenceEquals(f.GetValue(w), bro)) return true;
        }
        return false;
    }

    private void EnsureAgent(TestVanDammeAnim bro)
    {
        if (bro == null || bro.GetComponent<PathAgent>() != null) return;
        var agent = bro.gameObject.AddComponent<PathAgent>();
        agent.agentSize = 9f;
        agent.capabilities = NewCapabilities();
        ScenarioLevelRun.AddedAgents.Add(agent);
    }

    private static PathAgentCapabilities NewCapabilities()
    {
        var caps = new PathAgentCapabilities();
        caps.canJump = true;
        caps.canWallClimb = true;
        caps.canUseLadders = true;
        caps.flying = false;
        caps.maxDropDistance = 8;
        caps.jumpHeight = 6;
        return caps;
    }

    private Vector2 Goal(TestVanDammeAnim bro, bool primary)
    {
        if (primary && mechTarget != null)
        {
            if (gameNow < mechTargetUntil && !mechTarget.Used) return mechTarget.Pos;
            GiveUpMechanic();
        }
        if (durationSec <= 0f)
        {
            Vector2 exit;
            if (HelicopterLadder(out exit)) return exit;
            var p = Portal();
            if (p != null) return p.transform.position;
        }
        if (primary && gameNow >= nextMechPick) PickMechanic(bro);
        if (primary && mechTarget != null) return mechTarget.Pos;

        CheckPoint final = FinalFlag();
        if (final != null)
        {
            if (!final.activated) return RouteTarget(new Vector2(final.X, final.Y));
            return Patrol(bro, new Vector2(final.X, final.Y), primary);
        }
        if (Map.checkPoints != null)
        {
            CheckPoint next = Map.GetNearestCheckPointToRight(bro.X, bro.Y, true);
            if (next != null) return RouteTarget(new Vector2(next.X, next.Y));
        }
        if (durationSec > 0f && hasRouteTarget) return Patrol(bro, lastRouteTarget, primary);
        return new Vector2(RightCol() * 16f, bro.Y);
    }

    private Vector2 RouteTarget(Vector2 p)
    {
        lastRouteTarget = p;
        hasRouteTarget = true;
        return p;
    }

    private Vector2 Patrol(TestVanDammeAnim bro, Vector2 anchor, bool primary)
    {
        if (!patrolling || (anchor - patrolAnchor).sqrMagnitude > 256f)
        {
            patrolling = true;
            patrolAnchor = anchor;
            patrolBack = startX <= anchor.x ? -1 : 1;
            patrolAway = true;
            patrolFlipAt = gameNow + PatrolLegSec;
            AddEvent("patrol", "no target ahead; pacing near " + Mathf.Round(anchor.x) + "," + Mathf.Round(anchor.y));
        }
        float legX = patrolAway ? patrolAnchor.x + patrolBack * PatrolSpanPx : patrolAnchor.x;
        if (primary && (Mathf.Abs(bro.X - legX) < 12f || gameNow >= patrolFlipAt))
        {
            patrolAway = !patrolAway;
            patrolFlipAt = gameNow + PatrolLegSec;
            legX = patrolAway ? patrolAnchor.x + patrolBack * PatrolSpanPx : patrolAnchor.x;
        }
        return new Vector2(Mathf.Clamp(legX, 16f, RightCol() * 16f), patrolAnchor.y);
    }

    private static int RightCol()
    {
        // A level loaded from a super checkpoint is shifted left by lastXLoadOffset, leaving that many empty columns on the right
        return Mathf.Max(1, Map.Width - Map.lastXLoadOffset - 2);
    }

    private static bool HelicopterLadder(out Vector2 pos)
    {
        var heli = Map.newestHelicopter;
        if (heli != null && heli.gameObject.activeInHierarchy && heli.ladderVictoryCollider != null && heli.ladderVictoryCollider.enabled)
        {
            Vector3 c = heli.ladderVictoryCollider.bounds.center;
            pos = new Vector2(c.x, c.y);
            return true;
        }
        pos = Vector2.zero;
        return false;
    }

    private HeroLevelExitPortal Portal()
    {
        if (gameNow >= nextPortalLook)
        {
            nextPortalLook = gameNow + 1f;
            portal = UnityEngine.Object.FindObjectOfType<HeroLevelExitPortal>();
        }
        return portal;
    }

    private bool ExitNear()
    {
        CheckPoint final = FinalFlag();
        if (final != null && final.activated) return true;
        Vector2 ladder;
        return HelicopterLadder(out ladder);
    }

    private CheckPoint FinalFlag()
    {
        if (Map.checkPoints == null || isFinalField == null) return null;
        foreach (var cp in Map.checkPoints)
        {
            if (cp != null && (bool)isFinalField.GetValue(cp)) return cp;
        }
        return null;
    }

    private void Move(Driven d, TestVanDammeAnim bro, Vector2 goal, int dir, bool[] want)
    {
        var agent = bro.GetComponent<PathAgent>();
        int col = bro.collumn, row = bro.row;
        int goalCol = Mathf.Clamp(Map.GetCollumn(goal.x), 1, RightCol()), goalRow = Map.GetRow(goal.y + 4f);
        int wpCol, wpRow;
        int span = 16 + d.WaypointBoost;
        if (Mathf.Abs(goalCol - col) <= span + 4) { wpCol = goalCol; wpRow = goalRow; }
        else
        {
            wpCol = Mathf.Clamp(col + dir * span, 1, RightCol());
            wpRow = StandableRow(wpCol, row);
        }

        if (agent != null)
        {
            bool waypointMoved = Mathf.Abs(wpCol - d.PathCol) > 4 || Mathf.Abs(wpRow - d.PathRow) > 3;
            PathPoint node = agent.CurrentNode;
            bool midManoeuvre = agent.CurrentPath != null && (!bro.IsOnGround() || (node != null && node.moveMode != PathMoveMode.Normal));
            if (gameNow >= d.NextPathAt && !midManoeuvre && (agent.CurrentPath == null || waypointMoved || gameNow - d.NextPathAt > 2f))
            {
                NavPath path = PathfindingController.FindPath(new GridPoint(col, row), new GridPoint(wpCol, wpRow), agent.capabilities, 10f);
                if (path != null && !OnMapFloor(path)) agent.CurrentPath = path;
                d.PathCol = wpCol;
                d.PathRow = wpRow;
                d.NextPathAt = gameNow + (agent.CurrentPath == null ? 0.25f : 0.5f);
            }
            if (agent.CurrentPath != null)
            {
                bool l = false, r = false, u = false, dn = false, j = false;
                agent.GetMove(ref l, ref r, ref u, ref dn, ref j);
                want[Left] = l; want[Right] = r; want[Up] = u; want[Down] = dn;
                if (j) Press(d, Jump, 10);
                if (agent.CurrentPath != null) return;
            }
        }
        Reactive(d, bro, goal, dir, want);
    }

    private static bool OnMapFloor(NavPath path)
    {
        // Map.IsBlockSolid reads out-of-bounds cells as solid, so A* can stand the bro on row 0 of a bottomless pit
        foreach (var p in path.points) if (p.row <= 0) return true;
        return false;
    }

    private static bool Floor(int c, int r)
    {
        return r >= 0 && Map.IsBlockSolid(c, r);
    }

    private static int StandableRow(int c, int row)
    {
        for (int i = 0; i <= 16; i++)
        {
            int r = row + ((i % 2 == 0) ? i / 2 : -(i + 1) / 2);
            if (r < 1 || r >= Map.Height - 1) continue;
            if (!Map.IsBlockSolid(c, r) && !Map.IsBlockSolid(c, r + 1) && (Map.IsBlockSolid(c, r - 1) || Map.IsBlockLadder(c, r - 1))) return r;
        }
        return row;
    }

    private void Reactive(Driven d, TestVanDammeAnim bro, Vector2 goal, int dir, bool[] want)
    {
        int col = bro.collumn, row = bro.row;
        if (dir < 0) want[Left] = true; else if (dir > 0) want[Right] = true;
        if (goal.y - bro.Y > 24f && (Map.IsBlockLadder(col, row) || Map.IsBlockLadder(col, row + 1))) want[Up] = true;
        if (dir == 0) return;
        bool wall = Map.IsBlockSolid(col + dir, row) || Map.IsBlockSolid(col + dir, row + 1);
        bool gap = !Floor(col + dir, row - 1) && !Floor(col + dir, row - 2) && !Floor(col + dir, row - 3);
        if (bro.IsOnGround() && (wall || gap)) Press(d, Jump, 12);
    }

    private bool StuckStep(Driven d, TestVanDammeAnim bro, Vector2 goal, int dir, bool[] want)
    {
        Vector2 pos = new Vector2(bro.X, bro.Y);
        bool busy = bro.actionState == ActionState.ClimbingLadder || bro.attachedToZipline != null
            || bro.IsParachuteActive || (d == driven[0] && mechArrivedAt >= 0f);
        bool moved = Mathf.Abs(pos.x - d.Anchor.x) > 16f || (bro.IsOnGround() && Mathf.Abs(pos.y - d.Anchor.y) > 24f);
        if (busy || moved)
        {
            if (d.StuckLevel > 0 && d.StuckLevel < StuckSteps.Length && !busy && d.StuckIndex >= 0)
            {
                ((Dictionary<string, object>)stuckEvents[d.StuckIndex])["recoveredBy"] = StuckSteps[d.StuckLevel - 1];
            }
            d.Anchor = pos;
            d.AnchorAt = gameNow;
            EndStuck(d);
            d.WaypointBoost = 0;
            return false;
        }
        if (d.StuckLevel == 0 && gameNow - d.AnchorAt < StuckWindowSec) return false;
        if (d.StuckLevel == 0 && gameNow - d.ResumeAt < 20f && Vector2.Distance(pos, d.StuckPos) < 48f)
        {
            d.StuckLevel = d.ResumeLevel;
            d.StuckIndex = d.ResumeIndex;
            if (d.StuckIndex >= 0)
            {
                var ev = (Dictionary<string, object>)stuckEvents[d.StuckIndex];
                ev["recoveredBy"] = null;
                ev["repeats"] = (int)ev["repeats"] + 1;
            }
            d.StepUntil = 0f;
        }
        if (d.StuckLevel == 0 || gameNow >= d.StepUntil)
        {
            bool opening = d.StuckLevel == 0;
            if (d.StuckLevel >= StuckSteps.Length) d.StuckLevel = 0;
            d.StuckLevel++;
            d.StepStart = gameNow;
            d.StepUntil = gameNow + StepSec;
            if (opening)
            {
                d.StuckPos = pos;
                var ev = new Dictionary<string, object>
                {
                    { "t", T() }, { "player", d.N }, { "x", Mathf.Round(bro.X) }, { "y", Mathf.Round(bro.Y) }, { "recoveredBy", null }, { "repeats", 0 }
                };
                if (stuckEvents.Count < MaxEvents) { stuckEvents.Add(ev); d.StuckIndex = stuckEvents.Count - 1; }
            }
            if (StuckSteps[d.StuckLevel - 1] == "repath-further") { d.WaypointBoost += 6; d.PathCol = int.MinValue; d.NextPathAt = 0f; }
            if (StuckSteps[d.StuckLevel - 1] == "teleport") { Teleport(d, bro, bro.collumn, dir == 0 ? 1 : dir, 10, d.StuckIndex); return true; }
        }
        string step = StuckSteps[d.StuckLevel - 1];
        int toward = dir == 0 ? 1 : dir;
        if (step == "repath-further") return false;
        if (step == "jump") { Hold(want, toward); Press(d, Jump, 15); }
        else if (step == "wall-climb") { Hold(want, toward); want[Jump] = true; }
        else if (step == "reverse") Hold(want, gameNow - d.StepStart < 0.6f ? -toward : toward);
        else if (step == "dig")
        {
            want[Down] = true;
            want[Fire] = true;
            if (gameNow - d.StepStart > 0.8f) Press(d, Special, 3);
        }
        return true;
    }

    private void EndStuck(Driven d)
    {
        if (d.StuckLevel > 0)
        {
            d.ResumeLevel = d.StuckLevel;
            d.ResumeIndex = d.StuckIndex;
            d.ResumeAt = gameNow;
        }
        d.StuckLevel = 0;
        d.StuckIndex = -1;
    }

    private void NoteNaturalDeath(Driven d, TestVanDammeAnim dead)
    {
        if (ReferenceEquals(dead, null)) return;
        float x = dead.X;
        d.DeathRepeats = !float.IsNaN(d.LastDeathX) && Mathf.Abs(x - d.LastDeathX) < 48f ? d.DeathRepeats + 1 : 1;
        d.LastDeathX = x;
        if (d.DeathRepeats < 2 || !float.IsNaN(d.LoopX)) return;
        d.LoopX = x;
        d.LoopStuckIndex = -1;
        var ev = new Dictionary<string, object>
        {
            { "t", T() }, { "player", d.N }, { "x", Mathf.Round(x) }, { "y", Mathf.Round(dead.Y) }, { "cause", "died twice at this x" }, { "recoveredBy", null }
        };
        if (stuckEvents.Count < MaxEvents) { stuckEvents.Add(ev); d.LoopStuckIndex = stuckEvents.Count - 1; }
    }

    private void Teleport(Driven d, TestVanDammeAnim bro, int fromCol, int toward, int span, int stuckIndex)
    {
        for (int i = 2; i <= span; i++)
        {
            int c = fromCol + toward * i;
            if (c < 1 || c > RightCol()) break;
            int r = StandableRow(c, bro.row);
            if (Map.IsBlockSolid(c, r) || !Floor(c, r - 1)) continue;
            float x = c * 16f, y = r * 16f - 8f;
            bro.transform.position = new Vector3(x, y, bro.transform.position.z);
            bro.X = x;
            bro.Y = y;
            bro.xI = 0f;
            bro.yI = 0f;
            assisted = true;
            if (stuckIndex >= 0) ((Dictionary<string, object>)stuckEvents[stuckIndex])["recoveredBy"] = "teleport";
            AddEvent("teleport", "player " + d.N + " to " + Mathf.Round(x) + "," + Mathf.Round(y));
            d.Anchor = new Vector2(x, y);
            d.AnchorAt = gameNow;
            d.StuckLevel = 0;
            d.StuckIndex = -1;
            d.ResumeAt = -100f;
            d.PathCol = int.MinValue;
            return;
        }
        AddEvent("teleport-failed", "player " + d.N + ": no standable column ahead");
    }

    private static void Hold(bool[] want, int dir)
    {
        want[Left] = dir < 0;
        want[Right] = dir > 0;
    }

    private void Combat(Driven d, TestVanDammeAnim bro, bool[] want)
    {
        int facing = bro.transform.localScale.x < 0f ? -1 : 1;
        int n = bro.playerNum;
        if (d.TurnFrames > 0)
        {
            d.TurnFrames--;
            Hold(want, d.TurnDir);
            want[Fire] = true;
            return;
        }
        if (Map.IsEnemyUnitNearby(n, bro.X, bro.Y, facing, 128f, 16f, false, true)) want[Fire] = true;
        else if (Map.IsEnemyUnitNearby(n, bro.X, bro.Y, -facing, 64f, 16f, false, true)) { d.TurnFrames = 4; d.TurnDir = -facing; }
        if (Map.IsEnemyUnitNearby(n, bro.X, bro.Y, 20f, 16f, false)) Press(d, Melee, 3);
        if (bro.SpecialAmmo > 0 && gameNow - d.LastSpecialAt > 4f && Map.IsEnemyUnitNearby(n, bro.X, bro.Y, 128f, 32f, false))
        {
            Press(d, Special, 3);
            d.LastSpecialAt = gameNow;
        }
    }

    private static void Press(Driven d, int action, int frames)
    {
        if (d.PressFrames[action] > 0 || d.ReleaseFrames[action] > 0) return;
        d.PressFrames[action] = frames;
    }

    private static void ApplyPulses(Driven d, bool[] want)
    {
        for (int a = 0; a < 10; a++)
        {
            if (d.PressFrames[a] > 0)
            {
                want[a] = true;
                if (--d.PressFrames[a] == 0) d.ReleaseFrames[a] = 2;
            }
            else if (d.ReleaseFrames[a] > 0)
            {
                want[a] = false;
                d.ReleaseFrames[a]--;
            }
        }
    }

    private void CountActions(Driven d, bool[] want)
    {
        for (int i = 0; i < ActionIndex.Length; i++)
        {
            int a = ActionIndex[i];
            if (want[a] && !d.Prev[a])
            {
                actionCounts[i]++;
                actionsSinceSwap++;
                if (d.Record != null && !d.Record.Ended) d.Record.Presses[i]++;
            }
        }
        Array.Copy(want, d.Prev, 10);
    }

    private void NewRecord(Driven d, TestVanDammeAnim bro, string how)
    {
        var rec = new CharRecord
        {
            Index = characters.Count, Player = d.N, Name = DisplayName(bro), Type = bro.GetType().Name, How = how, Char = bro,
            StartT = T(), Ability = SpecialAbility(bro)
        };
        characters.Add(rec);
        d.Record = rec;
        ScenarioLevelRun.PatchKit(bro, rec.Ability);
    }

    private void EndRecord(Driven d, string how)
    {
        var rec = d.Record;
        if (rec == null || rec.Ended) return;
        rec.Ended = true;
        rec.EndT = T();
        rec.EndedBy = how;
    }

    private static string DisplayName(TestVanDammeAnim bro)
    {
        try
        {
            foreach (var itf in bro.GetType().GetInterfaces())
            {
                if (itf.Name != "ICustomHero") continue;
                PropertyInfo infoProp = itf.GetProperty("Info");
                object info = infoProp == null ? null : infoProp.GetValue(bro, null);
                if (info == null) break;
                FieldInfo f = info.GetType().GetField("name", BindingFlags.Public | BindingFlags.Instance);
                PropertyInfo p = f == null ? info.GetType().GetProperty("name", BindingFlags.Public | BindingFlags.Instance) : null;
                string n = (f != null ? f.GetValue(info) : p != null ? p.GetValue(info, null) : null) as string;
                if (!string.IsNullOrEmpty(n)) return n;
            }
        }
        catch (Exception e)
        {
            ScenarioLevelRun.NoteError("reading a custom bro's name: " + e.Message);
        }
        return bro.heroType.ToString();
    }

    private CharRecord KitRecord(object instance, bool ability)
    {
        if (phase != "driving") return null;
        foreach (var d in driven)
        {
            var rec = d.Record;
            if (rec != null && !rec.Ended && (ReferenceEquals(instance, rec.Char) || (ability && rec.Ability != null && ReferenceEquals(instance, rec.Ability))))
                return rec;
        }
        return null;
    }

    public void OnKitCall(object instance, bool special)
    {
        var rec = KitRecord(instance, special);
        if (rec == null) return;
        if (special) rec.Special.Signal(Time.frameCount, gameNow);
        else rec.Melee.Signal(CallSignal, Time.frameCount, gameNow);
    }

    public void OnSpecialPress(TestVanDammeAnim bro)
    {
        var rec = KitRecord(bro, false);
        if (rec != null) rec.Special.Press(Time.frameCount, gameNow);
    }

    public void OnAmmoSpent(TestVanDammeAnim bro, int spent)
    {
        var rec = KitRecord(bro, false);
        if (rec == null) return;
        rec.AmmoSpent += spent;
        rec.Special.Signal(Time.frameCount, gameNow);
    }

    private static object SpecialAbility(TestVanDammeAnim bro)
    {
        foreach (var itf in bro.GetType().GetInterfaces())
        {
            if (itf.Name != "IAbilityOwner") continue;
            PropertyInfo p = itf.GetProperty("SpecialAbility");
            return p == null ? null : p.GetValue(bro, null);
        }
        return null;
    }

    private void TrackKit(CharRecord rec, TestVanDammeAnim bro)
    {
        int frame = Time.frameCount;
        object ability = SpecialAbility(bro);
        if (!ReferenceEquals(ability, rec.Ability))
        {
            rec.Ability = ability;
            ScenarioLevelRun.PatchKit(bro, ability);
        }
        rec.Special.Track(UsingSpecialField != null && (bool)UsingSpecialField.GetValue(bro), bro.special, frame, gameNow);
        bool melee = DoingMeleeField != null && (bool)DoingMeleeField.GetValue(bro);
        if (melee && !rec.Melee.On) rec.Melee.Signal(StateSignal, frame, gameNow);
        rec.Melee.Track(melee, frame, gameNow);
    }

    public string StartHold(string check, int player, string bro, float seconds)
    {
        var h = new KitHold { Check = check, Bro = bro, Player = player, Seconds = seconds, StartReal = realNow };
        holds.Add(h);
        if (phase != "driving") return EndHold(h, "refused", "the run was " + phase + ", not driving, when the hold was asked for");
        Driven d = driven.FirstOrDefault(x => x.N == player);
        if (d == null) return EndHold(h, "refused", "player " + player + " is not driven by this run");
        if (hold != null) return EndHold(h, "refused", "the hold for " + hold.Check + " was still running");
        CharRecord rec = LiveRecord(d);
        if (rec == null) return EndHold(h, "refused", "player " + player + " has no live character the run has seen yet");
        if (!string.Equals(rec.Name, bro, StringComparison.OrdinalIgnoreCase))
            return EndHold(h, "wrong-bro", "player " + player + " is " + rec.Name + " (character " + rec.Index + "), not " + bro);
        h.Rec = rec;
        hold = h;
        AddEvent("kit-hold", h.Check + ": holding player " + player + " on " + bro + " (character " + h.Rec.Index + ") for up to " + seconds + " s");
        return ScenarioLevelRun.HoldStatus = "holding " + bro + " (character " + h.Rec.Index + ") for " + h.Check;
    }

    private static CharRecord LiveRecord(Driven d)
    {
        var p = HeroController.players[d.N];
        var live = p == null ? null : p.character;
        if (d.Record == null || d.Record.Ended || live == null || !ReferenceEquals(live, d.Record.Char)) return null;
        return d.Record;
    }

    public string LiveBro(int player)
    {
        Driven d = driven.FirstOrDefault(x => x.N == player);
        CharRecord rec = d == null ? null : LiveRecord(d);
        return rec == null ? null : rec.Name;
    }

    public string HoldRescues(int player)
    {
        if (phase != "driving") return "refused: the run was " + phase + ", not driving";
        if (!driven.Any(x => x.N == player)) return "refused: player " + player + " is not driven by this run";
        rescuesHeld[player] = true;
        rescueBlocked[player] = false;
        AddEvent("rescue-hold", "rescues held for player " + player + " until its next kit hold ends");
        return "rescues held for player " + player;
    }

    public void ReleaseRescues()
    {
        Array.Clear(rescuesHeld, 0, rescuesHeld.Length);
    }

    public bool HoldsRescue(int playerNum, float x, float y, float range)
    {
        if (hold != null && hold.Player == playerNum)
        {
            if (RescueDue(x, y, range)) hold.RescueHeld = true;
            return true;
        }
        if (playerNum < 0 || playerNum >= rescuesHeld.Length || !rescuesHeld[playerNum]) return false;
        if (!rescueBlocked[playerNum] && RescueDue(x, y, range))
        {
            rescueBlocked[playerNum] = true;
            AddEvent("rescue-hold", "player " + playerNum + "'s rescue held off ahead of its kit hold");
        }
        return true;
    }

    private static bool RescueDue(float x, float y, float range)
    {
        var hc = HeroController.Instance;
        if (hc == null || hc.rescueBros == null) return false;
        return hc.rescueBros.Any(rb => rb != null && rb.gameObject.activeSelf && rb.freed && Tools.FastAbsWithinRange(rb.X - x, range)
            && Tools.FastAbsWithinRange(rb.Y - y, range) && rb.rescueState == RescueBro.RescueState.Idle);
    }

    private static bool KitDone(CharRecord r)
    {
        return r.Presses[FireSlot] > 0 && r.Special.Runs > 0 && r.Melee.Runs > 0;
    }

    private void TickHold()
    {
        if (hold == null) return;
        var r = hold.Rec;
        if (KitDone(r)) EndHold(hold, "ran", null);
        else if (r.Ended) EndHold(hold, "changed", null);
        else if (realNow - hold.StartReal >= hold.Seconds) EndHold(hold, "timeout", null);
    }

    private void DriveHold(Driven d, TestVanDammeAnim bro, bool[] want)
    {
        var r = hold.Rec;
        float now = realNow;
        bool inSpecial = r.Special.On;
        if (r.Special.Runs == 0 && r.Presses[FireSlot] > 0 && r.Melee.Runs > 0)
        {
            // Some custom bros arm their special with one press and fire it with the next: fire disarms it and a melee blocks the press
            want[Fire] = false;
            d.PressFrames[Melee] = 0;
        }
        if (r.Presses[FireSlot] == 0 && now - hold.LastForced[FireSlot] > 0.5f) Force(d, FireSlot, Fire, now);
        // The game ignores a melee press while a special is running
        if (r.Melee.Runs == 0 && !inSpecial && now - hold.LastForced[MeleeSlot] > 0.6f) Force(d, MeleeSlot, Melee, now);
        // It ignores a special press while a melee runs too, reading it as a new press on every frame it is held
        if (r.Special.Runs == 0 && !inSpecial && !r.Melee.On && now - hold.LastForced[SpecialSlot] > 1.2f && (r.Melee.Runs > 0 || hold.Forced[MeleeSlot] >= 2))
        {
            if (bro.SpecialAmmo <= 0 && !hold.AmmoToppedUp)
            {
                bro.SpecialAmmo = 1;
                hold.AmmoToppedUp = true;
            }
            Force(d, SpecialSlot, Special, now);
            d.LastSpecialAt = gameNow;
        }
    }

    private void Force(Driven d, int slot, int action, float now)
    {
        if (d.PressFrames[action] > 0 || d.ReleaseFrames[action] > 0) return;
        Press(d, action, 3);
        hold.Forced[slot]++;
        hold.LastForced[slot] = now;
    }

    private string EndHold(KitHold h, string result, string detail)
    {
        h.Result = result;
        h.EndReal = realNow;
        h.Detail = detail ?? HoldDetail(h);
        if (hold == h) hold = null;
        if (h.Player >= 0 && h.Player < rescuesHeld.Length) rescuesHeld[h.Player] = false;
        AddEvent("kit-hold", h.Check + ": " + result);
        return ScenarioLevelRun.HoldStatus = "ended: " + h.Check + (result == "ran" ? " passed: " : " failed: ") + h.Detail;
    }

    private string HoldDetail(KitHold h)
    {
        var r = h.Rec;
        string who = h.Bro + " (character " + r.Index + ", " + r.Type + ")";
        string held = Mathf.Round((h.EndReal - h.StartReal) * 10f) / 10f + " s";
        string kit = "special ran " + r.Special.Runs + " (" + h.Forced[SpecialSlot] + " forced presses" + (h.AmmoToppedUp ? ", special ammo topped up to 1" : "")
            + "), melee ran " + r.Melee.Runs + " (" + h.Forced[MeleeSlot] + " forced presses), fire presses " + r.Presses[FireSlot]
            + " (" + h.Forced[FireSlot] + " forced)" + (h.RescueHeld ? "; a rescue was held off" : "");
        var missing = new List<string>();
        if (r.Special.Runs == 0) missing.Add("no special run (no special press led to a UseSpecial that did not flash the ammo bar or to special ammo spent)");
        if (r.Melee.Runs == 0) missing.Add("no melee run");
        if (r.Presses[FireSlot] == 0) missing.Add("no fire press");
        string gaps = string.Join(" and ", missing.ToArray());
        if (h.Result == "ran") return who + " had fire pressed and ran its special and melee within " + held + ": " + kit;
        if (h.Result == "timeout") return who + ": the hold ran out after " + held + " with " + gaps + "; " + kit;
        if (h.Result == "changed") return who + " " + r.EndedBy + " " + held + " into the hold, with " + gaps + "; " + kit;
        return who + ": the run ended (" + outcome + ") " + held + " into the hold, with " + gaps + "; " + kit;
    }

    private Dictionary<string, object> RecordJson(CharRecord r)
    {
        var presses = new Dictionary<string, object>();
        for (int i = 0; i < ActionNames.Length; i++) presses[ActionNames[i]] = r.Presses[i];
        return new Dictionary<string, object>
        {
            { "index", r.Index }, { "player", r.Player }, { "name", r.Name }, { "type", r.Type }, { "how", r.How }, { "t", r.StartT },
            { "endedAt", r.Ended ? (object)r.EndT : null }, { "endedBy", r.EndedBy }, { "presses", presses },
            { "specialRan", r.Special.Runs }, { "meleeRan", r.Melee.Runs }, { "specialAmmoSpent", r.AmmoSpent }
        };
    }

    private void ForceCoverage()
    {
        coverageForced = true;
        foreach (var d in driven)
        {
            for (int i = 0; i < ActionIndex.Length; i++)
            {
                if (actionCounts[i] > 0) continue;
                actionForced[i] = true;
                Press(d, ActionIndex[i], ActionIndex[i] == Jump ? 10 : 3);
            }
        }
    }

    private void ScanEnemies()
    {
        var bro = driven[0].LastChar;
        if (bro != null && bro.health > 0)
        {
            var units = Map.GetUnitsInRange(200, bro.X, bro.Y, false);
            if (units != null)
            {
                foreach (var u in units.ToArray())
                {
                    if (Hostile(u, driven[0].N) && u.health > 0) seenEnemies[u.GetInstanceID()] = u;
                }
            }
        }
        foreach (var kv in seenEnemies)
        {
            if (killedEnemies.Contains(kv.Key) || despawnedEnemies.Contains(kv.Key)) continue;
            if (kv.Value == null) despawnedEnemies.Add(kv.Key);
            else if (kv.Value.health <= 0) killedEnemies.Add(kv.Key);
        }
    }

    private static bool Hostile(Unit u, int playerNum)
    {
        // IsEnemy is only "not a hero and not a rescue bro", which villagers, animals and empty mechs pass
        if (u == null || !u.IsEnemy || u is Animal) return false;
        if (!GameModeController.DoesPlayerNumDamage(playerNum, u.playerNum)) return false;
        var mech = u as MookArmouredGuy;
        return mech == null || mech.pilotUnit != null;
    }

    private void TryForceDeath()
    {
        var d = driven[0];
        var player = HeroController.players[d.N];
        var bro = player == null ? null : player.character;
        if (bro != null && bro.pilottedUnit != null)
        {
            // The mech's special ejects its pilot
            Press(d, Special, 3);
            return;
        }
        // Damage on a bro that has just respawned does not kill it.
        if (bro == null || !player.IsAliveAndSpawnedHero() || bro.IsParachuteActive || !bro.enabled || gameNow - d.SpawnedAt < 1.5f) return;
        // A natural death earlier may have left one life, and a death with none left reloads the level.
        if (livesAtStart > 0 && player.Lives < livesAtStart) HeroController.SetLives(d.N, livesAtStart);
        forcedLivesBefore = player.Lives;
        d.LastLives = forcedLivesBefore;
        deathForced = true;
        deathForcedAt = gameNow;
        AddEvent("force-death", "player " + d.N + " lives " + player.Lives + ", Damage(9999, Bullet)");
        bro.Damage(9999, DamageType.Bullet, 0f, 0f, 0, bro, bro.X, bro.Y);
    }

    private void GibFallback()
    {
        gibFallback = true;
        var player = HeroController.players[driven[0].N];
        var bro = player == null ? null : player.character;
        if (bro == null || bro.health <= 0) return;
        AddEvent("force-death", "Damage did not kill after 1 s; GibNow(OutOfBounds)");
        bro.GibNow(DamageType.OutOfBounds, 0f, 0f);
    }

    private void Scan()
    {
        try { ScanGrid(); } catch (Exception e) { ScenarioLevelRun.NoteError("grid scan: " + e.Message); }
        try { ScanRegistries(); } catch (Exception e) { ScenarioLevelRun.NoteError("registry scan: " + e.Message); }
        try { ScanDoodads(); } catch (Exception e) { ScenarioLevelRun.NoteError("doodad scan: " + e.Message); }
        if (tunnelReps.Count > 0 && !found.ContainsKey("wormTunnel")) found["wormTunnel"] = tunnelReps.Count;
    }

    private void ScanGrid()
    {
        // A level loaded from a super checkpoint is shifted by the load offsets, and the cells past them have no block data
        int w = Mathf.Min(Map.Width - Map.lastXLoadOffset, Map.blocks.GetLength(0)), h = Mathf.Min(Map.Height - Map.lastYLoadOffset, Map.blocks.GetLength(1));
        var ladder = new bool[w, h];
        var quick = new bool[w, h];
        var bouncy = new bool[w, h];
        var tunnel = new bool[w, h];
        var crate = new bool[w, h];
        for (int c = 0; c < w; c++)
        {
            for (int r = 0; r < h; r++)
            {
                ladder[c, r] = Map.IsBlockLadder(c, r);
                quick[c, r] = Map.IsBlockQuicksand(c, r);
                Block b = Map.blocks[c, r];
                if (b == null || b.destroyed) continue;
                bouncy[c, r] = b.IsBouncy;
                tunnel[c, r] = b.groundType == GroundType.AssMouth || b.groundType == GroundType.CityAssMouth;
                crate[c, r] = b.groundType == GroundType.AmmoCrate;
            }
        }
        AddComponents("ladder", ladder);
        AddComponents("quicksand", quick);
        AddComponents("bouncy", bouncy);
        AddComponents("pickup", crate, false);
        tunnelReps.Clear();
        Components(tunnel, tunnelReps);
    }

    private void AddComponents(string kind, bool[,] grid, bool drivable = true)
    {
        var reps = new List<Vector2>();
        int count = Components(grid, reps);
        if (count == 0) return;
        Count(kind, count);
        foreach (var p in reps) mechs.Add(new Mech { Kind = kind, Pos = p, Drivable = drivable });
    }

    private static int Components(bool[,] grid, List<Vector2> reps)
    {
        int w = grid.GetLength(0), h = grid.GetLength(1), count = 0;
        var seen = new bool[w, h];
        var stack = new Stack<int>();
        for (int c = 0; c < w; c++)
        {
            for (int r = 0; r < h; r++)
            {
                if (!grid[c, r] || seen[c, r]) continue;
                count++;
                int lowC = c, lowR = r;
                seen[c, r] = true;
                stack.Push(c * h + r);
                while (stack.Count > 0)
                {
                    int v = stack.Pop(), cc = v / h, rr = v % h;
                    if (rr < lowR) { lowR = rr; lowC = cc; }
                    int[] nc = { cc + 1, cc - 1, cc, cc };
                    int[] nr = { rr, rr, rr + 1, rr - 1 };
                    for (int k = 0; k < 4; k++)
                    {
                        if (nc[k] < 0 || nr[k] < 0 || nc[k] >= w || nr[k] >= h || seen[nc[k], nr[k]] || !grid[nc[k], nr[k]]) continue;
                        seen[nc[k], nr[k]] = true;
                        stack.Push(nc[k] * h + nr[k]);
                    }
                }
                if (reps != null) reps.Add(new Vector2(lowC * 16f, lowR * 16f));
            }
        }
        return count;
    }

    private void ScanRegistries()
    {
        AddObjects("switch", Map.switches == null ? null : Map.switches.Cast<Component>().Where(sw => !IsMechSwitch(sw)));
        AddObjects("teleportDoor", Map.teleportDoors == null ? null : Map.teleportDoors.Cast<Component>());
        AddObjects("cage", Map.cages == null ? null : Map.cages.Cast<Component>());
        AddObjects("zipline", UnityEngine.Object.FindObjectsOfType<ZipLine>().Cast<Component>());
        AddObjects("elevator", UnityEngine.Object.FindObjectsOfType<Elevator>().Cast<Component>());
        AddObjects("door", UnityEngine.Object.FindObjectsOfType<DoorDoodad>().Cast<Component>());
        AddObjects("hatch", UnityEngine.Object.FindObjectsOfType<HatchDoodad>().Cast<Component>());
        AddObjects("wormTunnel", UnityEngine.Object.FindObjectsOfType<AssMouthOrifice>().Cast<Component>());
        AddObjects("mech", UnityEngine.Object.FindObjectsOfType<MookArmouredGuy>().Cast<Component>());
        AddObjects("pickup", UnityEngine.Object.FindObjectsOfType<Pickupable>().Cast<Component>());
        int worms = UnityEngine.Object.FindObjectsOfType<AlienSandWorm>().Length;
        if (worms > 0) Count("sandworm", worms);
        flagsTotal = Map.checkPoints == null ? 0 : Map.checkPoints.Count(cp => cp != null);
        if (flagsTotal > 0) Count("checkpoint", flagsTotal);
        if (Map.newestHelicopter != null) Count("helicopter", 1);
    }

    private static bool IsMechSwitch(object instance)
    {
        var c = instance as Component;
        return c != null && c.GetComponentInParent<MookArmouredGuy>() != null;
    }

    private void AddObjects(string kind, IEnumerable<Component> objects)
    {
        if (objects == null) return;
        int n = 0;
        foreach (var o in objects)
        {
            if (o == null) continue;
            n++;
            mechs.Add(new Mech { Kind = kind, Pos = o.transform.position, Target = o });
        }
        if (n > 0) Count(kind, n);
    }

    private void Count(string kind, int n)
    {
        int have;
        found.TryGetValue(kind, out have);
        found[kind] = have + n;
    }

    private void ScanDoodads()
    {
        if (Map.MapData == null || Map.MapData.DoodadList == null) return;
        foreach (var info in Map.MapData.DoodadList)
        {
            string type = info.type.ToString();
            if (IgnoredDoodads.Contains(type) || DoodadKinds.ContainsKey(type)) continue;
            int have;
            unknownDoodads.TryGetValue(type, out have);
            unknownDoodads[type] = have + 1;
        }
        foreach (var info in Map.MapData.DoodadList)
        {
            string type = info.type.ToString(), kind;
            if (!DoodadKinds.TryGetValue(type, out kind) || found.ContainsKey(kind)) continue;
            int have;
            unplacedDoodads.TryGetValue(type, out have);
            unplacedDoodads[type] = have + 1;
        }
    }

    private bool Unplaced(string kind)
    {
        foreach (var type in unplacedDoodads.Keys) if (DoodadKinds[type] == kind) return true;
        return false;
    }

    private bool IsDriven(object o)
    {
        var bro = o as TestVanDammeAnim;
        if (bro == null) return false;
        foreach (var d in driven)
        {
            if (ReferenceEquals(bro, d.LastCharObj)) return true;
        }
        return false;
    }

    private bool DrivenNear(object instance, float rx, float ry)
    {
        var comp = instance as Component;
        if (comp == null) return false;
        Vector3 p = comp.transform.position;
        foreach (var d in driven)
        {
            var b = d.LastChar;
            if (b != null && Mathf.Abs(b.X - p.x) <= rx && Mathf.Abs(b.Y - p.y) <= ry) return true;
        }
        return false;
    }

    public void OnMechanicCall(string kind, string method, object instance, object[] args)
    {
        if (phase != "driving" || directCall) return;
        if (kind == "switch" && IsMechSwitch(instance)) return;
        // An override that calls its base runs two patched methods on one call
        if (lastMechFrame == Time.frameCount && ReferenceEquals(lastMechInstance, instance) && lastMechKind == kind) return;
        lastMechFrame = Time.frameCount;
        lastMechInstance = instance;
        lastMechKind = kind;
        bool byDriven = false;
        if (args != null)
        {
            foreach (var a in args) if (IsDriven(a)) byDriven = true;
        }
        if (kind == "door" || kind == "hatch") byDriven = DrivenNear(instance, 64f, 48f);
        else if (kind == "elevator") byDriven = DrivenNear(instance, 48f, 48f);
        else if (kind == "bouncy") byDriven = DrivenNear(instance, 16f, 32f);
        if (!byDriven) return;
        if (kind == "wormTunnel" && method == "Expel") return;
        RecordExercise(kind, "walk", null);
        MarkUsed(kind, instance as Component);
    }

    private void ReadMechanicStates(Driven d, TestVanDammeAnim bro)
    {
        Edge(d, "ladder", bro.actionState == ActionState.ClimbingLadder);
        Edge(d, "ceilingHang", bro.actionState == ActionState.Hanging);
        Edge(d, "zipline", bro.attachedToZipline != null);
        Edge(d, "mech", bro.pilottedUnit != null);
        Edge(d, "quicksand", bro.IsInQuicksand());
        Edge(d, "helicopter", bro.isOnHelicopter);
    }

    private void Edge(Driven d, string kind, bool now)
    {
        bool before;
        d.StatePrev.TryGetValue(kind, out before);
        d.StatePrev[kind] = now;
        if (now && !before)
        {
            RecordExercise(kind, "walk", null);
            MarkUsedNear(kind, d.LastChar);
        }
    }

    private void TrackFlagsAndRescues()
    {
        int flags = CountFlagsActivated();
        if (flags > lastFlagsActivated) RecordExercise("checkpoint", "walk", null);
        lastFlagsActivated = flags;
        int freed = CountFreed();
        if (freed > lastFreed) { RecordExercise("cage", "walk", null); MarkUsedNear("cage", driven[0].LastChar); }
        lastFreed = freed;
    }

    private static int CountFlagsActivated()
    {
        return Map.checkPoints == null ? 0 : Map.checkPoints.Count(cp => cp != null && cp.activated);
    }

    private static int CountFreed()
    {
        var hc = HeroController.Instance;
        return hc == null || hc.rescueBros == null ? 0 : hc.rescueBros.Count(rb => rb != null && rb.freed);
    }

    private void RecordExercise(string kind, string via, Dictionary<string, object> extra)
    {
        Dictionary<string, object> entry;
        if (!exercised.TryGetValue(kind, out entry))
        {
            entry = new Dictionary<string, object> { { "count", 0 }, { "first", T() }, { "via", via } };
            exercised[kind] = entry;
            AddEvent("mechanic", kind + " via " + via);
        }
        entry["count"] = (int)entry["count"] + 1;
        if (extra != null) foreach (var kv in extra) entry[kv.Key] = kv.Value;
        if (mechTarget != null && mechTarget.Kind == kind)
        {
            mechTarget.Used = true;
            mechTarget = null;
            mechArrivedAt = -1f;
        }
    }

    private void MarkUsed(string kind, Component target)
    {
        foreach (var m in mechs) if (m.Kind == kind && target != null && ReferenceEquals(m.Target, target)) m.Used = true;
    }

    private void MarkUsedNear(string kind, TestVanDammeAnim bro)
    {
        if (bro == null) return;
        Mech best = null;
        float bestD = 64f;
        foreach (var m in mechs)
        {
            if (m.Kind != kind || m.Used) continue;
            float dist = Vector2.Distance(m.Pos, new Vector2(bro.X, bro.Y));
            if (dist < bestD) { bestD = dist; best = m; }
        }
        if (best != null) best.Used = true;
    }

    private void PickMechanic(TestVanDammeAnim bro)
    {
        nextMechPick = gameNow + 1f;
        Vector2 here = new Vector2(bro.X, bro.Y);
        CheckPoint final = FinalFlag();
        float dir = final != null && final.X < bro.X ? -1f : 1f;
        Mech best = null;
        float bestD = float.MaxValue;
        foreach (var m in mechs)
        {
            if (m.Attempted || m.Used || !m.Drivable || !DrivableKinds.Contains(m.Kind)) continue;
            if (!exerciseAll && exercised.ContainsKey(m.Kind)) continue;
            // A destroyed target compares equal to null but keeps its reference
            if (!ReferenceEquals(m.Target, null) && (m.Target == null || !m.Target.gameObject.activeInHierarchy)) continue;
            float ahead = (m.Pos.x - here.x) * dir;
            if (ahead < -32f || ahead > 240f || Mathf.Abs(m.Pos.y - here.y) > 160f) continue;
            float dist = Vector2.Distance(m.Pos, here);
            if (dist < bestD) { bestD = dist; best = m; }
        }
        if (best == null) return;
        mechTarget = best;
        best.Attempted = true;
        mechTargetUntil = gameNow + MechanicGiveUpSec;
        mechArrivedAt = -1f;
    }

    private void GiveUpMechanic()
    {
        var m = mechTarget;
        mechTarget = null;
        mechArrivedAt = -1f;
        if (m == null || m.Used) return;
        if (direct && TryDirect(m)) return;
        if (!exercised.ContainsKey(m.Kind))
        {
            missed.Add(new Dictionary<string, object>
            {
                { "kind", m.Kind }, { "at", new[] { Mathf.Round(m.Pos.x), Mathf.Round(m.Pos.y) } },
                { "attempted", true }, { "reason", "not used within " + MechanicGiveUpSec + " s of targeting it" }
            });
        }
    }

    private bool TryDirect(Mech m)
    {
        var bro = driven[0].LastChar;
        if (bro == null || m.Target == null) return false;
        directCall = true;
        try
        {
            if (m.Kind == "zipline") ((ZipLine)m.Target).AttachUnit(bro);
            else if (m.Kind == "elevator") ((Elevator)m.Target).GoUp();
            else if (m.Kind == "switch") ((Switch)m.Target).Activate(bro);
            else return false;
        }
        catch (Exception e)
        {
            ScenarioLevelRun.NoteError("direct " + m.Kind + ": " + e.Message);
            return false;
        }
        finally
        {
            directCall = false;
        }
        m.Used = true;
        RecordExercise(m.Kind, "direct", null);
        return true;
    }

    private void UseMechanicOnArrival(Driven d, TestVanDammeAnim bro, bool[] want)
    {
        if (d != driven[0] || mechTarget == null) return;
        var m = mechTarget;
        bool arrived = Mathf.Abs(m.Pos.x - bro.X) < 16f && Mathf.Abs(m.Pos.y - bro.Y) < 24f;
        if (!arrived && mechArrivedAt < 0f) return;
        if (mechArrivedAt < 0f) mechArrivedAt = gameNow;
        int face = m.Pos.x >= bro.X ? 1 : -1;
        switch (m.Kind)
        {
            case "ladder": want[Up] = true; break;
            case "switch":
            case "teleportDoor":
            case "mech":
            case "elevator": Press(d, Melee, 3); break;
            // A door or hatch opens only to melee; bullets break it.
            case "door":
            case "hatch": Hold(want, face); Press(d, Melee, 3); break;
            case "cage": Hold(want, face); want[Fire] = true; break;
            case "zipline":
            case "bouncy": Press(d, Jump, 12); break;
            case "quicksand":
                if (gameNow - mechArrivedAt > 1f) Press(d, Jump, 12);
                break;
            case "wormTunnel": Hold(want, face); break;
        }
    }

    private Dictionary<string, object> BuildContext()
    {
        var ctx = new Dictionary<string, object>();
        ctx["scene"] = SceneManager.GetActiveScene().name;
        try { ctx["campaign"] = LevelSelectionController.currentCampaign == null ? null : LevelSelectionController.currentCampaign.name; } catch { ctx["campaign"] = null; }
        try { ctx["levelIndex"] = LevelSelectionController.CurrentLevelNum; } catch { ctx["levelIndex"] = null; }
        ctx["levelName"] = Map.MapData == null ? null : Map.MapData.levelDescription;
        var list = new List<object>();
        foreach (int n in players)
        {
            var p = HeroController.players[n];
            list.Add(new Dictionary<string, object>
            {
                { "n", n }, { "bro", p == null || p.character == null ? null : p.character.GetType().Name }, { "lives", p == null ? 0 : p.Lives }
            });
        }
        ctx["players"] = list;
        return ctx;
    }

    private Dictionary<string, object> BuildSurvey()
    {
        var s = new Dictionary<string, object>();
        s["widthCells"] = Map.Width;
        s["heightCells"] = Map.Height;
        s["widthPx"] = Map.Width * 16;
        s["theme"] = Map.MapData == null ? null : Map.MapData.theme.ToString();
        s["onlyTriggersCanWinLevel"] = Map.MapData != null && Map.MapData.onlyTriggersCanWinLevel;
        int enemies = 0;
        if (Map.units != null) enemies = Map.units.Count(u => u != null && u.gameObject.activeInHierarchy && Hostile(u, players[0]) && u.health > 0);
        s["enemies"] = enemies;
        s["bosses"] = UnityEngine.Object.FindObjectsOfType<Boss>().Select(b => b.GetType().Name).Distinct().ToArray();
        s["checkpoints"] = flagsTotal;
        s["helicopter"] = Map.newestHelicopter != null;
        var bro = HeroController.players[players[0]] == null ? null : HeroController.players[players[0]].character;
        if (bro == null) { s["note"] = "no character to survey from"; return s; }
        s["spawn"] = new Dictionary<string, object> { { "x", Mathf.Round(bro.X) }, { "y", Mathf.Round(bro.Y) } };
        CheckPoint final = FinalFlag();
        s["finalFlag"] = final == null ? null : new Dictionary<string, object> { { "x", Mathf.Round(final.X) }, { "y", Mathf.Round(final.Y) } };
        if (final != null)
        {
            int goalCol = Map.GetCollumn(final.X), goalRow = Map.GetRow(final.Y + 4f);
            var path = PathfindingController.FindPath(new GridPoint(bro.collumn, bro.row), new GridPoint(goalCol, goalRow), NewCapabilities(), 1000f);
            // FindPath answers an unreachable goal, or one past its time limit, with the best partial path
            PathPoint end = path == null || path.points.Count == 0 ? null : path.points[path.points.Count - 1];
            s["pathToFinalFlag"] = end != null && end.collumn == goalCol && end.row == goalRow;
            s["pathNodes"] = path == null ? 0 : path.points.Count;
        }
        else
        {
            s["pathToFinalFlag"] = null;
        }
        return s;
    }

    private void AddEvent(string type, string detail)
    {
        if (events.Count < MaxEvents) events.Add(new Dictionary<string, object> { { "t", T() }, { "type", type }, { "detail", detail } });
    }

    private Dictionary<string, object> Check(string name, bool passed, string detail)
    {
        return new Dictionary<string, object> { { "name", name }, { "passed", passed }, { "detail", detail } };
    }

    private void Finish(string how, string detail)
    {
        if (phase == "done") return;
        phase = "done";
        outcome = how;
        ScenarioLevelRun.Outcome = how;
        outcomeDetail = detail;
        if (hold != null) EndHold(hold, KitDone(hold.Rec) ? "ran" : "run-ended", null);
        ReleaseRescues();
        for (int i = 0; i < 4; i++) { ScenarioLevelRun.Owned[i] = false; Array.Clear(ScenarioLevelRun.Desired[i], 0, 10); }
        ScenarioLevelRun.RestoreEnemySuppression();
        try
        {
            ScenarioLevelRun.ReportJson = ScenarioLevelRun.Json.Write(BuildReport());
        }
        catch (Exception e)
        {
            ScenarioLevelRun.Passed = false;
            ScenarioLevelRun.ReportJson = ScenarioLevelRun.Json.Write(new Dictionary<string, object>
            {
                { "scenario", "level-run" }, { "passed", false }, { "outcome", "error" }, { "errors", new[] { "report failed: " + e.Message } }
            });
        }
        ScenarioLevelRun.Phase = "done";
        ScenarioLevelRun.Done = true;
        ScenarioLevelRun.Log("done: " + how + (detail == null ? "" : " - " + detail));
    }

    private Dictionary<string, object> BuildReport()
    {
        var checks = new List<object>();
        bool surveyMode = outcome == "survey";
        if (!surveyMode && driveStarted)
        {
            if (durationSec <= 0f)
            {
                string exitDetail;
                if (outcome == "finished") exitDetail = "finished at " + T() + " s" + (helicopterVictory ? " at the helicopter" : " (not the helicopter)");
                else exitDetail = outcome + (outcomeDetail == null ? "" : " (" + outcomeDetail + ")") + " at " + T() + " s: " + ProgressText();
                checks.Add(Check("reachedExit", outcome == "finished", exitDetail));
            }
            if (forceDeathAt >= 0f)
            {
                string forcedText = !deathForced ? "no forced death: the run ended before " + forceDeathAt + " s or the bro was never alive to kill"
                    : !forcedDeathSeen ? "forced at " + Mathf.Round((deathForcedAt - driveStartTime) * 10f) / 10f + " s, the bro did not die"
                    : !forcedRespawnSeen ? "forced death seen, no respawn" : deathDetail;
                checks.Add(Check("deathAndRespawn", forcedDeathSeen && forcedRespawnSeen, forcedText + "; natural deaths " + naturalDeaths));
            }
            var parts = new List<string>();
            bool allUsed = true;
            for (int i = 0; i < ActionNames.Length; i++)
            {
                parts.Add(ActionNames[i] + " " + actionCounts[i] + (actionForced[i] ? " (forced)" : ""));
                if (actionCounts[i] == 0) allUsed = false;
            }
            checks.Add(Check("actionsUsed", allUsed, string.Join(", ", parts.ToArray()) + "; special ammo spent " + characters.Sum(c => c.AmmoSpent)
                + "; special ran " + characters.Sum(c => c.Special.Runs) + ", melee ran " + characters.Sum(c => c.Melee.Runs)));
            if (swapped) checks.Add(Check("drivenAfterSwap", actionsSinceSwap > 0, actionsSinceSwap + " action presses since the last character swap"));
            checks.Add(Check("enemiesEngaged", seenEnemies.Count > 0, "seen " + seenEnemies.Count + ", killed " + killedEnemies.Count
                + ", gone without a death seen " + despawnedEnemies.Count));
            if (required.Count > 0)
            {
                var gaps = new List<string>();
                foreach (var k in required)
                {
                    if (exercised.ContainsKey(k)) continue;
                    gaps.Add(k + (found.ContainsKey(k) ? " (found, not exercised)"
                        : Unplaced(k) ? " (in the level data with no object to reach)" : " (not found on this level)"));
                }
                checks.Add(Check("mechanicsRequired", gaps.Count == 0, gaps.Count == 0 ? "all exercised: " + string.Join(", ", required.ToArray()) : string.Join("; ", gaps.ToArray())));
            }
            foreach (var h in holds) checks.Add(Check(h.Check, h.Result == "ran", h.Detail));
        }
        else if (surveyMode)
        {
            checks.Add(Check("surveyed", surveyBlock != null, surveyBlock == null ? "no survey" : "scanned"));
        }
        checks.Add(Check("noRunnerErrors", ScenarioLevelRun.Errors.Count == 0 && outcome != "error",
            ScenarioLevelRun.Errors.Count == 0 && outcome != "error" ? "none" : (outcomeDetail ?? ScenarioLevelRun.Errors.Count + " errors")));

        bool passed = true;
        foreach (Dictionary<string, object> c in checks) if (!(bool)c["passed"]) passed = false;
        ScenarioLevelRun.Passed = passed;

        foreach (var kv in found)
        {
            if (surveyMode || exercised.ContainsKey(kv.Key) || kv.Key == "sandworm") continue;
            bool listed = false;
            foreach (Dictionary<string, object> m in missed) if ((string)m["kind"] == kv.Key) listed = true;
            if (listed) continue;
            Mech first = mechs.FirstOrDefault(m => m.Kind == kv.Key);
            Vector2? at = first != null ? first.Pos : kv.Key == "wormTunnel" && tunnelReps.Count > 0 ? tunnelReps[0] : (Vector2?)null;
            missed.Add(new Dictionary<string, object>
            {
                { "kind", kv.Key }, { "at", at == null ? null : new[] { Mathf.Round(at.Value.x), Mathf.Round(at.Value.y) } },
                { "attempted", false }, { "reason", DrivableKinds.Contains(kv.Key) ? "never within reach of the route" : "no driver for this kind" }
            });
        }

        var mechanics = new Dictionary<string, object>();
        mechanics["found"] = found;
        mechanics["exercised"] = exercised;
        mechanics["missed"] = missed;
        var unknown = unknownDoodads.Select(kv => (object)new Dictionary<string, object> { { "doodadType", kv.Key }, { "count", kv.Value } }).ToList();
        foreach (var kv in unplacedDoodads)
        {
            if (exercised.ContainsKey(DoodadKinds[kv.Key])) continue;
            unknown.Add(new Dictionary<string, object>
            {
                { "doodadType", kv.Key }, { "count", kv.Value }, { "kind", DoodadKinds[kv.Key] }, { "reason", "in the level data with no object to reach" }
            });
        }
        mechanics["unknown"] = unknown;
        if (required.Count > 0) mechanics["required"] = required;

        var report = new Dictionary<string, object>();
        report["scenario"] = surveyMode ? "level-survey" : "level-run";
        report["passed"] = passed;
        report["outcome"] = outcome;
        report["durationSec"] = driveStarted ? T() : 0f;
        report["args"] = argsEcho;
        report["context"] = context;
        report["checks"] = checks;
        if (surveyMode) report["survey"] = surveyBlock;
        else
        {
            report["assisted"] = assisted;
            report["progress"] = Progress();
            report["characters"] = characters.Select(c => (object)RecordJson(c)).ToList();
            report["events"] = events;
            report["stuck"] = stuckEvents;
        }
        report["mechanics"] = mechanics;
        report["enemySuppression"] = ScenarioLevelRun.Suppression;
        report["errors"] = ScenarioLevelRun.Errors.ToList();
        return report;
    }

    private bool ExitTarget(out string kind, out Vector2 pos)
    {
        if (HelicopterLadder(out pos)) { kind = "helicopter"; return true; }
        var p = Portal();
        if (p != null) { kind = "portal"; pos = p.transform.position; return true; }
        CheckPoint final = FinalFlag();
        if (final != null) { kind = "finalFlag"; pos = new Vector2(final.X, final.Y); return true; }
        kind = null;
        return false;
    }

    private void TrackProgress(TestVanDammeAnim bro)
    {
        string kind;
        Vector2 pos;
        if (!ExitTarget(out kind, out pos)) return;
        float dist = Vector2.Distance(new Vector2(bro.X, bro.Y), pos);
        if (kind != progressTarget) progressRemaining = dist;
        else progressRemaining = Mathf.Min(progressRemaining, dist);
        progressTarget = kind;
        progressTargetPos = pos;
        progressStartDist = Vector2.Distance(startPos, pos);
    }

    private float ProgressPercent()
    {
        if (outcome == "finished") return 100f;
        if (progressTarget == null)
        {
            float span = RightCol() * 16f - startX;
            return span > 0f ? Mathf.Clamp(Mathf.Round((furthestX - startX) / span * 100f), 0f, 100f) : 0f;
        }
        if (progressStartDist <= 0f) return 100f;
        return Mathf.Clamp(Mathf.Round((1f - progressRemaining / progressStartDist) * 100f), 0f, 100f);
    }

    private Dictionary<string, object> Progress()
    {
        return new Dictionary<string, object>
        {
            { "startX", Mathf.Round(startX) }, { "furthestX", Mathf.Round(furthestX) }, { "mapWidthPx", Map.Width * 16f },
            { "target", progressTarget ?? "rightEdge" },
            { "targetAt", progressTarget == null ? null : new[] { Mathf.Round(progressTargetPos.x), Mathf.Round(progressTargetPos.y) } },
            { "remainingPx", progressTarget == null ? (object)null : Mathf.Round(progressRemaining) },
            { "percent", ProgressPercent() },
            { "flagsActivated", CountFlagsActivated() }, { "flagsTotal", flagsTotal },
            { "lastStuck", stuckEvents.Count == 0 ? null : stuckEvents[stuckEvents.Count - 1] }
        };
    }

    private string ProgressText()
    {
        string toward = progressTarget == null
            ? "furthest x " + Mathf.Round(furthestX) + " toward the right edge"
            : "closest " + Mathf.Round(progressRemaining) + " px from the " + progressTarget + " (" + Mathf.Round(progressStartDist) + " px at the start)";
        return toward + ", " + ProgressPercent() + " %, " + CountFlagsActivated() + " of " + flagsTotal + " flags";
    }
}
