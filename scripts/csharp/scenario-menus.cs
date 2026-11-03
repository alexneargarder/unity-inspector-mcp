// #name Scenario Menus
// #description Menu-pass scenario: watches the pause menu, opens UnityModManager's window and draws mods' settings, then returns to the main menu through the pause menu; ScenarioMenus.Next() advances, ScenarioMenus.Finish() returns the report JSON
// #tags scenario
// #args mod: UnityModManager mod id whose settings are drawn, or * for every active mod with settings (default *)
// #args frames: frames each mod's settings must draw (default 30)

using System.Collections;
using System.Globalization;
using System.Text;
using UnityModManagerNet;

public static class ScenarioMenus
{
    public static string Phase = "idle";
    public static bool Done;
    public static bool Passed;
    public static string ReportJson = "";

    internal static Action<string> Log = delegate { };
    internal static ScenarioMenusRunner Runner;

    public static void Main()
    {
        Log = ScriptContext.Logger;
        Phase = "watching-pause";
        Done = false;
        Passed = false;
        ReportJson = "";
        int frames;
        if (!int.TryParse(ScriptContext.GetArg("frames", "30").Trim(), out frames) || frames < 1) frames = 30;
        string mod = ScriptContext.GetArg("mod", "*").Trim();
        if (mod.Length == 0) mod = "*";

        var go = new GameObject("ScenarioMenus");
        // The offline pause deactivates every object without this tag, which would stop the runner watching the pause menu.
        go.tag = "Unpausable";
        UnityEngine.Object.DontDestroyOnLoad(go);
        ScriptContext.GameObjects.Add(go);
        Runner = go.AddComponent<ScenarioMenusRunner>();
        Runner.Begin(mod, frames);
    }

    public static string Next()
    {
        if (Runner != null) Runner.Advance();
        return Phase;
    }

    public static string Finish()
    {
        if (Runner != null) Runner.Complete();
        return ReportJson;
    }

    public static void Unload()
    {
        if (Runner != null) Runner.RestoreAll();
        Runner = null;
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

public class ScenarioMenusRunner : MonoBehaviour
{
    private const float ModTimeoutSec = 5f;
    private const float HoldTimeoutSec = 60f;
    private const float MenuTimeoutSec = 30f;

    private string modArg;
    private int frameTarget;
    private string phase = "watching-pause";
    private float runStart;
    private float phaseStart;
    private bool advance;

    private PauseStatus lastPause;
    private float pauseOpenedAt = -1f;
    private float pauseClosedAt = -1f;

    private UnityModManager.UI ui;
    private PropertyInfo showSettings;
    private FieldInfo modFilter;
    private bool openedWindow;
    private int savedTab;
    private object savedFilter;
    private int savedShow = -1;
    private bool savedUi;
    private List<UnityModManager.ModEntry> targets = new List<UnityModManager.ModEntry>();
    private int targetIndex = -1;
    private UnityModManager.ModEntry wrapped;
    private Action<UnityModManager.ModEntry> original;
    private int drawFrames;
    private int lastDrawFrame = -1;
    private float modStart;
    private bool pausedByScript;

    private readonly List<object> checks = new List<object>();
    private readonly List<object> mods = new List<object>();
    private readonly List<string> errors = new List<string>();

    public void Begin(string mod, int frames)
    {
        modArg = mod;
        frameTarget = frames;
        runStart = Time.realtimeSinceStartup;
        phaseStart = runStart;
        lastPause = PauseController.pauseStatus;
        if (lastPause != PauseStatus.UnPaused) errors.Add("the game was already paused (" + lastPause + ") when the scenario started");
    }

    public void Advance()
    {
        advance = true;
    }

    private float Since(float start)
    {
        return Mathf.Round((Time.realtimeSinceStartup - start) * 100f) / 100f;
    }

    private void Next(string next)
    {
        phase = next;
        phaseStart = Time.realtimeSinceStartup;
        ScenarioMenus.Phase = next;
        advance = false;
    }

    private void Update()
    {
        if (phase == "done") return;
        try { Tick(); }
        catch (Exception e)
        {
            errors.Add(phase + ": " + e.GetType().Name + ": " + e.Message);
            RestoreWrapped();
            Next("failed");
        }
    }

    private void Tick()
    {
        if (phase == "watching-pause")
        {
            PauseStatus now = PauseController.pauseStatus;
            if (now == PauseStatus.MenuPause && lastPause != PauseStatus.MenuPause && pauseOpenedAt < 0f) pauseOpenedAt = Time.realtimeSinceStartup;
            if (now == PauseStatus.UnPaused && lastPause == PauseStatus.MenuPause && pauseOpenedAt >= 0f && pauseClosedAt < 0f) pauseClosedAt = Time.realtimeSinceStartup;
            lastPause = now;
            if (!advance) return;
            checks.Add(Check("pauseOpened", pauseOpenedAt >= 0f, pauseOpenedAt >= 0f ? "MenuPause after " + Since(runStart) + " s of watching" : "the pause menu never opened"));
            checks.Add(Check("pauseClosed", pauseClosedAt >= 0f, pauseClosedAt >= 0f ? "UnPaused " + Mathf.Round((pauseClosedAt - pauseOpenedAt) * 100f) / 100f + " s after it opened" : "the pause menu never closed"));
            StartUmm();
        }
        else if (phase == "umm-settings") TickSettings();
        else if (phase == "umm-open")
        {
            if (!advance && Since(phaseStart) < HoldTimeoutSec) return;
            CloseUmm();
            StartReturnToMenu();
        }
        else if (phase == "to-main-menu")
        {
            if (LevelSelectionController.IsMainMenuScene)
            {
                checks.Add(Check("returnedToMainMenu", true, "MainMenu scene after " + Since(phaseStart) + " s"));
                Next("main-menu");
            }
            else if (Since(phaseStart) > MenuTimeoutSec)
            {
                checks.Add(Check("returnedToMainMenu", false, "still in " + UnityEngine.SceneManagement.SceneManager.GetActiveScene().name + " after " + MenuTimeoutSec + " s"));
                Next("failed");
            }
        }
    }

    private void StartUmm()
    {
        ui = UnityModManager.UI.Instance;
        if (ui == null)
        {
            checks.Add(Check("ummOpened", false, "UnityModManager.UI.Instance is null"));
            Next("failed");
            return;
        }
        if (PauseController.pauseStatus != PauseStatus.UnPaused) errors.Add("the game was still paused when the UMM pass started");
        showSettings = AccessTools.Property(typeof(UnityModManager.UI), "ShowModSettings");
        modFilter = AccessTools.Field(typeof(UnityModManager.UI), "mModFilter");
        savedTab = ui.tabId;
        savedFilter = modFilter == null ? null : modFilter.GetValue(ui);
        savedShow = showSettings == null ? -1 : (int)showSettings.GetValue(ui, null);
        savedUi = true;

        foreach (var entry in UnityModManager.modEntries)
        {
            if (!entry.Active || entry.OnGUI == null) continue;
            if (modArg == "*" || string.Equals(entry.Info.Id, modArg, StringComparison.OrdinalIgnoreCase)
                || string.Equals(entry.Info.DisplayName, modArg, StringComparison.OrdinalIgnoreCase)) targets.Add(entry);
        }

        ui.tabId = 0;
        if (modFilter != null) modFilter.SetValue(ui, "");
        bool wasOpen = ui.Opened;
        if (!wasOpen) { ui.ToggleWindow(true); openedWindow = true; }
        checks.Add(Check("ummOpened", ui.Opened, wasOpen ? "the window was already open" : (ui.Opened ? "ToggleWindow(true) opened it" : "ToggleWindow(true) left it closed")));
        if (!ui.Opened) { Next("failed"); return; }
        if (showSettings == null) { errors.Add("UnityModManager.UI has no ShowModSettings property"); Next("failed"); return; }
        if (targets.Count == 0)
        {
            checks.Add(Check("modSettingsDrawn", false, modArg == "*" ? "no active mod has settings" : "no active mod with settings matches '" + modArg + "'"));
            Next("umm-open");
            return;
        }
        Next("umm-settings");
        StartMod(0);
    }

    private void StartMod(int i)
    {
        targetIndex = i;
        wrapped = targets[i];
        original = wrapped.OnGUI;
        drawFrames = 0;
        lastDrawFrame = -1;
        modStart = Time.realtimeSinceStartup;
        Action<UnityModManager.ModEntry> inner = original;
        wrapped.OnGUI = entry =>
        {
            if (Time.frameCount != lastDrawFrame) { lastDrawFrame = Time.frameCount; drawFrames++; }
            inner(entry);
        };
        showSettings.SetValue(ui, UnityModManager.modEntries.IndexOf(wrapped), null);
    }

    private void TickSettings()
    {
        int index = UnityModManager.modEntries.IndexOf(wrapped);
        int shown = (int)showSettings.GetValue(ui, null);
        bool collapsed = shown != index;
        if (drawFrames < frameTarget && !collapsed && Since(modStart) < ModTimeoutSec) return;
        mods.Add(new Dictionary<string, object>
        {
            { "mod", wrapped.Info.Id }, { "frames", drawFrames }, { "stillExpanded", !collapsed }, { "seconds", Since(modStart) },
            { "passed", drawFrames >= frameTarget && !collapsed }
        });
        RestoreWrapped();
        if (targetIndex + 1 < targets.Count) { StartMod(targetIndex + 1); return; }

        var failed = new List<string>();
        foreach (Dictionary<string, object> m in mods) if (!(bool)m["passed"]) failed.Add((string)m["mod"] + " (" + m["frames"] + " frames" + ((bool)m["stillExpanded"] ? "" : ", collapsed: its OnGUI threw") + ")");
        checks.Add(Check("modSettingsDrawn", failed.Count == 0, failed.Count == 0
            ? mods.Count + " mods drew " + frameTarget + "+ frames each" : "short of " + frameTarget + " frames: " + string.Join(", ", failed.ToArray())));
        showSettings.SetValue(ui, UnityModManager.modEntries.IndexOf(targets[0]), null);
        Next("umm-open");
    }

    private void RestoreWrapped()
    {
        if (wrapped != null && original != null) wrapped.OnGUI = original;
        wrapped = null;
        original = null;
    }

    private void CloseUmm()
    {
        RestoreUi();
        checks.Add(Check("ummClosed", ui != null && !ui.Opened, ui == null ? "no UI" : (ui.Opened ? "the window is still open" : "closed")));
    }

    private void RestoreUi()
    {
        RestoreWrapped();
        if (ui == null || !savedUi) return;
        if (showSettings != null) showSettings.SetValue(ui, savedShow, null);
        if (openedWindow && ui.Opened) ui.ToggleWindow(false);
        openedWindow = false;
        ui.tabId = savedTab;
        if (modFilter != null) modFilter.SetValue(ui, savedFilter);
        savedUi = false;
    }

    private void StartReturnToMenu()
    {
        if (PauseController.instance == null || PauseMenu.instance == null)
        {
            checks.Add(Check("returnedToMainMenu", false, "no PauseController or PauseMenu in this scene"));
            Next("failed");
            return;
        }
        if (PauseController.pauseStatus == PauseStatus.UnPaused)
        {
            PauseController.instance.TogglePause();
            pausedByScript = true;
        }
        if (PauseController.pauseStatus != PauseStatus.MenuPause)
        {
            checks.Add(Check("returnedToMainMenu", false, "the pause menu did not open (" + PauseController.pauseStatus + ")"));
            Next("failed");
            return;
        }
        // ReturnToMenu only raises the confirmation popup; the popup's ConfirmReturnToMenu loads the menu
        AccessTools.Method(typeof(PauseMenu), "ReturnToMenu").Invoke(PauseMenu.instance, null);
        object popup = AccessTools.Field(typeof(PauseMenu), "m_ConfirmationPopup").GetValue(PauseMenu.instance);
        if (popup == null)
        {
            checks.Add(Check("returnedToMainMenu", false, "the pause menu has no confirmation popup"));
            Next("failed");
            return;
        }
        AccessTools.Method(popup.GetType(), "ConfirmReturnToMenu").Invoke(popup, null);
        pausedByScript = false;
        Next("to-main-menu");
    }

    public void Complete()
    {
        if (phase == "done") return;
        var p = HeroController.players[0];
        bool inLevel = LevelSelectionController.CurrentlyInGame && Map.Instance != null && p != null && p.IsAliveAndSpawnedHero();
        if (phase == "main-menu") checks.Add(Check("backInLevel", inLevel, inLevel ? "player 1 alive in " + UnityEngine.SceneManagement.SceneManager.GetActiveScene().name : "not back in a level with player 1 spawned"));
        else errors.Add("finished in phase " + phase + ", before the main-menu round trip completed");
        RestoreAll();
        bool passed = errors.Count == 0 && checks.Count > 0;
        foreach (Dictionary<string, object> c in checks) if (!(bool)c["passed"]) passed = false;
        var report = new Dictionary<string, object>();
        report["scenario"] = "menus";
        report["passed"] = passed;
        report["durationSec"] = Since(runStart);
        report["args"] = new Dictionary<string, object> { { "mod", modArg }, { "frames", frameTarget } };
        report["checks"] = checks;
        report["mods"] = mods;
        report["errors"] = errors;
        ScenarioMenus.Passed = passed;
        ScenarioMenus.ReportJson = ScenarioMenus.Json.Write(report);
        Next("done");
        ScenarioMenus.Done = true;
    }

    public void RestoreAll()
    {
        try { RestoreUi(); } catch (Exception e) { errors.Add("restoring UMM: " + e.Message); }
        if (pausedByScript && PauseController.pauseStatus == PauseStatus.MenuPause && PauseController.instance != null)
        {
            PauseController.instance.TogglePause();
            pausedByScript = false;
        }
    }

    private static Dictionary<string, object> Check(string name, bool passed, string detail)
    {
        return new Dictionary<string, object> { { "name", name }, { "passed", passed }, { "detail", detail } };
    }
}
