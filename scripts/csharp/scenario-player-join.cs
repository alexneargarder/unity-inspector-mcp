// #name Scenario Player Join
// #description Player-join scenario: joins a second local player on a deviceless controller in the loaded level, drives it, drops it out and verifies each step; poll ScenarioPlayerJoin.Done, read ReportJson
// #tags scenario
// #args controllerId: controller id the new player joins on, 2 or 3 have no keys bound (default 2)
// #args durationSec: seconds to drive the new player once it spawns (default 20)
// #args driver: bot (the game's follower bot) or idle (all input held off) (default bot)

using System.Collections;
using System.Globalization;
using System.Text;

public static class ScenarioPlayerJoin
{
    public static string Phase = "idle";
    public static bool Done;
    public static bool Passed;
    public static string ReportJson = "";

    internal static Action<string> Log = delegate { };
    internal static ScenarioPlayerJoinRunner Runner;
    internal static int Slot = -1;
    internal static bool Idle;
    internal static int FireFrames;
    internal static int AgentsAdopted;
    internal static int BotMoveFrames;

    public static void Main()
    {
        Log = ScriptContext.Logger;
        Phase = "idle";
        Done = false;
        Passed = false;
        ReportJson = "";
        Slot = -1;
        FireFrames = 0;
        AgentsAdopted = 0;
        BotMoveFrames = 0;

        int controllerId;
        float durationSec;
        if (!int.TryParse(ScriptContext.GetArg("controllerId", "2").Trim(), out controllerId)) controllerId = 2;
        if (!float.TryParse(ScriptContext.GetArg("durationSec", "20").Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out durationSec)) durationSec = 20f;
        string driver = ScriptContext.GetArg("driver", "bot").Trim().ToLowerInvariant();
        Idle = driver == "idle";

        const BindingFlags flags = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
        var postfix = new HarmonyMethod(typeof(ScenarioPlayerJoin).GetMethod("InputPostfix", flags));
        postfix.priority = Priority.Last;
        ScriptContext.Harmony.Patch(AccessTools.Method(typeof(Player), "GetInput"),
            new HarmonyMethod(typeof(ScenarioPlayerJoin).GetMethod("InputPrefix", flags)), postfix);

        var go = new GameObject("ScenarioPlayerJoin");
        UnityEngine.Object.DontDestroyOnLoad(go);
        ScriptContext.GameObjects.Add(go);
        Runner = go.AddComponent<ScenarioPlayerJoinRunner>();
        Runner.Begin(controllerId, durationSec, driver);
    }

    public static void Unload()
    {
        if (Runner != null) Runner.DropIfJoined("unload");
        Slot = -1;
        Runner = null;
    }

    private static void InputPrefix(Player __instance)
    {
        if (Slot < 0 || __instance.playerNum != Slot || !__instance.UsingBotBrain) return;
        var brain = __instance.GetComponent<BotBrain>();
        if (brain == null || brain.unit == null || brain.pathAgent != null) return;
        // Game defect: BotBrain.SetUnit keeps only a PathAgent it added, so a bot enabled after the hero's Start reads null and throws every frame
        brain.pathAgent = brain.unit.GetComponent<PathAgent>();
        if (brain.pathAgent != null) AgentsAdopted++;
    }

    private static void InputPostfix(Player __instance, ref bool up, ref bool down, ref bool left, ref bool right,
        ref bool fire, ref bool buttonJump, ref bool special, ref bool highFive, ref bool buttonGesture, ref bool sprint)
    {
        if (Slot < 0 || __instance.playerNum != Slot) return;
        if (Idle && !__instance.UsingBotBrain)
        {
            up = down = left = right = fire = buttonJump = special = highFive = buttonGesture = sprint = false;
            return;
        }
        if (fire) FireFrames++;
        if (__instance.UsingBotBrain && (left || right || up || down || buttonJump)) BotMoveFrames++;
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

public class ScenarioPlayerJoinRunner : MonoBehaviour
{
    private const float JoinTimeoutSec = 5f;
    private const float SpawnTimeoutSec = 15f;

    private int controllerId;
    private float durationSec;
    private string driver;
    private string phase = "joining";
    private float phaseStart;
    private float runStart;
    private int slot = -1;
    private bool joined;
    private bool dropped;
    private bool[] playingBefore = new bool[4];
    private int playersBefore;
    private int p1ControllerBefore;
    private bool savedBot;
    private int savedLeader = -1;
    private float startX;
    private float startGap = -1f;
    private float maxMoved;
    private bool p2Died;
    private string spawnedAs;
    private float spawnDelay = -1f;
    private readonly List<object> checks = new List<object>();
    private readonly List<object> events = new List<object>();
    private readonly List<string> errors = new List<string>();
    private readonly Dictionary<string, object> facts = new Dictionary<string, object>();

    public void Begin(int controllerId, float durationSec, string driver)
    {
        this.controllerId = controllerId;
        this.durationSec = durationSec;
        this.driver = driver;
        runStart = Time.realtimeSinceStartup;
        phaseStart = runStart;
        ScenarioPlayerJoin.Phase = "joining";

        var hc = HeroController.Instance;
        facts["controllerId"] = controllerId;
        facts["driver"] = driver;
        facts["inLevel"] = hc != null && Map.Instance != null;
        facts["allowPlayerDropIn"] = GameModeController.AllowPlayerDropIn;
        facts["droppedOutThisRoundBefore"] = hc != null && hc.IDroppedOutThisRound;
        for (int i = 0; i < 4; i++) playingBefore[i] = HeroController.IsPlayerPlaying(i);
        playersBefore = HeroController.GetPlayersPlayingCount();
        facts["playersBefore"] = playersBefore;
        p1ControllerBefore = HeroController.playerControllerIDs[0];
        facts["controllerAlreadyUsed"] = Array.IndexOf(HeroController.playerControllerIDs, controllerId) >= 0;

        if (hc == null)
        {
            Finish("no level is loaded");
            return;
        }
        AddEvent("join", "HeroController.AddLocalPlayer(-1, " + controllerId + ")");
        HeroController.AddLocalPlayer(-1, controllerId);
    }

    private float Now()
    {
        return Mathf.Round((Time.realtimeSinceStartup - runStart) * 10f) / 10f;
    }

    private void Update()
    {
        if (phase == "done") return;
        try { Tick(); }
        catch (Exception e)
        {
            errors.Add(e.GetType().Name + ": " + e.Message);
            DropIfJoined("error");
            Finish("runner threw: " + e.Message);
        }
    }

    private void Tick()
    {
        float inPhase = Time.realtimeSinceStartup - phaseStart;
        if (phase == "joining")
        {
            for (int i = 0; i < 4; i++)
            {
                if (!playingBefore[i] && HeroController.IsPlayerPlaying(i) && HeroController.players[i] != null) slot = i;
            }
            if (slot >= 0)
            {
                joined = true;
                ScenarioPlayerJoin.Slot = slot;
                savedBot = HeroController.UseBotBrain[slot];
                savedLeader = HeroController.BotBrainLeader[slot];
                int count = HeroController.GetPlayersPlayingCount();
                facts["slot"] = slot;
                facts["playersAfterJoin"] = count;
                bool ok = HeroController.playerControllerIDs[slot] == controllerId && count == playersBefore + 1;
                checks.Add(Check("joined", ok, "slot " + slot + " playing on controller " + HeroController.playerControllerIDs[slot]
                    + ", players " + playersBefore + " -> " + count + " after " + Mathf.Round(inPhase * 10f) / 10f + " s"));
                Next("spawning");
            }
            else if (inPhase > JoinTimeoutSec)
            {
                checks.Add(Check("joined", false, "no new player slot within " + JoinTimeoutSec + " s; AllowPlayerDropIn " + facts["allowPlayerDropIn"]
                    + ", controller already used " + facts["controllerAlreadyUsed"]));
                Finish("the player never joined");
            }
        }
        else if (phase == "spawning")
        {
            var p = HeroController.players[slot];
            if (p == null) { checks.Add(Check("spawned", false, "the player object vanished before spawning")); Next("dropping"); return; }
            if (p.IsAliveAndSpawnedHero())
            {
                spawnDelay = inPhase;
                spawnedAs = p.character.GetType().Name;
                startX = p.character.X;
                var lead = HeroController.players[0];
                if (lead != null && lead.character != null) startGap = Mathf.Abs(lead.character.X - startX);
                checks.Add(Check("spawned", p.character.playerNum == slot, spawnedAs + " with playerNum " + p.character.playerNum
                    + " after " + Mathf.Round(inPhase * 10f) / 10f + " s, lives " + p.Lives));
                if (driver == "bot")
                {
                    p.EnableBotBrain();
                    p.SetBotbrainLeader(0);
                    AddEvent("drive", "follower bot enabled, leader player 0");
                }
                Next("driving");
            }
            else if (inPhase > SpawnTimeoutSec)
            {
                checks.Add(Check("spawned", false, "no spawned hero within " + SpawnTimeoutSec + " s, lives " + p.Lives
                    + (facts["droppedOutThisRoundBefore"].Equals(true) ? " (a player dropped out earlier this level, so a rejoin gets no lives)" : "")));
                Next("dropping");
            }
        }
        else if (phase == "driving")
        {
            var p = HeroController.players[slot];
            var ch = p == null ? null : p.character;
            if (ch != null && ch.health > 0) maxMoved = Mathf.Max(maxMoved, Mathf.Abs(ch.X - startX));
            else if (!p2Died) { p2Died = true; AddEvent("death", "player " + (slot + 1) + " died while driven"); }
            if (inPhase >= durationSec)
            {
                // The follower bot stops at its leader, so with player 1 standing still it moves only as far as the gap it spawned at.
                bool moved = maxMoved >= 16f && ScenarioPlayerJoin.BotMoveFrames > 0;
                bool fired = ScenarioPlayerJoin.FireFrames > 0;
                if (driver == "idle")
                    checks.Add(Check("held", maxMoved < 16f, "input held off for " + durationSec + " s, moved " + Mathf.Round(maxMoved) + " px"));
                else
                    checks.Add(Check("driven", moved || fired, "moved " + Mathf.Round(maxMoved) + " px from spawn " + Mathf.Round(startGap) + " px from player 1, bot movement input on "
                        + ScenarioPlayerJoin.BotMoveFrames + " frames, fire held " + ScenarioPlayerJoin.FireFrames + " frames"));
                var p1 = HeroController.players[0];
                bool p1ok = p1 != null && HeroController.IsPlayerPlaying(0) && HeroController.playerControllerIDs[0] == p1ControllerBefore;
                checks.Add(Check("player1Unaffected", p1ok, "player 1 " + (p1 == null ? "missing" : "playing " + HeroController.IsPlayerPlaying(0)
                    + ", controller " + HeroController.playerControllerIDs[0] + " (was " + p1ControllerBefore + "), alive " + p1.IsAliveAndSpawnedHero())));
                Next("dropping");
            }
        }
        else if (phase == "dropping")
        {
            DropIfJoined("scenario");
            Next("verifying");
        }
        else if (phase == "verifying")
        {
            if (inPhase < 0.5f) return;
            bool gone = HeroController.players[slot] == null;
            bool notPlaying = !HeroController.IsPlayerPlaying(slot);
            bool noController = HeroController.playerControllerIDs[slot] == -1;
            int leftover = UnityEngine.Object.FindObjectsOfType<TestVanDammeAnim>().Count(b => b.playerNum == slot && b.health > 0);
            checks.Add(Check("removed", gone && notPlaying && noController && leftover == 0, "player object gone " + gone + ", playing " + !notPlaying
                + ", controller id " + HeroController.playerControllerIDs[slot] + ", live heroes left with playerNum " + slot + ": " + leftover));
            facts["playersAfterDropout"] = HeroController.GetPlayersPlayingCount();
            Finish(null);
        }
    }

    private void Next(string next)
    {
        phase = next;
        phaseStart = Time.realtimeSinceStartup;
        ScenarioPlayerJoin.Phase = next;
    }

    public void DropIfJoined(string why)
    {
        if (!joined || dropped || slot < 0) return;
        dropped = true;
        try
        {
            if (HeroController.IsPlayerPlaying(slot) || HeroController.players[slot] != null)
            {
                HeroController.Dropout(slot, false);
                AddEvent("dropout", "HeroController.Dropout(" + slot + ", false) on " + why);
            }
        }
        finally
        {
            HeroController.UseBotBrain[slot] = savedBot;
            HeroController.BotBrainLeader[slot] = savedLeader;
            ScenarioPlayerJoin.Slot = -1;
        }
    }

    private void AddEvent(string type, string detail)
    {
        events.Add(new Dictionary<string, object> { { "t", Now() }, { "type", type }, { "detail", detail } });
    }

    private static Dictionary<string, object> Check(string name, bool passed, string detail)
    {
        return new Dictionary<string, object> { { "name", name }, { "passed", passed }, { "detail", detail } };
    }

    private void Finish(string failure)
    {
        phase = "done";
        if (failure != null) errors.Add(failure);
        bool passed = errors.Count == 0 && checks.Count > 0;
        foreach (Dictionary<string, object> c in checks) if (!(bool)c["passed"]) passed = false;
        facts["spawnedAs"] = spawnedAs;
        facts["spawnDelaySec"] = spawnDelay;
        facts["diedWhileDriven"] = p2Died;
        facts["botAgentsAdopted"] = ScenarioPlayerJoin.AgentsAdopted;
        var report = new Dictionary<string, object>();
        report["scenario"] = "player-join";
        report["passed"] = passed;
        report["durationSec"] = Now();
        report["context"] = facts;
        report["checks"] = checks;
        report["events"] = events;
        report["errors"] = errors;
        ScenarioPlayerJoin.Passed = passed;
        ScenarioPlayerJoin.ReportJson = ScenarioPlayerJoin.Json.Write(report);
        ScenarioPlayerJoin.Phase = "done";
        ScenarioPlayerJoin.Done = true;
        ScenarioPlayerJoin.Log("done: " + (passed ? "passed" : "failed"));
    }
}
