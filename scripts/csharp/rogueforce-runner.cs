// #name Rogueforce Runner
// #description Test harness for the Rogueforce mod. Start a run, skip levels, log state, auto-run a full campaign, or trigger game over.
// #tags rogueforce, testing, procgen
// #args action: start | park | skip | status | layout | seed | autorun | gameover (default: status), seed: seed value for 'seed' action

using System.Collections.Generic;
using UnityEngine;
using UnityEngine.SceneManagement;
using World.Generation;
using World.Generation.MapGenV4;

public class RogueforceRunner : MonoBehaviour
{
    private const int StateStartRun = 0;
    private const int StateWaitForAdvantage = 1;
    private const int StateWaitForLevel = 2;
    private const int StateLogAndSkip = 3;
    private const int StateWaitForTransition = 4;
    private const int StateKillPlayers = 5;
    private const int StateWaitForGameOver = 6;
    private const int StateDone = 7;

    // A wait state that never resolves would tick forever on a DontDestroyOnLoad object
    private const float AdvantageTimeoutSeconds = 60f;
    private const float LevelTimeoutSeconds = 120f;
    private const float GameOverTimeoutSeconds = 60f;

    // ScriptContext.Logger only carries the [Script:name] prefix while Main()/Unload() is running
    private static System.Action<string> cachedLogger;

    private int state;
    private float timer;
    private float advantageWait;
    private float levelWait;
    private float gameOverWait;
    private int levelsCompleted;
    private int totalLevels;
    private bool gameOverMode;
    private bool parkOnly;

    private static void Log(string message)
    {
        cachedLogger(message);
    }

    public static void Main()
    {
        cachedLogger = ScriptContext.Logger;

        string action = ScriptContext.GetArg("action", "status");

        if (action == "start") StartRun();
        else if (action == "park") StartParked();
        else if (action == "skip") SkipLevel();
        else if (action == "status") LogStatus();
        else if (action == "layout") LogLayout();
        else if (action == "seed") LogOrSetSeed();
        else if (action == "autorun") StartAutoRun(false);
        else if (action == "gameover") StartAutoRun(true);
        else Log("Unknown action: " + action + ". Use start | park | skip | status | layout | seed | autorun | gameover");
    }

    private static void StartRun()
    {
        var scene = SceneManager.GetActiveScene().name;
        if (scene != "MainMenu" && scene != "Test Evan2")
        {
            Log("ERROR: Must be at main menu. Current scene: " + scene);
            return;
        }

        var asm = System.Reflection.Assembly.Load("Rogueforce");
        var modeType = asm.GetType("Rogueforce.RogueforceMode");
        var launchMethod = modeType.GetMethod("Launch", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
        launchMethod.Invoke(null, null);
        Log("Rogueforce run launched. Select a starting advantage to begin.");
    }

    private static void SkipLevel()
    {
        if (!ProcGenGameMode.isEnabled)
        {
            Log("ERROR: Not in a Rogueforce run.");
            return;
        }
        if (GameModeController.Instance == null)
        {
            Log("ERROR: No GameModeController.");
            return;
        }

        int currentLevel = ProcGenGameMode.GetLevelNum();
        int totalLevels = ProcGenGameMode.GetTotalLevels();
        Log("Skipping level " + currentLevel + " / " + totalLevels);

        GameModeController.Instance.switchSilently = true;
        GameModeController.LevelFinish(LevelResult.Success);
        GameModeController.MakeFinishInstant();
    }

    private static void LogStatus()
    {
        var scene = SceneManager.GetActiveScene().name;
        Log("Scene: " + scene);
        Log("ProcGen enabled: " + ProcGenGameMode.isEnabled);

        if (!ProcGenGameMode.isEnabled)
            return;

        Log("Level: " + ProcGenGameMode.GetLevelNum() + " / " + ProcGenGameMode.GetTotalLevels());
        Log("Lives: " + ProcGenGameMode.GetLives());

        var mooks = UnityEngine.Object.FindObjectsOfType<Mook>();
        int alive = 0;
        var typeCounts = new Dictionary<string, int>();
        foreach (var mook in mooks)
        {
            if (mook.health > 0)
            {
                alive++;
                string typeName = mook.GetType().Name;
                if (!typeCounts.ContainsKey(typeName))
                    typeCounts[typeName] = 0;
                typeCounts[typeName]++;
            }
        }
        Log("Enemies alive: " + alive);
        foreach (var kv in typeCounts)
            Log("  " + kv.Key + ": " + kv.Value);

        var players = HeroController.players;
        if (players != null)
        {
            for (int i = 0; i < players.Length; i++)
            {
                if (players[i] != null && players[i].character != null)
                {
                    var hero = players[i].character;
                    Log("Player " + i + ": " + hero.GetType().Name + " hp=" + hero.health);
                }
            }
        }
    }

    private static void LogLayout()
    {
        if (!ProcGenGameMode.isEnabled)
        {
            Log("ERROR: Not in a Rogueforce run.");
            return;
        }

        var asm = System.Reflection.Assembly.Load("Rogueforce");
        var patchType = asm.GetType("Rogueforce.LayoutStitcherPatch");
        var chainField = patchType.GetField("LastChain", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public);
        var chain = chainField.GetValue(null) as System.Collections.IList;

        if (chain == null || chain.Count == 0)
        {
            Log("No layout chain stored for current level.");
            return;
        }

        float playerX = 0f;
        var players = HeroController.players;
        if (players != null)
        {
            for (int i = 0; i < players.Length; i++)
            {
                if (players[i] != null && players[i].character != null)
                {
                    playerX = players[i].character.X;
                    break;
                }
            }
        }

        int tileWidth = 3;
        float blockSize = 16f;
        float playerBlock = playerX / blockSize;
        string currentSegment = "unknown";
        Log("Level: " + ProcGenGameMode.GetLevelNum() + " / " + ProcGenGameMode.GetTotalLevels());
        Log("Player X: " + playerX.ToString("F0") + " (block " + playerBlock.ToString("F1") + ")");
        Log("Layout chain:");

        for (int i = 0; i < chain.Count; i++)
        {
            var layout = chain[i];
            var layoutType = layout.GetType();
            string name = (string)layoutType.GetField("name").GetValue(layout);
            int width = (int)layoutType.GetField("width").GetValue(layout);
            int height = (int)layoutType.GetField("height").GetValue(layout);
            int x = (int)layoutType.GetField("x").GetValue(layout);

            int blockX = x;
            int blockWidth = width * tileWidth;
            bool isHere = playerBlock >= blockX && playerBlock < blockX + blockWidth;
            string marker = isHere ? " ◄ YOU ARE HERE" : "";

            Log("  [" + i + "] " + name + " (" + width + "x" + height + ") x=" + blockX + "-" + (blockX + blockWidth) + marker);
            if (isHere) currentSegment = name;
        }

        Log("Current segment: " + currentSegment);
    }

    private static void LogOrSetSeed()
    {
        string seedArg = ScriptContext.GetArg("seed", "");
        if (string.IsNullOrEmpty(seedArg))
        {
            if (ProcGenGameMode.isEnabled)
            {
                Log("Current seed: " + ProcGenGameMode.GetSeed());
                Log("Level: " + ProcGenGameMode.GetLevelNum() + " / " + ProcGenGameMode.GetTotalLevels());
            }
            else
            {
                Log("Not in a Rogueforce run.");
            }
            return;
        }

        int seed;
        if (!int.TryParse(seedArg, out seed))
        {
            Log("ERROR: Invalid seed value: " + seedArg);
            return;
        }

        var asm = System.Reflection.Assembly.Load("Rogueforce");
        var modeType = asm.GetType("Rogueforce.RogueforceMode");
        var seedField = modeType.GetField("ForcedSeed", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
        if (seedField == null)
        {
            Log("ERROR: RogueforceMode.ForcedSeed field not found — mod may need updating");
            return;
        }
        seedField.SetValue(null, seed);
        Log("Forced seed set to " + seed + " — will be used on next run start");
    }

    private static void StartAutoRun(bool gameOverMode)
    {
        Log(gameOverMode ? "Starting game-over test..." : "Starting auto-run...");
        var go = new GameObject("RogueforceRunner");
        UnityEngine.Object.DontDestroyOnLoad(go);
        ScriptContext.GameObjects.Add(go);
        var runner = go.AddComponent<RogueforceRunner>();
        runner.gameOverMode = gameOverMode;

        if (ProcGenGameMode.isEnabled)
        {
            runner.state = StateWaitForLevel;
            runner.totalLevels = ProcGenGameMode.GetTotalLevels();
            Log("Already in a run. Picking up from level " + ProcGenGameMode.GetLevelNum());
        }
        else
        {
            runner.state = StateStartRun;
        }
    }

    private static void StartParked()
    {
        if (ProcGenGameMode.isEnabled)
        {
            Log("Already in a Rogueforce run — park has nothing to do");
            return;
        }
        Log("Starting run and parking on first level...");
        var go = new GameObject("RogueforceRunner");
        UnityEngine.Object.DontDestroyOnLoad(go);
        ScriptContext.GameObjects.Add(go);
        var runner = go.AddComponent<RogueforceRunner>();
        runner.parkOnly = true;
        runner.state = StateStartRun;
    }

    private void Update()
    {
        if (state == StateDone)
            return;

        timer -= Time.deltaTime;
        if (timer > 0f)
            return;

        // A throw here would repeat every frame, since the state and timer assignments after it are skipped
        try
        {
            Tick();
        }
        catch (System.Exception e)
        {
            Log("ERROR: aborting run — " + e.Message);
            state = StateDone;
        }
    }

    private void Tick()
    {
        if (state == StateStartRun)
        {
            StartRun();
            state = StateWaitForAdvantage;
            advantageWait = 0f;
            timer = 0.5f;
        }
        else if (state == StateWaitForAdvantage)
        {
            var advantage = UnityEngine.Object.FindObjectOfType<SelectStartingAdvantage>();
            if (advantage != null)
            {
                Log("Auto-selecting Dollars advantage...");
                ProcGenGameMode.chosenAdvantageType = SelectStartingAdvantage.AdvantageType.Dollars;
                advantage.LoadProcGen();
                state = StateWaitForLevel;
                levelWait = 0f;
                timer = 2f;
            }
            else if (ProcGenGameMode.isEnabled && GameModeController.Instance != null)
            {
                state = StateWaitForLevel;
                levelWait = 0f;
                timer = 1f;
            }
            else
            {
                advantageWait += 0.5f;
                if (advantageWait >= AdvantageTimeoutSeconds)
                {
                    Log("ERROR: no advantage screen and no run after " + AdvantageTimeoutSeconds + "s — giving up");
                    state = StateDone;
                    return;
                }
                timer = 0.5f;
            }
        }
        else if (state == StateWaitForLevel)
        {
            string scene = SceneManager.GetActiveScene().name;
            if (scene == "EndProcGen")
            {
                Log("=== VICTORY: EndProcGen reached, " + levelsCompleted + " levels completed ===");
                state = StateDone;
                return;
            }

            if (GameModeController.Instance != null && Map.Instance != null && !GameModeController.Instance.levelFinished)
            {
                totalLevels = ProcGenGameMode.GetTotalLevels();
                if (parkOnly)
                {
                    Log("Parked on level " + ProcGenGameMode.GetLevelNum() + " / " + totalLevels);
                    state = StateDone;
                    return;
                }
                state = gameOverMode ? StateKillPlayers : StateLogAndSkip;
                timer = 1f;
            }
            else
            {
                levelWait += 0.5f;
                if (levelWait >= LevelTimeoutSeconds)
                {
                    Log("ERROR: level never finished loading after " + LevelTimeoutSeconds + "s — giving up. Scene: " + scene);
                    state = StateDone;
                    return;
                }
                timer = 0.5f;
            }
        }
        else if (state == StateLogAndSkip)
        {
            int levelNum = ProcGenGameMode.GetLevelNum();
            Log("--- Level " + levelNum + " / " + totalLevels + " ---");
            LogStatus();

            Log("Skipping...");
            GameModeController.Instance.switchSilently = true;
            GameModeController.LevelFinish(LevelResult.Success);
            GameModeController.MakeFinishInstant();
            levelsCompleted++;

            state = StateWaitForTransition;
            timer = 4f;
        }
        else if (state == StateWaitForTransition)
        {
            string scene = SceneManager.GetActiveScene().name;
            if (scene == "EndProcGen")
            {
                Log("=== VICTORY: EndProcGen reached, " + levelsCompleted + " levels completed ===");
                state = StateDone;
            }
            else if (!ProcGenGameMode.isEnabled)
            {
                Log("ProcGen disabled. Final scene: " + scene);
                state = StateDone;
            }
            else
            {
                state = StateWaitForLevel;
                levelWait = 0f;
                timer = 0.5f;
            }
        }
        else if (state == StateKillPlayers)
        {
            Log("--- Level " + ProcGenGameMode.GetLevelNum() + " / " + totalLevels + " (game-over test) ---");
            LogStatus();

            Log("Setting lives to 0...");
            ProcGenGameMode.SetLives(0);

            var players = HeroController.players;
            if (players != null)
            {
                for (int i = 0; i < players.Length; i++)
                {
                    if (players[i] != null && players[i].character != null)
                    {
                        var hero = players[i].character;
                        Log("Killing player " + i + ": " + hero.GetType().Name);
                        hero.Damage(99, DamageType.Crush, 0f, 0f, 0, null, hero.X, hero.Y);
                    }
                }
            }
            state = StateWaitForGameOver;
            gameOverWait = 0f;
            timer = 3f;
        }
        else if (state == StateWaitForGameOver)
        {
            string scene = SceneManager.GetActiveScene().name;
            if (scene == "EndProcGen")
            {
                Log("=== GAME OVER: EndProcGen reached after death ===");
                state = StateDone;
            }
            else if (!ProcGenGameMode.isEnabled)
            {
                Log("ProcGen disabled. Final scene: " + scene);
                state = StateDone;
            }
            else
            {
                gameOverWait += 1f;
                if (gameOverWait >= GameOverTimeoutSeconds)
                {
                    Log("ERROR: no game over after " + GameOverTimeoutSeconds + "s — giving up. Scene: " + scene);
                    state = StateDone;
                    return;
                }
                Log("Waiting for game over... scene: " + scene);
                timer = 1f;
            }
        }
    }

    public static void Unload() { }
}
