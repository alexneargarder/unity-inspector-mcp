// #name Animation Capture
// #description Sweep a bro through a list of pinned animation states, step each state's frames through ChangeFrame, and write one PNG strip per state plus a capture.json record of the sheet cells the game addressed. Completion is signalled by a "done" file in the output directory; failure by an "error" file.
// #tags animation, sprites, capture, testing
// #args outDir: Directory the game writes strips, capture.json and the done/error sentinel into (created if missing)
// #args statesFile: Path to the JSON state list (lib/animation-capture/states/base-states.json is the shape to follow)
// #args player: Player index whose character is captured (default 0)
// #args box: World-unit half-size of the crop box; each strip cell is 2*box pixels (default 24)
// #args suppress: "false" to let the swept animations fire their real specials and attacks (default true)
// #args claim: The token of the claim capture_animations took for this run, which Main() may replace (default none)

using System.Globalization;
using System.IO;
using Newtonsoft.Json.Linq;

public class AnimationCapture : MonoBehaviour
{
    private const string DoneFile = "done";
    private const string ErrorFile = "error";
    private const string CaptureFile = "capture.json";
    private const string NoPixelFailure = "the character's renderers contributed no pixel to the crop";
    private const string StartupFailure = "animation-capture startup failed: ";
    // Every compile is its own assembly with its own statics
    private const string LiveSlot = "UnityInspector.AnimationCapture.Live";
    private const int MaxChangeFrameDepth = 16;

    // ScriptContext.Logger only carries the [Script:name] prefix while Main()/Unload() is running
    private static Action<string> cachedLogger;
    private static AnimationCapture instance;
    private static string outDir;

    private TestVanDammeAnim character;
    private string sweptName;
    private string respawnError;
    private int playerIndex;
    private JArray states;
    private JObject sweepParams;
    private float box;
    private int cellPx;
    private JObject broDescription;
    private bool captureWriteLogged;

    private readonly JArray stateRecords = new JArray();
    private readonly List<Texture2D> cells = new List<Texture2D>();

    private class BroField
    {
        public MonoBehaviour Owner;
        public FieldInfo Field;
        public object Value;
    }

    private class BroPart
    {
        public Transform Transform;
        public bool Active;
        public int Layer;
        public Vector3 LocalPosition;
        public Quaternion LocalRotation;
        public Vector3 LocalScale;
        public Renderer Renderer;
        public bool RendererEnabled;
        public Material Material;
        public Material MaterialCopy;
        public SpriteSM Sprite;
        public Vector2 Cell;
        public Vector2 CellSize;
        public Vector3 Offset;
        public Color Tint;
        public bool SpriteChanged;
    }

    private readonly List<BroField> broFields = new List<BroField>();
    private readonly List<BroPart> broParts = new List<BroPart>();
    private readonly HashSet<int> broTransforms = new HashSet<int>();
    private readonly List<string> stateNonFinite = new List<string>();
    private bool stateDeltaRepaired;
    private int changeFrameDepth;
    private bool stateRecursed;

    private JArray currentFrames;
    private JObject currentSetup;
    private JArray currentValues;
    private string currentStepField;
    private string currentName;
    private JArray cropCenter;
    private JObject currentStepBefore;
    private JObject currentStepAfter;

    private class Call
    {
        public MethodInfo Method;
        public object[] Args;
    }

    private readonly List<MethodInfo> currentBefore = new List<MethodInfo>();
    private readonly List<MethodInfo> currentAfter = new List<MethodInfo>();
    private readonly List<Call> currentCalls = new List<Call>();
    private bool afterPending;

    private GameObject providedObject;
    private ZipLine providedZipline;

    private SpriteSM trackedBody;
    private SpriteSM trackedGun;
    private string writePhase;
    private string bodyWrite;
    private string gunWrite;

    private readonly List<GameObject> hiddenOverlays = new List<GameObject>();
    private readonly List<ReactionBubble> heldBubbles = new List<ReactionBubble>();
    private readonly List<Vector3> heldBubbleScales = new List<Vector3>();
    private JArray overlapProbe;

    private readonly JArray errors = new JArray();
    private string stateError;
    private string fatal;
    private float savedTimeScale = 1f;
    private bool timeScaleHeld;
    private TestVanDammeAnim facingHeldOn;
    private float savedFacing;
    private readonly List<BoondockBro> heldCompanions = new List<BoondockBro>();
    private readonly List<float> savedCompanionFacings = new List<float>();
    private float? clockDisturbance;
    private int sweepScene;
    private Map sweepMap;
    private string sceneError;

    private int stateIndex = -1;
    private int frameIndex;
    private bool inState;
    private bool awaitingCapture;
    private bool finished;

    private bool stateSawWritten;
    private int stateOnscreenCells;
    private int stateContributedCells;
    private int stateEmptyCells;
    private readonly List<string> failureReasons = new List<string>();
    private readonly Dictionary<string, List<int>> failureFrames = new Dictionary<string, List<int>>();
    private readonly Dictionary<string, int> opaqueByCell = new Dictionary<string, int>();
    private readonly List<string> stateCellProblems = new List<string>();
    private string frameCellProblem;
    private bool sheetReadLogged;
    private bool blankLogged;
    private bool noCameraLogged;

    private readonly HashSet<int> sweepStartObjects = new HashSet<int>();
    private readonly HashSet<int> stateStartObjects = new HashSet<int>();
    private readonly List<Renderer> carriedOver = new List<Renderer>();
    private readonly Dictionary<int, string> spawnedBy = new Dictionary<int, string>();
    private readonly List<string> stateLeaks = new List<string>();
    private readonly List<Effects.IPoolableEffect> requestedEffects = new List<Effects.IPoolableEffect>();
    private readonly List<int> requestedSteps = new List<int>();
    private bool retirePending;
    private JObject retireRecord;
    private bool stateBaselined;
    private bool leakCheckPending;
    private bool stateCropSeen;
    private Vector2 stateCropMin;
    private Vector2 stateCropMax;
    private bool lastCropKnown;
    private Vector3 lastCropCenter;

    private class BlockState
    {
        public int Id;
        public string Name;
        public int Health;
        public bool Destroyed;
        public bool Collapsed;
        public bool Disturbed;
    }

    private class ObjectState
    {
        public string Name;
        public int Health;
        public bool Dead;
        public bool Collapsed;
        public BroforceObject Ref;
    }

    private BlockState[,] foreBlocks;
    private BlockState[,] backBlocks;
    private Dictionary<int, ObjectState> unitStates;
    private Dictionary<int, ObjectState> doodadStates;
    private readonly HashSet<int> sweptIds = new HashSet<int>();

    private readonly List<string> suppressedOrder = new List<string>();
    private readonly Dictionary<string, int> suppressedCalls = new Dictionary<string, int>();
    private readonly List<string> damageOrder = new List<string>();
    private readonly Dictionary<string, int[]> damageCalls = new Dictionary<string, int[]>();

    private RenderTexture captureTexture;
    private RenderTexture contributionTexture;

    private static void Log(string message)
    {
        if (cachedLogger != null) cachedLogger(message);
    }

    private static string Describe(string context, Exception ex)
    {
        Log(context + " threw " + ex);
        string method = ThrowingMethod(ex);
        return context + ": " + ex.Message + (method == null ? "" : " at " + method);
    }

    private static string ThrowingMethod(Exception ex)
    {
        string trace = ex.StackTrace;
        if (string.IsNullOrEmpty(trace)) return null;

        // A frame reads "at void Type.Method(args)" under Harmony's trace format, "at Type.Method (args) [0x0] in <file>:0" under Mono's own, and "at (wrapper kind) Type.Method (args)" for a runtime wrapper
        string line = trace.TrimStart().Split('\n')[0].Trim();
        if (line.StartsWith("at ")) line = line.Substring(3);
        int wrapper = line.StartsWith("(wrapper ") ? line.IndexOf(") ") : -1;
        if (wrapper >= 0) line = line.Substring(wrapper + 2);
        int args = line.IndexOf('(');
        if (args > 0) line = line.Substring(0, args).TrimEnd();
        return line.Substring(line.LastIndexOf(' ') + 1);
    }

    #region Entry points

    public static void Main()
    {
        cachedLogger = ScriptContext.Logger;

        outDir = ScriptContext.GetArg("outDir", "");
        string statesFile = ScriptContext.GetArg("statesFile", "");
        int player = ParseInt(ScriptContext.GetArg("player", "0"), 0);
        float boxSize = ParseFloat(ScriptContext.GetArg("box", "24"), 24f);
        bool suppress = ScriptContext.GetArg("suppress", "true") != "false";
        string claim = ScriptContext.GetArg("claim", "");

        AnimationCapture created = null;
        try
        {
            string running = LiveSweep(claim);
            if (running != null) throw new Exception("another animation-capture sweep, into " + running + ", is running in this game: wait for it to finish");
            if (string.IsNullOrEmpty(outDir)) throw new Exception("outDir is required");

            try
            {
                Directory.CreateDirectory(outDir);
                Discard(Path.Combine(outDir, DoneFile));
                Discard(Path.Combine(outDir, ErrorFile));
            }
            catch (Exception ex)
            {
                throw new Exception("could not prepare " + outDir + ": " + ex.Message);
            }

            if (string.IsNullOrEmpty(statesFile)) throw new Exception("statesFile is required");
            if (player < 0 || player > 3) throw new Exception("player must be 0-3, got " + player);
            if (boxSize < 1f) throw new Exception("box must be at least 1, got " + boxSize);

            JObject parameters;
            JArray stateList = ReadStates(statesFile, out parameters);
            int cellSize = Mathf.Max(1, Mathf.RoundToInt(boxSize * 2f));
            CheckStripSize(stateList, cellSize, boxSize);

            TestVanDammeAnim hero = ResolveCharacter(player);
            string unsweepable = Unsweepable(hero, player);
            if (unsweepable != null) throw new Exception(unsweepable);
            string otherBro = OtherBro(hero, player, parameters == null ? null : StringOf(parameters["bro"]));
            if (otherBro != null) throw new Exception(otherBro);

            GameObject go = new GameObject("AnimationCapture");
            UnityEngine.Object.DontDestroyOnLoad(go);
            ScriptContext.GameObjects.Add(go);

            instance = go.AddComponent<AnimationCapture>();
            created = instance;
            instance.character = hero;
            instance.sweptName = hero.gameObject.name;
            instance.sweptIds.Add(hero.GetInstanceID());
            instance.playerIndex = player;
            instance.states = stateList;
            instance.box = boxSize;
            instance.cellPx = cellSize;
            instance.sweepParams = parameters ?? new JObject();
            instance.sweepParams["allowSideEffects"] = !suppress;
            instance.sweepParams["box"] = boxSize;
            AppDomain.CurrentDomain.SetData(LiveSlot, new object[] { go, outDir });

            SuppressBubbles();
            TrackEffectRequests();
            TrackCellWrites();
            GuardFrozenClock(hero);
            if (suppress) SuppressSideEffects(hero);
            else
            {
                RecordSideEffects();
                Log("Side-effect suppression is off: the swept animations will fire for real");
            }
            instance.Begin();

            Log("Capturing " + stateList.Count + " states from " + hero.GetType().Name + " into " + outDir);
        }
        catch (Exception ex)
        {
            if (created != null) created.Abort();
            Log(StartupFailure + ex.Message);
            WriteError(ex.Message);
            throw new Exception(StartupFailure + ex.Message);
        }
    }

    private static string LiveSweep(string ownClaim)
    {
        object[] live = AppDomain.CurrentDomain.GetData(LiveSlot) as object[];
        string held = null;
        if (live != null && live.Length == 2 && (live[0] as GameObject) != null) held = "" + live[1];
        if (live != null && live.Length == 3 && live[0] is string && live[2] is float && (string)live[0] != ownClaim
            && (float)live[2] > Time.realtimeSinceStartup) held = "" + live[1];
        return held;
    }

    private static string OtherBro(TestVanDammeAnim hero, int player, string requested)
    {
        if (string.IsNullOrEmpty(requested)) return null;
        string current = SwapBrosIntegration.GetLiveBroName(hero);
        if (current != null && string.Equals(current.Trim(), requested.Trim(), StringComparison.OrdinalIgnoreCase)) return null;
        return "player " + player + " holds '" + current + "', not the requested '" + requested + "', so nothing was swept";
    }

    private void ReleaseLiveSlot()
    {
        object[] live = AppDomain.CurrentDomain.GetData(LiveSlot) as object[];
        if (live != null && live.Length == 2 && live[0] as GameObject == gameObject)
        {
            AppDomain.CurrentDomain.SetData(LiveSlot, null);
        }
    }

    private static void CheckStripSize(JArray stateList, int cellSize, float boxSize)
    {
        int frames = 1;
        foreach (JToken token in stateList)
        {
            JObject state = token as JObject;
            JObject step = state == null ? null : state["step"] as JObject;
            JArray values = step == null ? null : step["values"] as JArray;
            if (values != null && values.Count > frames) frames = values.Count;
        }

        int width = frames * (cellSize + 1) - 1;
        int limit = SystemInfo.maxTextureSize;
        if (width > limit || cellSize > limit)
        {
            throw new Exception("box " + boxSize + " makes a " + frames + "-frame strip " + width + " px wide, over this GPU's "
                + limit + " px texture limit: use a smaller box");
        }
    }

    private static string Unsweepable(TestVanDammeAnim hero, int player)
    {
        if (PauseController.pauseStatus != PauseStatus.UnPaused) return "the game is paused (" + PauseController.pauseStatus + ")";
        if (CutsceneController.InCutscene) return "a cutscene is playing";
        if (!hero.IsAlive()) return "player " + player + "'s bro is dead";
        if (hero.pilottedUnit != null) return "player " + player + " is piloting " + hero.pilottedUnit.name;
        if (hero.isOnHelicopter || !hero.enabled || !hero.gameObject.activeInHierarchy)
        {
            return "player " + player + "'s bro has not been released into the level yet (still on the level-start transport): raise settle";
        }
        return null;
    }

    private void Abort()
    {
        finished = true;
        ReleaseTimeScale();
        ReleaseFacing();
        RestoreOverlays();
        ReleaseBubbles();
        ReleaseLiveSlot();
    }

    private static void SuppressBubbles()
    {
        MethodInfo skip = AccessTools.Method(typeof(AnimationCapture), "SkipDuringSweep");
        // ReactionBubble's LateUpdate (CheckScale) and Update rewrite its transform every frame
        Patch(AccessTools.DeclaredMethod(typeof(ReactionBubble), "Update"), skip, "ReactionBubble.Update");
        Patch(AccessTools.DeclaredMethod(typeof(ReactionBubble), "LateUpdate"), skip, "ReactionBubble.LateUpdate");
    }

    private static readonly string[] MapHarm =
    {
        "HitUnits", "HitAllLivingUnits", "HitClosestUnit", "HitDeadUnits", "HitHellUnits", "HitLivingHeroes",
        "HitLivingUnits", "HitUnitsWithArrow", "WhipUnits", "KnockUnits", "KnockMooks", "KnockAndDamageUnit",
        "ExplodeUnits", "FivePointPalmExplodingHeartTechnique", "DecapitateUnits", "HeadShotUnit", "InseminateUnits",
        "StunUnits", "StunMooks", "BlindUnits", "TearGasUnits", "FreezeUnits", "PanicUnits", "BurnUnitsAround_Local",
        "CrushUnitsAgainstWalls", "CrushUnitsAgainstWallsHorizontal", "CrushUnitsAgainstWallsVertical",
        "RollOntoUnits", "HurtWildLife", "BurnBlocksAround", "BurnDamageBlock", "BurnLargeObjects",
        "DamageBackground", "DamageDoodads", "DamageStaticDoodads", "DamageDoodadByTag", "DisturbAlienEggs",
        "DeflectProjectiles"
    };

    private static readonly string[] MapControllerHarm =
    {
        "DamageGround", "DamageGroundLocal", "DamageBlock", "Damage_Local", "Damage_Networked",
        "BurnUnitsAround_NotNetworked", "BurnGround_Local"
    };

    private static void TrackEffectRequests()
    {
        Patch(AccessTools.Method(typeof(Effects.EffectsControllerPool), "Request"), null,
            new HarmonyMethod(AccessTools.Method(typeof(AnimationCapture), "NoteRequest")),
            "EffectsControllerPool.Request");
    }

    private static void NoteRequest(UnityEngine.Object __result)
    {
        if (!SweepLive()) return;
        Effects.IPoolableEffect effect = __result as Effects.IPoolableEffect;
        if (effect == null) return;
        instance.requestedEffects.Add(effect);
        instance.requestedSteps.Add(instance.inState ? instance.frameIndex : -1);
    }

    private static void TrackCellWrites()
    {
        HarmonyMethod note = new HarmonyMethod(AccessTools.Method(typeof(AnimationCapture), "NoteCellWrite"));
        // SpriteSM.SetLowerLeftPixel is the one call that moves a sprite to a sheet cell
        Patch(AccessTools.Method(typeof(SpriteSM), "SetLowerLeftPixel", new Type[] { typeof(Vector2) }), null, note,
            "SpriteSM.SetLowerLeftPixel(Vector2)");
        Patch(AccessTools.Method(typeof(SpriteSM), "SetLowerLeftPixel", new Type[] { typeof(float), typeof(float) }), null, note,
            "SpriteSM.SetLowerLeftPixel(float, float)");
    }

    private static void NoteCellWrite(SpriteSM __instance)
    {
        if (!SweepLive() || instance.writePhase == null) return;
        if (object.ReferenceEquals(__instance, instance.trackedBody)) instance.bodyWrite = instance.writePhase;
        if (object.ReferenceEquals(__instance, instance.trackedGun)) instance.gunWrite = instance.writePhase;
    }

    private static void GuardFrozenClock(TestVanDammeAnim hero)
    {
        HarmonyMethod keepFinite = new HarmonyMethod(AccessTools.Method(typeof(AnimationCapture), "KeepDeltaFinite"));
        Type type = hero.GetType();
        Patch(Declared(AccessTools.Method(type, "SetDeltaTime", Type.EmptyTypes), Type.EmptyTypes), null, keepFinite, "SetDeltaTime");
        Patch(Declared(AccessTools.Method(type, "SetHighFiveBoostDeltaTime", Type.EmptyTypes), Type.EmptyTypes), null, keepFinite, "SetHighFiveBoostDeltaTime");
        Patch(Declared(AccessTools.Method(type, "ChangeFrame", Type.EmptyTypes), Type.EmptyTypes),
            new HarmonyMethod(AccessTools.Method(typeof(AnimationCapture), "EnterChangeFrame")),
            new HarmonyMethod(AccessTools.Method(typeof(AnimationCapture), "LeaveChangeFrame")), "ChangeFrame");
    }

    private static bool EnterChangeFrame(TestVanDammeAnim __instance, out bool __state)
    {
        __state = false;
        if (!SweepLive() || !object.ReferenceEquals(__instance, instance.character)) return true;
        // An Animate method that re-enters ChangeFrame without clearing a flag the state pins never returns, and the stack overflow kills the game
        if (instance.changeFrameDepth >= MaxChangeFrameDepth)
        {
            instance.NoteRecursion();
            return false;
        }
        instance.changeFrameDepth++;
        __state = true;
        return true;
    }

    private static void LeaveChangeFrame(bool __state)
    {
        if (__state && instance != null) instance.changeFrameDepth--;
    }

    private void NoteRecursion()
    {
        if (!inState || stateRecursed) return;
        stateRecursed = true;
        AddStateError("state '" + currentName + "': ChangeFrame re-entered itself " + MaxChangeFrameDepth
            + " levels deep and would have overflowed the stack, so it was cut short and the state stopped at this frame");
    }

    private static void KeepDeltaFinite(TestVanDammeAnim __instance)
    {
        if (!SweepLive() || !object.ReferenceEquals(__instance, instance.character) || Finite(__instance.t)) return;
        // A custom bro's SetDeltaTime dividing by the stopped clock makes t NaN
        __instance.t = 0f;
        instance.stateDeltaRepaired = true;
    }

    private static void SuppressSideEffects(TestVanDammeAnim hero)
    {
        HarmonyMethod mine = new HarmonyMethod(AccessTools.Method(typeof(AnimationCapture), "SkipForCharacter"));
        HarmonyMethod harm = new HarmonyMethod(AccessTools.Method(typeof(AnimationCapture), "SkipHarm"));
        Type type = hero.GetType();
        Type[] twoBools = new Type[] { typeof(bool), typeof(bool) };
        Type[] fourFloats = new Type[] { typeof(float), typeof(float), typeof(float), typeof(float) };

        PatchMine(type, "UseSpecial", Type.EmptyTypes, mine);
        PatchMine(type, "UsePockettedSpecial", Type.EmptyTypes, mine);
        PatchMine(type, "PerformKnifeMeleeAttack", twoBools, mine);
        PatchMine(type, "PerformPunchAttack", twoBools, mine);
        // A pinned airborne state lands every step, stepping on sand and falling blocks underfoot
        PatchMine(type, "Land", Type.EmptyTypes, mine);
        PatchMine(type, "TriggerFlexEvent", Type.EmptyTypes, mine);
        PatchMine(type, "FireWeapon", fourFloats, mine);
        PatchMine(type, "ReleaseHeldObject", new Type[] { typeof(bool) }, mine);

        for (int i = 0; i < MapHarm.Length; i++) PatchOverloads(typeof(Map), MapHarm[i], harm, null);
        for (int i = 0; i < MapControllerHarm.Length; i++) PatchOverloads(typeof(MapController), MapControllerHarm[i], harm, null);

        // Land dereferences the returned wave, so CreateShockWave cannot be skipped and the wave is retired instead
        Type[] threeFloats = new Type[] { typeof(float), typeof(float), typeof(float) };
        Patch(AccessTools.Method(typeof(EffectsController), "CreateShockWave", threeFloats), null,
            new HarmonyMethod(AccessTools.Method(typeof(AnimationCapture), "RetireDuringSweep")),
            "EffectsController.CreateShockWave");
    }

    private static void RecordSideEffects()
    {
        HarmonyMethod voids = new HarmonyMethod(AccessTools.Method(typeof(AnimationCapture), "NoteDamageCall"));
        HarmonyMethod results = new HarmonyMethod(AccessTools.Method(typeof(AnimationCapture), "NoteDamageResult"));
        for (int i = 0; i < MapHarm.Length; i++) PatchOverloads(typeof(Map), MapHarm[i], null, new HarmonyMethod[] { voids, results });
        for (int i = 0; i < MapControllerHarm.Length; i++) PatchOverloads(typeof(MapController), MapControllerHarm[i], null, new HarmonyMethod[] { voids, results });
    }

    private static void PatchMine(Type type, string name, Type[] parameters, HarmonyMethod prefix)
    {
        Patch(Declared(AccessTools.Method(type, name, parameters), parameters), prefix, null, name);
    }

    private static void RetireDuringSweep(ExplosionGroundWave __result)
    {
        if (__result == null || !SweepLive()) return;
        __result.EffectDie();
    }

    private static void PatchOverloads(Type type, string name, HarmonyMethod prefix, HarmonyMethod[] postfixes)
    {
        MethodInfo[] methods = type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                                               | BindingFlags.Instance | BindingFlags.DeclaredOnly);
        int found = 0;

        for (int i = 0; i < methods.Length; i++)
        {
            if (methods[i].Name != name || methods[i].IsGenericMethodDefinition) continue;
            found++;
            HarmonyMethod postfix = postfixes == null ? null : postfixes[methods[i].ReturnType == typeof(void) ? 0 : 1];
            Patch(methods[i], prefix, postfix, type.Name + "." + name + "/" + methods[i].GetParameters().Length);
        }

        if (found == 0) Log("Not suppressing " + type.Name + "." + name + ": no such method on this build");
    }

    // Harmony refuses a MethodInfo it was handed off a derived type that only inherits it, so the
    // lookup is re-anchored on the type that declares the implementation this instance would run.
    private static MethodInfo Declared(MethodInfo target, Type[] parameters)
    {
        if (target == null || target.DeclaringType == target.ReflectedType) return target;
        return AccessTools.DeclaredMethod(target.DeclaringType, target.Name, parameters);
    }

    private static void Patch(MethodInfo target, MethodInfo prefix, string label)
    {
        Patch(target, new HarmonyMethod(prefix), null, label);
    }

    private static void Patch(MethodInfo target, HarmonyMethod prefix, HarmonyMethod postfix, string label)
    {
        if (target == null)
        {
            Log("Not patching " + label + ": no such method on this build");
            return;
        }

        try
        {
            ScriptContext.Harmony.Patch(target, prefix, postfix);
        }
        catch (Exception ex)
        {
            Log("Could not patch " + label + ": " + ex.Message);
        }
    }

    private static bool SkipDuringSweep()
    {
        // Harmony reads a prefix's return value as "run the original"
        return !SweepLive();
    }

    private static bool SkipHarm(MethodBase __originalMethod)
    {
        if (!SweepLive()) return true;
        instance.NoteSuppressed(__originalMethod);
        return false;
    }

    private static bool SkipForCharacter(object __instance, MethodBase __originalMethod)
    {
        if (!SweepLive() || !object.ReferenceEquals(__instance, instance.character)) return true;
        instance.NoteSuppressed(__originalMethod);
        return false;
    }

    private static void NoteDamageCall(MethodBase __originalMethod)
    {
        if (SweepLive()) instance.NoteDamage(__originalMethod, null);
    }

    private static void NoteDamageResult(MethodBase __originalMethod, object __result)
    {
        if (SweepLive()) instance.NoteDamage(__originalMethod, __result);
    }

    private static string MethodLabel(MethodBase method)
    {
        return method.DeclaringType.Name + "." + method.Name;
    }

    private void NoteSuppressed(MethodBase method)
    {
        string key = MethodLabel(method);
        int count;
        if (!suppressedCalls.TryGetValue(key, out count)) suppressedOrder.Add(key);
        suppressedCalls[key] = count + 1;
    }

    private void NoteDamage(MethodBase method, object result)
    {
        string key = MethodLabel(method);
        int[] tally;
        if (!damageCalls.TryGetValue(key, out tally))
        {
            tally = new int[] { 0, 0, 0 };
            damageCalls[key] = tally;
            damageOrder.Add(key);
        }
        tally[0]++;
        if (result is bool)
        {
            tally[2] = 1;
            if ((bool)result) tally[1]++;
        }
    }

    private static bool SweepLive()
    {
        return instance != null && !instance.finished;
    }

    public static void Unload()
    {
        if (instance == null) return;

        bool interrupted = !instance.finished;
        instance.finished = true;
        instance.ReleaseTimeScale();
        if (interrupted) instance.RestoreBro();
        instance.RunAfter(null);
        instance.DestroyProvided();
        if (interrupted) instance.RestoreBro();
        instance.ReleaseFacing();
        instance.RestoreOverlays();
        instance.ReleaseBubbles();
        instance.DisposeCells();
        instance.ReleaseCaptureTexture();
        instance.ReleaseLiveSlot();
        if (interrupted) instance.WriteCapture(false);
        instance = null;
    }

    #endregion

    #region Sweep

    // The script compiler cannot emit iterator methods, so the sweep is an Update-driven state
    // machine: Update pins one step and LateUpdate reads it back on that same frame.
    private void Begin()
    {
        // The sweep freezes the clock itself. A caller that already froze the game would otherwise
        // have us "restore" 0 and leave it frozen, so treat a stopped clock as normal speed.
        savedTimeScale = Time.timeScale > 0f ? Time.timeScale : 1f;
        timeScaleHeld = true;
        Time.timeScale = 0f;
        sweepScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetHashCode();
        sweepMap = Map.Instance;
        HideOverlays();
        HoldBubbles();
        HoldFacing();
        SnapshotBro();

        SpriteSM body = GetSprite();
        Vector3 center = CropCenterOf(body);
        cropCenter = Vec(center);
        string intruder = ProbeOverlaps(body, center);
        if (intruder != null)
        {
            throw new Exception("the previous bro '" + intruder + "', recalled by the swap, is still drawn in the capture "
                + "crop and the sweep would strip it: raise swapSettle or wait for it to be destroyed");
        }

        RecordObjects(sweepStartObjects);
        SnapshotLevel(out foreBlocks, out backBlocks, out unitStates, out doodadStates);
        broDescription = DescribeBro();
        WriteCapture(false);
    }

    private void HoldBubbles()
    {
        try
        {
            ReactionBubble[] bubbles = UnityEngine.Object.FindObjectsOfType<ReactionBubble>();

            for (int i = 0; i < bubbles.Length; i++)
            {
                ReactionBubble bubble = bubbles[i];
                if (bubble == null || heldBubbles.Contains(bubble)) continue;

                heldBubbles.Add(bubble);
                heldBubbleScales.Add(bubble.transform.localScale);
                // The game puts a bubble's GameObject and renderer back within a frame
                // A zero localScale is the one hold nothing undoes: ReactionBubble.CheckScale only ever flips the sign of the x scale it finds
                bubble.transform.localScale = Vector3.zero;
            }
        }
        catch (Exception ex)
        {
            Log("Could not hold the reaction bubbles: " + ex.Message);
        }
    }

    private void ReleaseBubbles()
    {
        for (int i = 0; i < heldBubbles.Count; i++)
        {
            if (heldBubbles[i] != null) heldBubbles[i].transform.localScale = heldBubbleScales[i];
        }
        heldBubbles.Clear();
        heldBubbleScales.Clear();
    }

    // The floating lives/grenades gear is parented straight to the character (Player.cs:798-802) and
    // would land in the middle of every crop. It is the only hero-parented HUD the decompiled source
    // exposes; anything else drawing inside the crop shows up in the bro block's overlapProbe.
    private void HideOverlays()
    {
        try
        {
            if (HeroController.players == null || HeroController.players.Length <= playerIndex) return;

            Player slot = HeroController.players[playerIndex];
            if (slot == null || slot.deathMatchHUD == null) return;

            GameObject go = slot.deathMatchHUD.gameObject;
            if (!go.activeSelf) return;

            go.SetActive(false);
            hiddenOverlays.Add(go);
        }
        catch (Exception ex)
        {
            Log("Could not hide the hero overlays: " + ex.Message);
        }
    }

    private void RestoreOverlays()
    {
        for (int i = 0; i < hiddenOverlays.Count; i++)
        {
            if (hiddenOverlays[i] != null) hiddenOverlays[i].SetActive(true);
        }
        hiddenOverlays.Clear();
    }

    private string ProbeOverlaps(SpriteSM body, Vector3 center)
    {
        overlapProbe = new JArray();
        string intruder = null;

        try
        {
            GameObject bodyGo = body == null ? null : body.gameObject;
            GameObject gunGo = character.gunSprite == null ? null : character.gunSprite.gameObject;
            Renderer[] all = UnityEngine.Object.FindObjectsOfType<Renderer>();

            for (int i = 0; i < all.Length; i++)
            {
                Renderer r = all[i];
                if (r == null || !r.enabled || r.gameObject == bodyGo || r.gameObject == gunGo) continue;

                Bounds bounds = r.bounds;
                if (Mathf.Abs(bounds.center.x - center.x) > box + bounds.extents.x) continue;
                if (Mathf.Abs(bounds.center.y - center.y) > box + bounds.extents.y) continue;

                if (intruder == null) intruder = RecalledRigOf(r);
                if (overlapProbe.Count >= 24) continue;

                JObject entry = new JObject();
                entry["path"] = PathOf(r.transform);
                entry["renderer"] = r.GetType().Name;
                entry["components"] = ComponentsOf(r.gameObject);
                entry["center"] = Vec(bounds.center);
                overlapProbe.Add(entry);
            }
        }
        catch (Exception ex)
        {
            Log("Overlap probe failed: " + ex.Message);
        }
        return intruder;
    }

    private string RecalledRigOf(Renderer r)
    {
        Vector3 scale = r.transform.lossyScale;
        if (scale.x == 0f || scale.y == 0f) return null;

        for (Transform t = r.transform; t != null; t = t.parent)
        {
            TestVanDammeAnim rig = t.GetComponent<TestVanDammeAnim>();
            if (rig == null) continue;
            if (rig == character) return null;

            FieldInfo recalling = AccessTools.Field(typeof(TestVanDammeAnim), "recalling");
            // The rig a swap leaves behind is the recalled one (TestVanDammeAnim.RecallBro)
            bool recalled = rig.actionState == ActionState.Recalling
                || (recalling != null && (bool)recalling.GetValue(rig));
            return recalled ? rig.gameObject.name : null;
        }
        return null;
    }

    private static string PathOf(Transform transform)
    {
        string path = transform.name;
        Transform parent = transform.parent;
        for (int depth = 0; parent != null && depth < 4; depth++)
        {
            path = parent.name + "/" + path;
            parent = parent.parent;
        }
        return path;
    }

    private static JArray ComponentsOf(GameObject go)
    {
        JArray names = new JArray();
        Component[] components = go.GetComponents<Component>();
        for (int i = 0; i < components.Length; i++)
        {
            if (components[i] != null) names.Add(components[i].GetType().Name);
        }
        return names;
    }

    private void CheckClock()
    {
        // Game code sets the clock too: a time-stop ramping back, a pause toggle, a cutscene
        if (!timeScaleHeld || Time.timeScale == 0f) return;

        float seen = Time.timeScale;
        Time.timeScale = 0f;
        if (!clockDisturbance.HasValue)
        {
            clockDisturbance = seen;
            Log("The game set the clock to " + seen.ToString(CultureInfo.InvariantCulture) + " during the sweep; it was put back to 0");
        }
    }

    private void CheckScene()
    {
        if (sceneError != null) return;
        if (UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetHashCode() == sweepScene && Map.Instance == sweepMap) return;

        sceneError = "the scene changed during the sweep (a level load or restart), so the remaining states were not swept";
        Log(sceneError);
        if (inState && stateError == null) stateError = "state '" + currentName + "': " + sceneError;
    }

    private void Update()
    {
        if (finished) return;
        CheckClock();
        CheckScene();
        RepairNonFinite();
        changeFrameDepth = 0;
        if (awaitingCapture) return;

        if (!inState)
        {
            if (retirePending)
            {
                retirePending = false;
                RetireStateObjects(retireRecord);
                retireRecord = null;
            }

            stateIndex++;
            if (stateIndex >= states.Count)
            {
                finished = true;
                Finish();
                return;
            }

            stateError = null;
            stateBaselined = false;
            leakCheckPending = false;
            stateLeaks.Clear();
            // Both are idempotent, and a respawn mid-sweep brings a fresh HUDHeadGear
            // (Player.SetUpDeathMatchHUD) and can spawn new bubbles
            HideOverlays();
            HoldBubbles();

            if (!RefreshCharacter())
            {
                currentName = NameOf(states[stateIndex] as JObject);
                currentFrames = new JArray();
                FinishFailedState();
                return;
            }

            if (!BeginState(states[stateIndex] as JObject))
            {
                if (stateError != null) FinishFailedState();
                return;
            }

            inState = true;
            frameIndex = 0;
            BaselineState();
            EnterState();
        }

        if (frameIndex >= currentValues.Count || stateError != null)
        {
            EndState();
            inState = false;
            return;
        }

        if (!ApplyStep(frameIndex))
        {
            EndState();
            inState = false;
            return;
        }

        awaitingCapture = true;
    }

    // The step Update() pinned is read back at the end of the same frame. Nothing waits on the game
    // presenting anything: RecordStep renders the cameras itself, which is also why this is not in
    // OnGUI — driving a render from inside IMGUI's repaint is the one place Unity refuses it.
    private void LateUpdate()
    {
        if (finished)
        {
            awaitingCapture = false;
            return;
        }
        CheckClock();
        RepairNonFinite();
        if (!awaitingCapture) return;

        awaitingCapture = false;
        TurnCompanions();
        RecordStep(frameIndex);
        frameIndex++;
    }

    private void OnDestroy()
    {
        ReleaseCaptureTexture();
        DisposeCells();
        DestroyProvided();
        ReleaseBroSnapshot();
    }

    private bool RefreshCharacter()
    {
        if (sceneError != null)
        {
            stateError = "state '" + NameOf(states[stateIndex] as JObject) + "': " + sceneError;
            return false;
        }
        if (respawnError != null)
        {
            stateError = respawnError;
            return false;
        }
        // A destroyed Unity object compares equal to null: a swap mid-sweep (HeroController.ChangeBro) destroys the character and spawns his replacement in the same call
        if (character != null) return true;

        try
        {
            TestVanDammeAnim resolved = ResolveCharacter(playerIndex);
            string resolvedName = resolved.gameObject.name;
            if (resolvedName != sweptName)
            {
                respawnError = "player " + playerIndex + " respawned as '" + resolvedName + "', not the swept '"
                    + sweptName + "', so the remaining states were not swept";
                Log(respawnError);
                stateError = respawnError;
                return false;
            }

            character = resolved;
            SnapshotBro();
            sweptIds.Add(resolved.GetInstanceID());
            Log("Re-resolved the character after it was destroyed");
            return true;
        }
        catch (Exception ex)
        {
            stateError = Describe("no character for player " + playerIndex, ex);
            return false;
        }
    }

    private static string NameOf(JObject state)
    {
        string name = state == null ? null : StringOf(state["name"]);
        return string.IsNullOrEmpty(name) ? "<unnamed>" : name;
    }

    private bool BeginState(JObject state)
    {
        try
        {
            currentName = "<unnamed>";
            currentFrames = new JArray();
            cells.Clear();
            stateRecursed = false;
            stateSawWritten = false;
            stateOnscreenCells = 0;
            stateContributedCells = 0;
            stateEmptyCells = 0;
            failureReasons.Clear();
            failureFrames.Clear();
            stateCellProblems.Clear();

            if (state == null) throw new Exception("state list holds a non-object entry");

            currentName = StringOf(state["name"]);
            if (string.IsNullOrEmpty(currentName)) throw new Exception("state entry has no name");

            string unsupported = StringOf(state["unsupported"]);
            if (!string.IsNullOrEmpty(unsupported))
            {
                Skip("unsupported: " + unsupported);
                return false;
            }

            string unmet = CheckRequires(state["requires"] as JObject);
            if (unmet != null)
            {
                Skip("requires not met: " + unmet);
                return false;
            }

            currentSetup = state["setup"] as JObject;
            JObject step = state["step"] as JObject;
            if (step == null) throw new Exception("state '" + currentName + "' has no step block");

            currentStepField = StringOf(step["field"]);
            if (string.IsNullOrEmpty(currentStepField)) currentStepField = "frame";

            currentValues = step["values"] as JArray;
            if (currentValues == null || currentValues.Count == 0)
                throw new Exception("state '" + currentName + "' has no step values");

            currentStepBefore = step["before"] as JObject;
            currentStepAfter = step["after"] as JObject;

            Provide(StringOf(state["provide"]));

            // Resolved before anything is pinned, so a state that names a method the character does
            // not have errors without having touched the bro
            currentBefore.Clear();
            currentAfter.Clear();
            currentCalls.Clear();
            afterPending = false;
            ResolveMethods(state["before"], "before", currentBefore);
            ResolveMethods(state["after"], "after", currentAfter);
            ResolveCalls(step["call"]);

            RequireField(currentStepField);
            RequireFields(currentSetup);
            RequireFields(currentStepBefore);
            RequireFields(currentStepAfter);

            return true;
        }
        catch (Exception ex)
        {
            stateError = Describe("state '" + currentName + "'", ex);
            return false;
        }
    }

    private void Provide(string kind)
    {
        if (string.IsNullOrEmpty(kind)) return;

        Vector3 at = character.transform.position;
        if (kind == "zipline")
        {
            GameObject go = new GameObject("AnimationCapture ZipLine");
            // An inactive ZipLine never runs its Start or Update
            go.SetActive(false);
            providedObject = go;
            ZipLine zipline = go.AddComponent<ZipLine>();
            zipline.fromAnchorPoint = at + new Vector3(-64f, 24f, 0f);
            zipline.toAnchorPoint = at + new Vector3(64f, 24f, 0f);
            zipline.attachedUnits = new List<Unit>();
            zipline.ziplineProgress = new List<float>();
            zipline.ziplineDirection = new List<float>();
            zipline.hangingObjects = new WashingLineHangingItem[0];
            providedZipline = zipline;
            return;
        }
        if (kind == "ladder")
        {
            // IsNearbyLadder probes a 4-unit sphere at (X ± 6, Y + 22) on the Ladders layer; the box starts 16 units up, above the downward ground and ladder-top rays cast from Y + 5 and Y + 14
            GameObject go = new GameObject("AnimationCapture Ladder");
            go.layer = LayerMask.NameToLayer("Ladders");
            go.transform.position = at + new Vector3(0f, 28f, 0f);
            providedObject = go;
            BoxCollider collider = go.AddComponent<BoxCollider>();
            collider.size = new Vector3(24f, 24f, 16f);
            return;
        }
        throw new Exception("provide names '" + kind + "', not zipline or ladder");
    }

    private void DestroyProvided()
    {
        if (providedObject != null) UnityEngine.Object.Destroy(providedObject);
        providedObject = null;
        providedZipline = null;
    }

    // Some states are only reachable by calling a method on the character, because the method swaps
    // an object reference no field pin can express. before runs on the pinned fields, so a method
    // that copies one field into another reads the state's values and not the bro's own.
    private void EnterState()
    {
        try
        {
            ApplySetup();
        }
        catch (Exception ex)
        {
            // Nothing has been called yet, so there is nothing for after to undo: running it here
            // would hand a reverse method a character its forward method never touched
            stateError = Describe("state '" + currentName + "' setup", ex);
            return;
        }

        // From here on the state may have switched the bro, so its after list runs on every exit: a
        // clean finish, a step that threw, a before that threw, or an unload mid-sweep.
        afterPending = true;

        for (int i = 0; i < currentBefore.Count; i++)
        {
            string problem = CallOnCharacter(currentBefore[i], null, "before");
            if (problem == null) continue;

            // The state has errored and the rest of the list would run on a half-entered character
            AddStateError(problem);
            return;
        }
    }

    // after undoes what before did, so it is best-effort and its failures stay out of stateError: a
    // state that captured its frames stays captured even when its teardown went wrong. The record is
    // already in the report by now, so the message rides along on it instead.
    private void RunAfter(JObject record)
    {
        if (!afterPending) return;
        afterPending = false;
        if (character == null) return;

        string problems = null;
        for (int i = 0; i < currentAfter.Count; i++)
        {
            string problem = CallOnCharacter(currentAfter[i], null, "after");
            if (problem == null) continue;
            problems = problems == null ? problem : problems + "; " + problem;
        }

        if (problems == null) return;
        if (record != null) record["afterError"] = problems;
        errors.Add(problems);
    }

    // Returns the failure message, or null: the caller decides where it belongs. Not named Invoke,
    // which would hide MonoBehaviour's own Invoke overloads.
    private string CallOnCharacter(MethodInfo method, object[] args, string phase)
    {
        try
        {
            method.Invoke(character, args);
            return null;
        }
        catch (Exception ex)
        {
            Exception cause = ex is TargetInvocationException && ex.InnerException != null
                ? ex.InnerException
                : ex;
            return Describe("state '" + currentName + "' " + phase + " " + method.Name, cause);
        }
    }

    private void AddStateError(string message)
    {
        stateError = stateError == null ? message : stateError + "; " + message;
    }

    // Setup is re-applied before every step: several animations clear their own driving flag
    // partway through their column span (throwing at frame 3, high five, the specials).
    private bool ApplyStep(int index)
    {
        try
        {
            trackedBody = GetSprite();
            trackedGun = character.gunSprite;
            bodyWrite = null;
            gunWrite = null;
            writePhase = "capture";

            ApplySetup();
            SetField(currentStepField, currentValues[index]);
            character.ForceChangeFrame();

            if (currentCalls.Count > 0)
            {
                ApplyPins(currentStepBefore);
                for (int i = 0; i < currentCalls.Count; i++)
                {
                    string problem = CallOnCharacter(currentCalls[i].Method, currentCalls[i].Args, "step call");
                    if (problem == null) continue;
                    writePhase = null;
                    stateError = "state '" + currentName + "' step " + index + ": " + problem;
                    return false;
                }
                ApplyPins(currentStepAfter);
            }

            writePhase = "game";
            return true;
        }
        catch (Exception ex)
        {
            writePhase = null;
            stateError = Describe("state '" + currentName + "' step " + index, ex);
            return false;
        }
    }

    private bool RecordStep(int index)
    {
        try
        {
            JObject frame = new JObject();
            frame["step"] = currentValues[index].DeepClone();

            Vector3 center = CropCenterOf(GetSprite());
            NoteCrop(center);
            if (leakCheckPending)
            {
                leakCheckPending = false;
                CheckLeaks(center);
            }

            bool offscreen;
            string contributionFailure;
            cells.Add(Crop(center, out offscreen, out contributionFailure));
            if (offscreen) frame["offscreen"] = true;
            else stateOnscreenCells++;

            SpriteSM body = GetSprite();
            JObject bodyCell = CellOf(body, body == null ? null : MaterialOf(body));
            if (body != null) bodyCell["written"] = bodyWrite ?? "carried";
            frame["body"] = bodyCell;

            SpriteSM gun = character.gunSprite;
            bool gunActive = gun != null && gun.gameObject.activeInHierarchy;
            if (gun == null)
            {
                frame["gun"] = JValue.CreateNull();
            }
            else
            {
                JObject gunCell = CellOf(gun, MaterialOf(gun));
                gunCell["enabled"] = gunActive;
                gunCell["written"] = gunWrite ?? "carried";
                frame["gun"] = gunCell;
            }

            FieldInfo gunFrame = ResolveField("gunFrame");
            if (gunFrame != null) frame["gunFrame"] = JToken.FromObject(gunFrame.GetValue(character));

            if (!offscreen)
            {
                frameCellProblem = null;
                bool? bodyEmpty = CellEmpty(body);
                bool? gunEmpty = gunActive ? CellEmpty(gun) : null;
                if (bodyEmpty.HasValue) frame["bodyCellEmpty"] = bodyEmpty.Value;
                if (gunEmpty.HasValue) frame["gunCellEmpty"] = gunEmpty.Value;
                RecordContribution(frame, index, contributionFailure, bodyEmpty, gunActive ? gunEmpty : (bool?)true);
            }

            frame["scaleX"] = character.transform.localScale.x;

            Vector3 offset = body == null ? Vector3.zero : body.offset;
            JArray offsetArray = new JArray();
            offsetArray.Add(offset.x);
            offsetArray.Add(offset.y);
            frame["offset"] = offsetArray;

            currentFrames.Add(frame);
            return true;
        }
        catch (Exception ex)
        {
            stateError = Describe("state '" + currentName + "' frame " + index, ex);
            return false;
        }
        finally
        {
            writePhase = null;
        }
    }

    private void RecordContribution(JObject frame, int index, string failure, bool? bodyEmpty, bool? gunEmpty)
    {
        frame["contributed"] = failure == null;
        if (failure == null)
        {
            stateContributedCells++;
            return;
        }

        if (failure == NoPixelFailure && bodyEmpty.HasValue && gunEmpty.HasValue)
        {
            bool empty = bodyEmpty.Value && gunEmpty.Value;
            frame["cellEmpty"] = empty;
            if (empty)
            {
                stateEmptyCells++;
                return;
            }
        }

        List<int> frames;
        if (!failureFrames.TryGetValue(failure, out frames))
        {
            frames = new List<int>();
            failureFrames[failure] = frames;
            failureReasons.Add(failure);
        }
        frames.Add(index);
        if (failure == NoPixelFailure && frameCellProblem != null && !stateCellProblems.Contains(frameCellProblem))
        {
            stateCellProblems.Add(frameCellProblem);
        }
    }

    private bool? CellEmpty(SpriteSM sprite)
    {
        if (sprite == null) return null;

        try
        {
            return OpaqueInCell(sprite) == 0;
        }
        catch (Exception ex)
        {
            frameCellProblem = frameCellProblem ?? ex.Message;
            if (!sheetReadLogged)
            {
                sheetReadLogged = true;
                Log("Could not read a sprite sheet to classify a frame's cell: " + ex.Message);
            }
            return null;
        }
    }

    private int OpaqueInCell(SpriteSM sprite)
    {
        Material material = MaterialOf(sprite);
        Texture texture = material == null ? null : material.mainTexture;
        if (texture == null) throw new Exception(sprite.name + " has no sheet texture");

        int x = Mathf.RoundToInt(sprite.lowerLeftPixel.x);
        // lowerLeftPixel counts y down from the sheet's top; the readback counts up from its bottom
        int y = texture.height - Mathf.RoundToInt(sprite.lowerLeftPixel.y);
        int w = Mathf.RoundToInt(sprite.pixelDimensions.x);
        int h = Mathf.RoundToInt(sprite.pixelDimensions.y);

        string key = texture.GetInstanceID() + ":" + x + ":" + y + ":" + w + ":" + h;
        int cached;
        if (opaqueByCell.TryGetValue(key, out cached)) return cached;

        int left = Mathf.Clamp(x, 0, texture.width);
        int bottom = Mathf.Clamp(y, 0, texture.height);
        int width = Mathf.Clamp(x + w, 0, texture.width) - left;
        int height = Mathf.Clamp(y + h, 0, texture.height) - bottom;
        if (width <= 0 || height <= 0)
        {
            throw new Exception("cell " + w + "x" + h + " at " + x + "," + Mathf.RoundToInt(sprite.lowerLeftPixel.y) + " lies outside the "
                + texture.width + "x" + texture.height + " sheet '" + texture.name + "'");
        }

        // Blit leaves its target active, so the caller's active texture is put back here
        RenderTexture previousActive = RenderTexture.active;
        RenderTexture sheet = new RenderTexture(texture.width, texture.height, 0, RenderTextureFormat.ARGB32);
        int opaque = 0;

        try
        {
            sheet.Create();
            // The sheet is not CPU-readable, so it is read back through a render texture
            Graphics.Blit(texture, sheet);
            Color32[] pixels = ReadRegion(sheet, left, bottom, width, height);
            for (int i = 0; i < pixels.Length; i++)
            {
                if (pixels[i].a != 0) opaque++;
            }
        }
        finally
        {
            RenderTexture.active = previousActive;
            ReleaseTexture(sheet);
        }

        opaqueByCell[key] = opaque;
        return opaque;
    }

    private void EndState()
    {
        JObject record = null;

        try
        {
            NoteBlankCapture();
            NoteContribution();
            for (int i = 0; i < stateLeaks.Count; i++) AddStateError(stateLeaks[i]);
            RestoreBro();

            // Recorded before the strip is written: a failed PNG write must still leave the state
            // in the report, carrying the error, rather than dropping it entirely
            record = new JObject();
            record["name"] = currentName;
            record["frames"] = currentFrames;
            record["skipped"] = stateError == null ? JValue.CreateNull() : new JValue("error: " + stateError);
            stateRecords.Add(record);

            if (cells.Count > 0) WriteStrip(currentName);
        }
        catch (Exception ex)
        {
            string failure = Describe("state '" + currentName + "' teardown", ex);
            if (stateError == null) stateError = failure;
            if (record != null) record["skipped"] = new JValue("error: " + stateError);
        }
        finally
        {
            if (stateError != null) errors.Add(stateError);
            DisposeCells();
        }

        // Last, on the filed record: a reverse method that throws is a teardown problem, not a
        // reason to unmake a state whose frames are already captured and compared
        RunAfter(record);
        DestroyProvided();
        RestoreBro();

        retirePending = true;
        retireRecord = record;
    }

    // A crop that was inside the screen and still read back as zeroed memory captured nothing, so it
    // is reported as the state's error rather than passing as a strip of empty cells. The readback
    // path is the thing that fails this way; the cameras themselves render regardless.
    private void NoteBlankCapture()
    {
        if (stateOnscreenCells == 0 || stateSawWritten) return;

        AddStateError("state '" + currentName + "' blank capture: every pixel of the strip read back as zero");

        if (blankLogged) return;
        blankLogged = true;
        Log("Blank capture on '" + currentName + "': the crop is inside the screen but the pixels read "
            + "back are zeroed memory. The cameras rendered nothing into the capture texture.");
    }

    private void NoteContribution()
    {
        if (stateOnscreenCells == 0) return;

        Log("state '" + currentName + "': " + stateContributedCells + "/" + stateOnscreenCells
            + " on-screen frames contributed");
        if (stateEmptyCells > 0)
        {
            Log("state '" + currentName + "': " + stateEmptyCells + " frames address empty sheet cells");
        }
        if (!stateSawWritten) return;
        for (int i = 0; i < failureReasons.Count; i++)
        {
            List<int> frames = failureFrames[failureReasons[i]];
            string message = "state '" + currentName + "': " + failureReasons[i] + " on " + frames.Count + "/"
                + stateOnscreenCells + " on-screen frames (frames " + Ranges(frames) + ")";
            if (failureReasons[i] == NoPixelFailure && stateCellProblems.Count > 0)
            {
                message += ": " + stateCellProblems[0] + (stateCellProblems.Count > 1 ? " (and " + (stateCellProblems.Count - 1) + " more)" : "");
            }
            Log(message);
            AddStateError(message);
        }
    }

    // BeginState failed before the frame loop: keep its snapshot restored and log the state as errored
    private void FinishFailedState()
    {
        RestoreBro();
        DisposeCells();
        DestroyProvided();

        JObject record = new JObject();
        record["name"] = currentName;
        record["skipped"] = new JValue("error: " + stateError);
        record["frames"] = currentFrames;
        stateRecords.Add(record);
        errors.Add(stateError);
        AttachLevelState(record, true);
    }

    private void Skip(string reason)
    {
        JObject record = new JObject();
        record["name"] = currentName;
        record["skipped"] = reason;
        record["frames"] = new JArray();
        stateRecords.Add(record);
        AttachLevelState(record, true);
    }

    private void Finish()
    {
        // First, and before anything that could throw: a later restore failing must never be able
        // to leave the game frozen
        ReleaseTimeScale();
        ReleaseFacing();
        RestoreOverlays();
        ReleaseBubbles();
        ReleaseCaptureTexture();
        ReleaseLiveSlot();

        if (!WriteCapture(true)) fatal = fatal ?? "writing " + CaptureFile + " failed";

        if (fatal != null)
        {
            WriteError(fatal);
            return;
        }

        try
        {
            File.WriteAllText(Path.Combine(outDir, DoneFile), "");
            Log("Capture complete: " + stateRecords.Count + " states, " + errors.Count + " errored");
        }
        catch (Exception ex)
        {
            Log("Could not write the done sentinel: " + ex.Message);
        }
    }

    private bool WriteCapture(bool complete)
    {
        try
        {
            JObject doc = new JObject();
            doc["params"] = sweepParams;
            doc["complete"] = complete;
            doc["bro"] = broDescription;
            doc["states"] = stateRecords;
            doc["errors"] = errors;
            File.WriteAllText(Path.Combine(outDir, CaptureFile), doc.ToString());
            return true;
        }
        catch (Exception ex)
        {
            if (complete) fatal = "writing " + CaptureFile + ": " + ex.Message;
            if (!captureWriteLogged)
            {
                captureWriteLogged = true;
                Log("Could not write " + CaptureFile + ": " + ex.Message);
            }
            return false;
        }
    }

    private void AttachLevelState(JObject record, bool write)
    {
        if (sceneError != null)
        {
            record["levelChanges"] = EmptyChanges();
            record["sceneChanged"] = true;
        }
        else
        {
            record["levelChanges"] = DiffLevel();
        }

        record["suppressed"] = CallList(suppressedOrder, suppressedCalls, null);
        record["damageCalls"] = CallList(damageOrder, null, damageCalls);
        suppressedOrder.Clear();
        suppressedCalls.Clear();
        damageOrder.Clear();
        damageCalls.Clear();

        if (clockDisturbance.HasValue)
        {
            float seen = clockDisturbance.Value;
            clockDisturbance = null;
            record["clockDisturbed"] = seen;
            string message = "state '" + StringOf(record["name"]) + "': the game set the clock to "
                + seen.ToString(CultureInfo.InvariantCulture) + " while it ran, so the game moved between its frames";
            errors.Add(message);
        }

        if (stateDeltaRepaired)
        {
            stateDeltaRepaired = false;
            record["deltaRepaired"] = true;
        }

        if (stateNonFinite.Count > 0)
        {
            JArray names = new JArray();
            for (int i = 0; i < stateNonFinite.Count; i++) names.Add(stateNonFinite[i]);
            record["nonFinite"] = names;
            string message = "state '" + StringOf(record["name"]) + "': " + string.Join(", ", stateNonFinite.ToArray())
                + " went non-finite on the frozen clock and " + (stateNonFinite.Count == 1 ? "was" : "were")
                + " put back, so this state's frames are not to be trusted";
            Log(message);
            errors.Add(message);
            stateNonFinite.Clear();
        }

        if (write) WriteCapture(false);
    }

    private static JArray CallList(List<string> order, Dictionary<string, int> counts, Dictionary<string, int[]> tallies)
    {
        JArray list = new JArray();
        for (int i = 0; i < order.Count; i++)
        {
            JObject entry = new JObject();
            entry["method"] = order[i];
            if (counts != null)
            {
                entry["calls"] = counts[order[i]];
            }
            else
            {
                int[] tally = tallies[order[i]];
                entry["calls"] = tally[0];
                entry["hits"] = tally[2] == 1 ? (JToken)tally[1] : JValue.CreateNull();
            }
            list.Add(entry);
        }
        return list;
    }

    #endregion

    #region Level state

    private static JObject EmptyChanges()
    {
        JObject changes = new JObject();
        changes["blocks"] = new JArray();
        changes["units"] = new JArray();
        changes["doodads"] = new JArray();
        return changes;
    }

    private void SnapshotLevel(out BlockState[,] fore, out BlockState[,] back,
        out Dictionary<int, ObjectState> units, out Dictionary<int, ObjectState> doodads)
    {
        fore = SnapshotBlocks(Map.blocks);
        back = SnapshotBlocks(Map.backGroundBlocks);
        units = new Dictionary<int, ObjectState>();
        doodads = new Dictionary<int, ObjectState>();

        if (Map.units != null)
        {
            for (int i = 0; i < Map.units.Count; i++)
            {
                Unit unit = Map.units[i];
                if (unit == null) continue;
                int id = unit.GetInstanceID();
                if (sweptIds.Contains(id) || units.ContainsKey(id)) continue;

                ObjectState state = new ObjectState();
                state.Name = unit.gameObject.name;
                state.Health = unit.health;
                state.Dead = Died(unit);
                state.Ref = unit;
                units[id] = state;
            }
        }

        AddDoodads(Map.destroyableDoodads, doodads);
        AddDoodads(Map.staticDoodads, doodads);
    }

    private static BlockState[,] SnapshotBlocks(Block[,] grid)
    {
        if (grid == null) return new BlockState[0, 0];

        int cols = grid.GetLength(0);
        int rows = grid.GetLength(1);
        BlockState[,] states = new BlockState[cols, rows];
        for (int c = 0; c < cols; c++)
        {
            for (int r = 0; r < rows; r++)
            {
                Block block = grid[c, r];
                if (block == null) continue;

                BlockState state = new BlockState();
                state.Id = block.GetInstanceID();
                state.Name = block.gameObject.name;
                state.Health = block.health;
                state.Destroyed = block.destroyed;
                state.Collapsed = block.collapsed;
                state.Disturbed = block.disturbed;
                states[c, r] = state;
            }
        }
        return states;
    }

    private static void AddDoodads(List<Doodad> list, Dictionary<int, ObjectState> into)
    {
        if (list == null) return;
        for (int i = 0; i < list.Count; i++)
        {
            Doodad doodad = list[i];
            if (doodad == null) continue;
            int id = doodad.GetInstanceID();
            if (into.ContainsKey(id)) continue;

            ObjectState state = new ObjectState();
            state.Name = doodad.gameObject.name;
            state.Health = doodad.health;
            state.Dead = doodad.isDead;
            state.Collapsed = doodad.collapsed;
            state.Ref = doodad;
            into[id] = state;
        }
    }

    private JObject DiffLevel()
    {
        BlockState[,] fore;
        BlockState[,] back;
        Dictionary<int, ObjectState> units;
        Dictionary<int, ObjectState> doodads;
        JObject changes = EmptyChanges();

        try
        {
            SnapshotLevel(out fore, out back, out units, out doodads);
        }
        catch (Exception ex)
        {
            Log("Could not read the level for state '" + currentName + "': " + ex.Message);
            return changes;
        }

        JArray blocks = (JArray)changes["blocks"];
        DiffBlocks("foreground", foreBlocks, fore, blocks);
        DiffBlocks("background", backBlocks, back, blocks);
        DiffUnits(unitStates, units, (JArray)changes["units"]);
        DiffDoodads(doodadStates, doodads, (JArray)changes["doodads"]);

        foreBlocks = fore;
        backBlocks = back;
        unitStates = units;
        doodadStates = doodads;
        return changes;
    }

    private static JArray Health(int? before, int? after)
    {
        JArray pair = new JArray();
        pair.Add(before.HasValue ? (JToken)before.Value : JValue.CreateNull());
        pair.Add(after.HasValue ? (JToken)after.Value : JValue.CreateNull());
        return pair;
    }

    private static void DiffBlocks(string layer, BlockState[,] before, BlockState[,] after, JArray into)
    {
        int cols = Mathf.Max(before.GetLength(0), after.GetLength(0));
        int rows = Mathf.Max(before.GetLength(1), after.GetLength(1));
        for (int c = 0; c < cols; c++)
        {
            for (int r = 0; r < rows; r++)
            {
                BlockState b = c < before.GetLength(0) && r < before.GetLength(1) ? before[c, r] : null;
                BlockState a = c < after.GetLength(0) && r < after.GetLength(1) ? after[c, r] : null;
                if (b == null && a == null) continue;

                if (b != null && (a == null || a.Id != b.Id))
                {
                    if (!b.Destroyed) into.Add(BlockChange(layer, c, r, b.Name, "destroyed", b.Health, null));
                    if (a != null) into.Add(BlockChange(layer, c, r, a.Name, "added", null, a.Health));
                    continue;
                }
                if (b == null)
                {
                    into.Add(BlockChange(layer, c, r, a.Name, "added", null, a.Health));
                    continue;
                }

                string change = null;
                if (!b.Destroyed && a.Destroyed) change = "destroyed";
                else if (!b.Collapsed && a.Collapsed) change = "collapsed";
                else if (a.Health < b.Health) change = "damaged";
                else if (!b.Disturbed && a.Disturbed) change = "disturbed";
                if (change != null) into.Add(BlockChange(layer, c, r, a.Name, change, b.Health, a.Health));
            }
        }
    }

    private static JObject BlockChange(string layer, int col, int row, string name, string change, int? before, int? after)
    {
        JObject entry = new JObject();
        entry["layer"] = layer;
        entry["col"] = col;
        entry["row"] = row;
        entry["name"] = name;
        entry["change"] = change;
        entry["health"] = Health(before, after);
        return entry;
    }

    private static JObject ObjectChange(int id, string name, string change, int? before, int? after)
    {
        JObject entry = new JObject();
        entry["id"] = id;
        entry["name"] = name;
        entry["change"] = change;
        entry["health"] = Health(before, after);
        return entry;
    }

    private static bool Died(Unit unit)
    {
        return unit.destroyed || unit.actionState == ActionState.Dead || unit.health <= 0;
    }

    private static void DiffUnits(Dictionary<int, ObjectState> before, Dictionary<int, ObjectState> after, JArray into)
    {
        foreach (KeyValuePair<int, ObjectState> pair in before)
        {
            ObjectState b = pair.Value;
            ObjectState a;
            if (after.TryGetValue(pair.Key, out a))
            {
                if (a.Dead && !b.Dead) into.Add(ObjectChange(pair.Key, a.Name, "killed", b.Health, a.Health));
                else if (a.Health < b.Health) into.Add(ObjectChange(pair.Key, a.Name, "damaged", b.Health, a.Health));
                continue;
            }

            // A gibbed unit is destroyed before the diff: Unity's == null is true for it, its managed fields still read
            Unit unit = b.Ref as Unit;
            bool died = (object)unit != null && Died(unit);
            into.Add(ObjectChange(pair.Key, b.Name, died && !b.Dead ? "killed" : "removed", b.Health, unit == null ? null : (int?)unit.health));
        }
        foreach (KeyValuePair<int, ObjectState> pair in after)
        {
            if (!before.ContainsKey(pair.Key)) into.Add(ObjectChange(pair.Key, pair.Value.Name, "added", null, pair.Value.Health));
        }
    }

    private static void DiffDoodads(Dictionary<int, ObjectState> before, Dictionary<int, ObjectState> after, JArray into)
    {
        foreach (KeyValuePair<int, ObjectState> pair in before)
        {
            ObjectState b = pair.Value;
            ObjectState a;
            if (after.TryGetValue(pair.Key, out a))
            {
                if ((a.Dead && !b.Dead) || (a.Collapsed && !b.Collapsed)) into.Add(ObjectChange(pair.Key, a.Name, "destroyed", b.Health, a.Health));
                else if (a.Health < b.Health) into.Add(ObjectChange(pair.Key, a.Name, "damaged", b.Health, a.Health));
                continue;
            }

            Doodad doodad = b.Ref as Doodad;
            bool died = (object)doodad != null && ((doodad.isDead && !b.Dead) || (doodad.collapsed && !b.Collapsed) || (doodad.health <= 0 && b.Health > 0));
            into.Add(ObjectChange(pair.Key, b.Name, died ? "destroyed" : "removed", b.Health, doodad == null ? null : (int?)doodad.health));
        }
        foreach (KeyValuePair<int, ObjectState> pair in after)
        {
            if (!before.ContainsKey(pair.Key)) into.Add(ObjectChange(pair.Key, pair.Value.Name, "added", null, pair.Value.Health));
        }
    }

    #endregion

    private static void RecordObjects(HashSet<int> into)
    {
        into.Clear();
        Renderer[] all = UnityEngine.Object.FindObjectsOfType<Renderer>();
        for (int i = 0; i < all.Length; i++)
        {
            if (all[i] != null) into.Add(all[i].gameObject.GetInstanceID());
        }
    }

    private void BaselineState()
    {
        stateCropSeen = false;
        carriedOver.Clear();

        try
        {
            stateStartObjects.Clear();
            Renderer[] all = UnityEngine.Object.FindObjectsOfType<Renderer>();
            for (int i = 0; i < all.Length; i++)
            {
                Renderer r = all[i];
                if (r == null) continue;

                int id = r.gameObject.GetInstanceID();
                stateStartObjects.Add(id);
                if (!sweepStartObjects.Contains(id) && !IsKept(r.transform)) carriedOver.Add(r);
            }
            stateBaselined = true;
            leakCheckPending = true;
        }
        catch (Exception ex)
        {
            Log("Could not record the objects present at the start of state '" + currentName + "': " + ex.Message);
        }
    }

    private void NoteCrop(Vector3 center)
    {
        lastCropKnown = true;
        lastCropCenter = center;

        if (!stateCropSeen)
        {
            stateCropSeen = true;
            stateCropMin = center;
            stateCropMax = center;
            return;
        }
        stateCropMin = Vector2.Min(stateCropMin, center);
        stateCropMax = Vector2.Max(stateCropMax, center);
    }

    private void CheckLeaks(Vector3 center)
    {
        if (sceneError != null) return;

        try
        {
            HashSet<int> seen = new HashSet<int>();
            for (int i = 0; i < carriedOver.Count; i++)
            {
                Renderer r = carriedOver[i];
                if (!Draws(r) || !Overlaps(r.bounds, center, center)) continue;

                GameObject go = r.gameObject;
                int id = go.GetInstanceID();
                if (!seen.Add(id)) continue;

                string spawner;
                string message = spawnedBy.TryGetValue(id, out spawner)
                    ? "state '" + currentName + "': '" + go.name + "' left over from state '" + spawner
                        + "' is drawn in the crop"
                    : "state '" + currentName + "': '" + go.name + "', which was not there at sweep start, is drawn "
                        + "in the crop";
                stateLeaks.Add(message);
                Log(message);
            }
        }
        catch (Exception ex)
        {
            Log("Could not check state '" + currentName + "' for leftover objects: " + ex.Message);
        }
    }

    private class RetiredEntry
    {
        public string Name;
        public string Source;
        public bool Pooled;
        public int Count;
        public JArray Types;
        public int FirstSeenStep = -1;
    }

    private void RetireStateObjects(JObject record)
    {
        if (record != null) AttachLevelState(record, false);
        if (sceneError != null)
        {
            requestedEffects.Clear();
            requestedSteps.Clear();
            WriteCapture(false);
            return;
        }

        List<RetiredEntry> entries = new List<RetiredEntry>();
        HashSet<int> handled = new HashSet<int>();
        int pooled = 0;
        int deactivated = 0;

        RetireRequested(entries, handled, ref pooled, ref deactivated);
        RetireSpawnedChildren(entries, handled, ref pooled, ref deactivated);

        Vector2 min;
        Vector2 max;
        if (CropRegion(out min, out max))
        {
            try
            {
                Renderer[] all = UnityEngine.Object.FindObjectsOfType<Renderer>();
                for (int i = 0; i < all.Length; i++)
                {
                    Renderer r = all[i];
                    if (r == null) continue;

                    int id = r.gameObject.GetInstanceID();
                    if (sweepStartObjects.Contains(id) || IsKept(r.transform)) continue;
                    if (stateBaselined && !stateStartObjects.Contains(id)) spawnedBy[id] = currentName;
                    if (!Draws(r) || !Overlaps(r.bounds, min, max)) continue;

                    Effects.IPoolableEffect effect;
                    GameObject target = RetireTargetOf(r.transform, out effect);
                    if (!handled.Add(target.GetInstanceID())) continue;

                    RetireAndCount(entries, target, effect, "crop", -1, ref pooled, ref deactivated);
                }
            }
            catch (Exception ex)
            {
                Log("Could not retire the objects state '" + currentName + "' left in the crop: " + ex.Message);
            }
        }

        // An object deactivated above can spawn more in its OnDisable: a real spear makes its death effects there
        RetireRequested(entries, handled, ref pooled, ref deactivated);

        if (entries.Count == 0)
        {
            WriteCapture(false);
            return;
        }

        JArray retired = new JArray();
        string listed = "";
        for (int i = 0; i < entries.Count; i++)
        {
            RetiredEntry e = entries[i];
            JObject entry = new JObject();
            entry["name"] = e.Name;
            entry["count"] = e.Count;
            entry["source"] = e.Source;
            entry["pooled"] = e.Pooled;
            entry["types"] = e.Types;
            entry["firstSeenStep"] = e.FirstSeenStep >= 0 ? (JToken)e.FirstSeenStep : JValue.CreateNull();
            retired.Add(entry);
            listed += (i == 0 ? "" : ", ") + e.Name + " x" + e.Count;
        }
        if (record != null) record["retired"] = retired;
        WriteCapture(false);

        Log("state '" + currentName + "': retired " + (pooled + deactivated) + " objects ("
            + pooled + " to their pools, " + deactivated + " deactivated): " + listed);
    }

    private void RetireRequested(List<RetiredEntry> entries, HashSet<int> handled, ref int pooled, ref int deactivated)
    {
        try
        {
            for (int i = 0; i < requestedEffects.Count; i++)
            {
                Effects.IPoolableEffect effect = requestedEffects[i];
                Component component = effect as Component;
                if (component == null) continue;

                GameObject go = component.gameObject;
                if (!go.activeSelf || effect.ParentPool == null || effect.PoolIndex == -1) continue;
                if (IsKept(go.transform) || !handled.Add(go.GetInstanceID())) continue;

                RetireAndCount(entries, go, effect, "requested", requestedSteps[i], ref pooled, ref deactivated);
            }
        }
        catch (Exception ex)
        {
            Log("Could not retire the effects state '" + currentName + "' requested: " + ex.Message);
        }
        requestedEffects.Clear();
        requestedSteps.Clear();
    }

    private void RetireSpawnedChildren(List<RetiredEntry> entries, HashSet<int> handled, ref int pooled, ref int deactivated)
    {
        if (character == null) return;

        try
        {
            Transform[] under = character.GetComponentsInChildren<Transform>(true);
            for (int i = 0; i < under.Length; i++)
            {
                Transform t = under[i];
                if (t == null || t.parent == null || broTransforms.Contains(t.GetInstanceID()) || !broTransforms.Contains(t.parent.GetInstanceID())) continue;

                GameObject go = t.gameObject;
                if (!go.activeSelf || IsKept(t) || !handled.Add(go.GetInstanceID())) continue;
                RetireAndCount(entries, go, EffectOn(t), "child", -1, ref pooled, ref deactivated);
            }
        }
        catch (Exception ex)
        {
            Log("Could not retire what state '" + currentName + "' left under the bro: " + ex.Message);
        }
    }

    private static void RetireAndCount(List<RetiredEntry> entries, GameObject target, Effects.IPoolableEffect effect, string source, int step, ref int pooled, ref int deactivated)
    {
        string name = target.name;
        JArray types = ComponentsOf(target);
        bool toPool = Retire(target, effect);
        if (toPool) pooled++;
        else deactivated++;
        CountRetired(entries, name, source, toPool, types, step);
    }

    private bool CropRegion(out Vector2 min, out Vector2 max)
    {
        if (stateCropSeen)
        {
            min = stateCropMin;
            max = stateCropMax;
            return true;
        }

        if (character != null) min = CropCenterOf(GetSprite());
        else if (lastCropKnown) min = lastCropCenter;
        else
        {
            min = Vector2.zero;
            max = min;
            return false;
        }
        max = min;
        return true;
    }

    private static void CountRetired(List<RetiredEntry> entries, string name, string source, bool pooled, JArray types, int step)
    {
        for (int i = 0; i < entries.Count; i++)
        {
            RetiredEntry e = entries[i];
            if (e.Name != name || e.Source != source || e.Pooled != pooled) continue;
            e.Count++;
            if (step >= 0 && (e.FirstSeenStep < 0 || step < e.FirstSeenStep)) e.FirstSeenStep = step;
            return;
        }

        RetiredEntry entry = new RetiredEntry();
        entry.Name = name;
        entry.Source = source;
        entry.Pooled = pooled;
        entry.Count = 1;
        entry.Types = types;
        entry.FirstSeenStep = step;
        entries.Add(entry);
    }

    private bool IsKept(Transform t)
    {
        for (Transform node = t; node != null; node = node.parent)
        {
            if (node.GetComponent<Camera>() != null || node.GetComponent<ReactionBubble>() != null
                || node.GetComponent<AnimationCapture>() != null)
            {
                return true;
            }
            if (character != null && node == character.transform) return broTransforms.Contains(t.GetInstanceID());
            if (node.GetComponent<NetworkedUnit>() != null) return true;
        }
        return false;
    }

    private static bool Draws(Renderer r)
    {
        if (r == null || !r.enabled || !r.gameObject.activeInHierarchy) return false;
        Vector3 scale = r.transform.lossyScale;
        return scale.x != 0f && scale.y != 0f;
    }

    private bool Overlaps(Bounds bounds, Vector2 min, Vector2 max)
    {
        return bounds.max.x >= min.x - box && bounds.min.x <= max.x + box
            && bounds.max.y >= min.y - box && bounds.min.y <= max.y + box;
    }

    private static GameObject RetireTargetOf(Transform t, out Effects.IPoolableEffect effect)
    {
        for (Transform node = t; node != null; node = node.parent)
        {
            effect = EffectOn(node);
            if (effect != null) return node.gameObject;
        }
        effect = null;
        return t.gameObject;
    }

    private static Effects.IPoolableEffect EffectOn(Transform t)
    {
        MonoBehaviour[] behaviours = t.GetComponents<MonoBehaviour>();
        for (int i = 0; i < behaviours.Length; i++)
        {
            Effects.IPoolableEffect effect = behaviours[i] as Effects.IPoolableEffect;
            if (effect != null) return effect;
        }
        return null;
    }

    private static bool Retire(GameObject target, Effects.IPoolableEffect effect)
    {
        // EffectDie destroys an unpooled effect, which something may still hold, so only a pooled one is given it
        if (effect != null && effect.ParentPool != null && effect.PoolIndex != -1)
        {
            // Wind and return zones unregister themselves in Update before EffectDie, not in EffectDie itself
            WindObject wind = effect as WindObject;
            if (wind != null) WindController.RemoveWind(wind);
            ProjectileReturnZone zone = effect as ProjectileReturnZone;
            if (zone != null) ProjectileController.RemoveReturnZone(zone);

            effect.EffectDie();
            if (!target.activeSelf) return true;
        }
        target.SetActive(false);
        return false;
    }

    #region Field pinning

    private void RequireField(string name)
    {
        if (ResolveField(name) == null) throw new Exception("unknown field '" + name + "'");
    }

    private void RequireFields(JObject pins)
    {
        if (pins == null) return;
        foreach (JProperty prop in pins.Properties()) RequireField(prop.Name);
    }

    private void SnapshotBro()
    {
        ReleaseBroSnapshot();

        BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
        MonoBehaviour[] behaviours = character.GetComponentsInChildren<MonoBehaviour>(true);
        for (int b = 0; b < behaviours.Length; b++)
        {
            if (behaviours[b] == null) continue;
            for (Type type = behaviours[b].GetType(); type != null && type != typeof(MonoBehaviour); type = type.BaseType)
            {
                FieldInfo[] fields = type.GetFields(flags);
                for (int i = 0; i < fields.Length; i++)
                {
                    if (fields[i].IsLiteral || fields[i].IsInitOnly) continue;
                    BroField entry = new BroField();
                    entry.Owner = behaviours[b];
                    entry.Field = fields[i];
                    entry.Value = fields[i].GetValue(behaviours[b]);
                    broFields.Add(entry);
                }
            }
        }

        Transform[] transforms = character.GetComponentsInChildren<Transform>(true);
        for (int i = 0; i < transforms.Length; i++)
        {
            Transform t = transforms[i];
            broTransforms.Add(t.GetInstanceID());
            BroPart part = new BroPart();
            part.Transform = t;
            part.Active = t.gameObject.activeSelf;
            part.Layer = t.gameObject.layer;
            part.LocalPosition = t.localPosition;
            part.LocalRotation = t.localRotation;
            part.LocalScale = t.localScale;
            part.Renderer = t.GetComponent<Renderer>();
            if (part.Renderer != null)
            {
                part.RendererEnabled = part.Renderer.enabled;
                part.Material = part.Renderer.sharedMaterial;
                if (part.Material != null) part.MaterialCopy = new Material(part.Material);
            }
            part.Sprite = t.GetComponent<SpriteSM>();
            if (part.Sprite != null)
            {
                part.Cell = part.Sprite.lowerLeftPixel;
                part.CellSize = part.Sprite.pixelDimensions;
                part.Offset = part.Sprite.offset;
                part.Tint = part.Sprite.color;
            }
            broParts.Add(part);
        }
    }

    private void RestoreBro()
    {
        if (character == null) return;

        for (int i = 0; i < broParts.Count; i++)
        {
            BroPart part = broParts[i];
            part.SpriteChanged = part.Sprite != null && (part.Sprite.lowerLeftPixel != part.Cell || part.Sprite.pixelDimensions != part.CellSize
                || part.Sprite.offset != part.Offset || part.Sprite.color != part.Tint);
        }

        int ammo = character._specialAmmo;
        for (int i = 0; i < broFields.Count; i++)
        {
            BroField entry = broFields[i];
            if (entry.Owner == null) continue;

            try
            {
                if (!object.Equals(entry.Field.GetValue(entry.Owner), entry.Value)) entry.Field.SetValue(entry.Owner, entry.Value);
            }
            catch (Exception ex)
            {
                Log("Could not restore " + entry.Field.Name + ": " + ex.Message);
            }
        }
        if (character._specialAmmo != ammo) character.SetSpecialAmmoRPC(character._specialAmmo);

        for (int i = 0; i < broParts.Count; i++)
        {
            BroPart part = broParts[i];
            if (part.Transform == null) continue;

            if (part.Transform != character.transform && part.Transform.gameObject.activeSelf != part.Active) part.Transform.gameObject.SetActive(part.Active);
            part.Transform.gameObject.layer = part.Layer;
            RestoreTransform(part);
            if (part.Renderer != null)
            {
                part.Renderer.enabled = part.RendererEnabled;
                part.Renderer.sharedMaterial = part.Material;
                // A bro can change the material itself, as a sheet swap through mainTexture does
                if (part.MaterialCopy != null) part.Material.CopyPropertiesFromMaterial(part.MaterialCopy);
            }
            if (part.Sprite != null && part.SpriteChanged)
            {
                part.Sprite.SetPixelDimensions(part.CellSize);
                part.Sprite.SetLowerLeftPixel(part.Cell);
                part.Sprite.SetOffset(part.Offset);
                part.Sprite.SetColor(part.Tint);
            }
        }
    }

    private void ReleaseBroSnapshot()
    {
        for (int i = 0; i < broParts.Count; i++)
        {
            if (broParts[i].MaterialCopy != null) UnityEngine.Object.Destroy(broParts[i].MaterialCopy);
        }
        broParts.Clear();
        broTransforms.Clear();
        broFields.Clear();
    }

    private static void RestoreTransform(BroPart part)
    {
        part.Transform.localPosition = part.LocalPosition;
        part.Transform.localRotation = part.LocalRotation;
        part.Transform.localScale = part.LocalScale;
    }

    private void RepairNonFinite()
    {
        if (character == null) return;

        for (int i = 0; i < broFields.Count; i++)
        {
            BroField entry = broFields[i];
            Type type = entry.Field.FieldType;
            if (type != typeof(float) && type != typeof(double) && type != typeof(Vector2) && type != typeof(Vector3)) continue;
            // The game keeps Infinity in some fields as a sentinel
            if (entry.Owner == null || Finite(entry.Field.GetValue(entry.Owner)) || !Finite(entry.Value)) continue;

            entry.Field.SetValue(entry.Owner, entry.Value);
            NoteNonFinite(entry.Owner == character ? entry.Field.Name : entry.Owner.name + "." + entry.Field.Name);
        }

        for (int i = 0; i < broParts.Count; i++)
        {
            Transform t = broParts[i].Transform;
            if (t == null) continue;

            Vector3 p = t.localPosition;
            Quaternion r = t.localRotation;
            Vector3 s = t.localScale;
            if (Finite(p.x + p.y + p.z) && Finite(r.x + r.y + r.z + r.w) && Finite(s.x + s.y + s.z)) continue;

            RestoreTransform(broParts[i]);
            NoteNonFinite(t.name + " transform");
        }
    }

    private void NoteNonFinite(string name)
    {
        if (!stateNonFinite.Contains(name)) stateNonFinite.Add(name);
    }

    private static bool Finite(float value)
    {
        return value - value == 0f;
    }

    private static bool Finite(object value)
    {
        if (value is float) return Finite((float)value);
        if (value is double) return (double)value - (double)value == 0d;
        if (value is Vector2) return Finite(((Vector2)value).x + ((Vector2)value).y);
        if (value is Vector3) return Finite(((Vector3)value).x + ((Vector3)value).y + ((Vector3)value).z);
        return true;
    }

    private void ApplySetup()
    {
        ApplyPins(currentSetup);
        if (providedZipline != null) ResolveField("attachedToZipline").SetValue(character, providedZipline);
    }

    private void ApplyPins(JObject pins)
    {
        if (pins == null) return;
        foreach (JProperty prop in pins.Properties()) SetField(prop.Name, prop.Value);
    }

    private void ResolveMethods(JToken token, string phase, List<MethodInfo> into)
    {
        if (token == null || token.Type == JTokenType.Null) return;

        JArray names = token as JArray;
        if (names == null) throw new Exception(phase + " must be a list of method names");

        foreach (JToken entry in names)
        {
            string name = StringOf(entry);
            if (string.IsNullOrEmpty(name)) throw new Exception(phase + " holds an empty method name");
            into.Add(ResolveMethod(name, null));
        }
    }

    private void ResolveCalls(JToken token)
    {
        if (token == null || token.Type == JTokenType.Null) return;

        JArray names = token as JArray;
        if (names == null) throw new Exception("step.call must be a list of method names");

        foreach (JToken entry in names)
        {
            string name = StringOf(entry);
            if (string.IsNullOrEmpty(name)) throw new Exception("step.call holds an empty method name");

            Call call = new Call();
            call.Method = ResolveMethod(name, providedZipline == null ? null : typeof(ZipLine));
            call.Args = call.Method.GetParameters().Length == 0 ? null : new object[] { providedZipline };
            currentCalls.Add(call);
        }
    }

    private MethodInfo ResolveMethod(string name, Type provided)
    {
        BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
                             | BindingFlags.DeclaredOnly;
        bool named = false;
        MethodInfo withProvided = null;

        for (Type type = character.GetType(); type != null; type = type.BaseType)
        {
            MethodInfo[] methods = type.GetMethods(flags);
            for (int i = 0; i < methods.Length; i++)
            {
                MethodInfo method = methods[i];
                if (method.Name != name || method.IsGenericMethodDefinition) continue;

                named = true;
                ParameterInfo[] parameters = method.GetParameters();
                if (parameters.Length == 0) return method;
                if (withProvided == null && provided != null && parameters.Length == 1
                    && parameters[0].ParameterType.IsAssignableFrom(provided))
                {
                    withProvided = method;
                }
            }
        }

        if (withProvided != null) return withProvided;
        if (named) throw new Exception("method '" + name + "' has no parameterless overload");
        throw new Exception("unknown method '" + name + "'");
    }

    private void SetField(string name, JToken value)
    {
        FieldInfo field = ResolveField(name);
        if (field == null) throw new Exception("unknown field '" + name + "'");
        field.SetValue(character, ConvertValue(field.FieldType, value, name));
    }

    // Unit exposes frame and actionState as properties over _frame and _actionState
    private FieldInfo ResolveField(string name)
    {
        Type type = character.GetType();
        FieldInfo field = AccessTools.Field(type, name);
        if (field == null) field = AccessTools.Field(type, "_" + name);
        return field;
    }

    private static object ConvertValue(Type type, JToken value, string name)
    {
        if (type.IsEnum)
        {
            if (value.Type == JTokenType.Integer) return Enum.ToObject(type, (int)value);
            return Enum.Parse(type, value.ToString(), true);
        }
        if (type == typeof(bool)) return (bool)value;
        if (type == typeof(int)) return (int)value;
        if (type == typeof(float)) return (float)value;
        if (type == typeof(double)) return (double)value;
        if (type == typeof(string)) return value.ToString();
        throw new Exception("field '" + name + "' has unsupported type " + type.Name);
    }

    private string CheckRequires(JObject requires)
    {
        if (requires == null) return null;

        foreach (JProperty prop in requires.Properties())
        {
            FieldInfo field = ResolveField(prop.Name);
            if (field == null) return "no field '" + prop.Name + "' on " + character.GetType().Name;

            object actual = field.GetValue(character);
            object wanted = ConvertValue(field.FieldType, prop.Value, prop.Name);
            if (!wanted.Equals(actual))
                return prop.Name + " is " + actual + ", the state needs " + wanted;
        }
        return null;
    }

    #endregion

    #region Capture

    private Texture2D Crop(Vector3 center, out bool offscreen, out string contributionFailure)
    {
        Texture2D cell = new Texture2D(cellPx, cellPx, TextureFormat.RGBA32, false);
        Color32[] pixels = new Color32[cellPx * cellPx];
        offscreen = true;
        contributionFailure = null;

        Camera cam = Camera.main;
        if (cam == null) cam = Camera.current;

        if (cam != null)
        {
            Vector3 a = cam.WorldToScreenPoint(new Vector3(center.x - box, center.y - box, center.z));
            Vector3 b = cam.WorldToScreenPoint(new Vector3(center.x + box, center.y + box, center.z));

            float left = Mathf.Min(a.x, b.x);
            float bottom = Mathf.Min(a.y, b.y);
            float width = Mathf.Abs(b.x - a.x);
            float height = Mathf.Abs(b.y - a.y);

            int readX = Mathf.Clamp(Mathf.FloorToInt(left), 0, Screen.width);
            int readY = Mathf.Clamp(Mathf.FloorToInt(bottom), 0, Screen.height);
            int readW = Mathf.Clamp(Mathf.CeilToInt(left + width), 0, Screen.width) - readX;
            int readH = Mathf.Clamp(Mathf.CeilToInt(bottom + height), 0, Screen.height) - readY;

            if (readW > 0 && readH > 0 && width > 0f && height > 0f)
            {
                offscreen = false;

                captureTexture = ScreenSizedTexture(captureTexture);
                RenderScene(captureTexture);
                Color32[] source = ReadRegion(captureTexture, readX, readY, readW, readH);
                contributionFailure = CheckContribution(source, readX, readY, readW, readH);

                // Screen space and Texture2D space are both bottom-left origin, so the strip comes out upright
                for (int y = 0; y < cellPx; y++)
                {
                    int sy = Mathf.FloorToInt(bottom + (y + 0.5f) * height / cellPx) - readY;
                    if (sy < 0 || sy >= readH) continue;

                    for (int x = 0; x < cellPx; x++)
                    {
                        int sx = Mathf.FloorToInt(left + (x + 0.5f) * width / cellPx) - readX;
                        if (sx < 0 || sx >= readW) continue;
                        pixels[y * cellPx + x] = source[sy * readW + sx];
                    }
                }
            }
        }

        if (AnyWritten(pixels)) stateSawWritten = true;

        cell.SetPixels32(pixels);
        cell.Apply();
        return cell;
    }

    private static Color32[] ReadRegion(RenderTexture target, int x, int y, int width, int height)
    {
        RenderTexture previousActive = RenderTexture.active;
        Texture2D raw = new Texture2D(width, height, TextureFormat.RGBA32, false);

        try
        {
            RenderTexture.active = target;
            raw.ReadPixels(new Rect(x, y, width, height), 0, 0);
            raw.Apply();
            // GetPixels32 returns a copy, so raw can be destroyed after it
            return raw.GetPixels32();
        }
        finally
        {
            RenderTexture.active = previousActive;
            UnityEngine.Object.Destroy(raw);
        }
    }

    private string CheckContribution(Color32[] withCharacter, int x, int y, int width, int height)
    {
        Renderer[] renderers = character.GetComponentsInChildren<Renderer>(false);
        List<Renderer> disabled = new List<Renderer>();
        Color32[] withoutCharacter = null;

        try
        {
            for (int i = 0; i < renderers.Length; i++)
            {
                Renderer r = renderers[i];
                if (r == null || !r.enabled || !broTransforms.Contains(r.transform.GetInstanceID())) continue;
                Vector3 scale = r.transform.lossyScale;
                if (scale.x == 0f || scale.y == 0f) continue;
                r.enabled = false;
                disabled.Add(r);
            }

            if (disabled.Count == 0) return "the character has no enabled renderer";

            contributionTexture = ScreenSizedTexture(contributionTexture);
            RenderScene(contributionTexture);
            withoutCharacter = ReadRegion(contributionTexture, x, y, width, height);
        }
        finally
        {
            for (int i = 0; i < disabled.Count; i++)
            {
                if (disabled[i] != null) disabled[i].enabled = true;
            }
        }

        if (AnyDifferent(withCharacter, withoutCharacter)) return null;
        return NoPixelFailure;
    }

    private static bool AnyDifferent(Color32[] a, Color32[] b)
    {
        for (int i = 0; i < a.Length; i++)
        {
            Color32 p = a[i];
            Color32 q = b[i];
            if (p.r != q.r || p.g != q.g || p.b != q.b || p.a != q.a) return true;
        }
        return false;
    }

    // The question is whether the read buffer is anything other than zeroed memory, so all four
    // channels count: neither the backbuffer nor a render texture is guaranteed to carry alpha, and
    // a scene that draws only opaque black would read the same as one that never drew. The loop
    // stops at the first written pixel, so only a blank crop pays for the whole scan.
    private static bool AnyWritten(Color32[] pixels)
    {
        for (int i = 0; i < pixels.Length; i++)
        {
            Color32 p = pixels[i];
            if (p.a != 0 || p.r != 0 || p.g != 0 || p.b != 0) return true;
        }
        return false;
    }

    // ReadPixels off the backbuffer comes back as zeroed memory for seconds after a level load, and
    // whenever the window is not being presented at all, while the cameras themselves render fine.
    // So the sweep drives the render itself: every camera that draws to the screen is pointed at one
    // texture, in depth order, and each clears or composites into it exactly as it would on screen.
    private void RenderScene(RenderTexture target)
    {
        RenderTexture previousActive = RenderTexture.active;
        try
        {
            RenderTexture.active = target;
            GL.Clear(true, true, Color.clear);
        }
        finally
        {
            RenderTexture.active = previousActive;
        }

        List<Camera> cameras = ScreenCameras();
        if (cameras.Count == 0 && !noCameraLogged)
        {
            noCameraLogged = true;
            Log("No screen camera to render: the crops will be empty");
        }

        for (int i = 0; i < cameras.Count; i++)
        {
            Camera cam = cameras[i];
            try
            {
                cam.targetTexture = target;
                cam.Render();
            }
            catch (Exception ex)
            {
                Log("Could not render " + cam.name + ": " + ex.Message);
            }
            finally
            {
                // Every camera in the list drew to the screen, so the target it goes back to is none
                cam.targetTexture = null;
            }
        }
    }

    private static RenderTexture ScreenSizedTexture(RenderTexture texture)
    {
        if (texture != null && texture.width == Screen.width && texture.height == Screen.height) return texture;
        ReleaseTexture(texture);

        RenderTexture created = new RenderTexture(Mathf.Max(1, Screen.width), Mathf.Max(1, Screen.height), 24);
        created.Create();
        return created;
    }

    // Camera.allCameras is the enabled ones. A camera that already has a targetTexture is part of
    // the game's own pipeline — lighting, distortion, the effect passes — and is left alone: it has
    // been rendered by the game's loop already, and pointing it somewhere else would break it.
    private static List<Camera> ScreenCameras()
    {
        List<Camera> chosen = new List<Camera>();
        Camera[] all = Camera.allCameras;

        for (int i = 0; i < all.Length; i++)
        {
            if (all[i] != null && all[i].targetTexture == null) chosen.Add(all[i]);
        }

        chosen.Sort(new Comparison<Camera>(CompareByDepth));
        return chosen;
    }

    private static int CompareByDepth(Camera a, Camera b)
    {
        return a.depth.CompareTo(b.depth);
    }

    private void ReleaseCaptureTexture()
    {
        ReleaseTexture(captureTexture);
        captureTexture = null;
        ReleaseTexture(contributionTexture);
        contributionTexture = null;
    }

    private static void ReleaseTexture(RenderTexture texture)
    {
        if (texture == null) return;

        if (RenderTexture.active == texture) RenderTexture.active = null;
        texture.Release();
        UnityEngine.Object.Destroy(texture);
    }

    // The sprite quad sits at the character transform plus the sprite's own offset and anchor, so
    // centring on the transform alone puts the art in the top half of the cell.
    private Vector3 CropCenterOf(SpriteSM sprite)
    {
        Vector3 center = character.transform.position;
        if (sprite == null) return center;

        Vector2 anchor = (sprite.topLeft + sprite.bottomRight) * 0.5f;
        Vector3 local = sprite.offset + new Vector3(anchor.x, anchor.y, 0f);
        return center + character.transform.TransformVector(local);
    }

    private void WriteStrip(string name)
    {
        int count = cells.Count;
        int width = count * (cellPx + 1) - 1;

        Texture2D strip = new Texture2D(width, cellPx, TextureFormat.RGBA32, false);
        strip.SetPixels32(new Color32[width * cellPx]);
        for (int i = 0; i < count; i++)
        {
            strip.SetPixels32(i * (cellPx + 1), 0, cellPx, cellPx, cells[i].GetPixels32());
        }
        strip.Apply();

        File.WriteAllBytes(Path.Combine(outDir, SafeName(name) + ".png"), strip.EncodeToPNG());
        UnityEngine.Object.Destroy(strip);
    }

    private JObject CellOf(SpriteSM sprite, Material material)
    {
        JObject cell = new JObject();
        if (sprite == null)
        {
            cell["texture"] = new JValue((string)null);
            return cell;
        }

        Texture texture = material == null ? null : material.mainTexture;
        cell["texture"] = new JValue(texture == null ? null : texture.name);
        // A BroMaker sheet is loaded from disk with no name, so identity is the only way to see a swap
        cell["texId"] = texture == null ? 0 : texture.GetInstanceID();
        cell["texW"] = texture == null ? 0 : texture.width;
        cell["texH"] = texture == null ? 0 : texture.height;

        float cellW = sprite.pixelDimensions.x;
        float cellH = sprite.pixelDimensions.y;
        float x = sprite.lowerLeftPixel.x;
        float y = sprite.lowerLeftPixel.y;

        cell["cellW"] = cellW;
        cell["cellH"] = cellH;
        cell["x"] = x;
        cell["y"] = y;
        cell["row"] = cellH > 0f ? Mathf.FloorToInt(y / cellH) : -1;
        cell["col"] = cellW > 0f ? Mathf.FloorToInt(x / cellW) : -1;
        return cell;
    }

    private static Material MaterialOf(SpriteSM sprite)
    {
        if (sprite == null || sprite.meshRender == null) return null;
        return sprite.meshRender.sharedMaterial;
    }

    private SpriteSM GetSprite()
    {
        FieldInfo field = AccessTools.Field(character.GetType(), "sprite");
        return field == null ? null : field.GetValue(character) as SpriteSM;
    }

    private JObject DescribeBro()
    {
        try
        {
            return DescribeResolvedBro();
        }
        catch (Exception ex)
        {
            Log("Could not describe the bro: " + ex.Message);

            JObject minimal = new JObject();
            minimal["player"] = playerIndex;
            minimal["cropCenter"] = cropCenter == null ? (JToken)JValue.CreateNull() : cropCenter;
            minimal["overlapProbe"] = overlapProbe == null ? (JToken)JValue.CreateNull() : overlapProbe;
            return minimal;
        }
    }

    private JObject DescribeResolvedBro()
    {
        JObject bro = new JObject();
        bro["type"] = character.GetType().Name;
        bro["gameObject"] = character.gameObject.name;
        bro["heroType"] = character.heroType.ToString();
        bro["customName"] = new JValue(CustomBroName());
        bro["cropCenter"] = cropCenter == null ? (JToken)JValue.CreateNull() : cropCenter;
        bro["overlapProbe"] = overlapProbe == null ? (JToken)JValue.CreateNull() : overlapProbe;
        return bro;
    }

    private static JArray Vec(Vector3 v)
    {
        JArray array = new JArray();
        array.Add(v.x);
        array.Add(v.y);
        array.Add(v.z);
        return array;
    }

    // BroMaker's ICustomHero carries the bro's own name on an Info object; read it without
    // referencing BroMakerLib, which is only loaded when BroMaker is installed.
    private string CustomBroName()
    {
        try
        {
            PropertyInfo info = AccessTools.Property(character.GetType(), "Info");
            if (info == null) return null;

            object value = info.GetValue(character, null);
            if (value == null) return null;

            FieldInfo nameField = AccessTools.Field(value.GetType(), "name");
            if (nameField != null) return nameField.GetValue(value) as string;

            PropertyInfo nameProperty = AccessTools.Property(value.GetType(), "name");
            if (nameProperty != null) return nameProperty.GetValue(value, null) as string;
        }
        catch (Exception ex)
        {
            Log("Could not read the custom bro name: " + ex.Message);
        }
        return null;
    }

    #endregion

    #region Helpers

    private static JArray ReadStates(string path, out JObject parameters)
    {
        parameters = null;
        if (!File.Exists(path)) throw new Exception("state file not found: " + path);

        JToken root = JToken.Parse(File.ReadAllText(path));
        JArray states = root as JArray;
        JObject wrapper = root as JObject;
        if (states == null && wrapper != null)
        {
            states = wrapper["states"] as JArray;
            parameters = wrapper["params"] as JObject;
        }
        if (states == null) throw new Exception("state file is neither an array nor an object with a states array");
        return states;
    }

    private static TestVanDammeAnim ResolveCharacter(int player)
    {
        if (HeroController.players == null || HeroController.players.Length <= player)
            throw new Exception("HeroController.players has no slot " + player);

        Player slot = HeroController.players[player];
        if (slot == null) throw new Exception("no player in slot " + player);
        if (slot.character == null) throw new Exception("player " + player + " has no character");
        return slot.character;
    }

    private void HoldFacing()
    {
        Vector3 scale = character.transform.localScale;
        facingHeldOn = character;
        savedFacing = scale.x;
        // The game turns the bro only from xI and left/right input, so it keeps this facing until a state pins one
        scale.x = Mathf.Abs(scale.x);
        character.transform.localScale = scale;

        foreach (BoondockBro companion in UnityEngine.Object.FindObjectsOfType<BoondockBro>())
        {
            if (companion == character || companion.leadingBro != character) continue;
            heldCompanions.Add(companion);
            savedCompanionFacings.Add(companion.transform.localScale.x);
        }
        TurnCompanions();
    }

    private void TurnCompanions()
    {
        foreach (BoondockBro companion in heldCompanions)
        {
            if (companion == null) continue;
            Vector3 scale = companion.transform.localScale;
            // A companion's own Update turns it back from an xI or left kept from before the clock froze
            scale.x = Mathf.Abs(scale.x);
            companion.transform.localScale = scale;
        }
    }

    private void ReleaseFacing()
    {
        for (int i = 0; i < heldCompanions.Count; i++)
        {
            if (heldCompanions[i] == null) continue;
            Vector3 companionScale = heldCompanions[i].transform.localScale;
            companionScale.x = savedCompanionFacings[i];
            heldCompanions[i].transform.localScale = companionScale;
        }
        heldCompanions.Clear();
        savedCompanionFacings.Clear();

        if (facingHeldOn != null)
        {
            Vector3 scale = facingHeldOn.transform.localScale;
            scale.x = savedFacing;
            facingHeldOn.transform.localScale = scale;
        }
        facingHeldOn = null;
    }

    private void ReleaseTimeScale()
    {
        if (!timeScaleHeld) return;
        Time.timeScale = savedTimeScale;
        timeScaleHeld = false;
    }

    private void DisposeCells()
    {
        for (int i = 0; i < cells.Count; i++)
        {
            if (cells[i] != null) UnityEngine.Object.Destroy(cells[i]);
        }
        cells.Clear();
    }

    private static void WriteError(string message)
    {
        Log("Capture failed: " + message);
        if (string.IsNullOrEmpty(outDir)) return;

        try
        {
            File.WriteAllText(Path.Combine(outDir, ErrorFile), message);
        }
        catch (Exception ex)
        {
            Log("Could not write the error sentinel: " + ex.Message);
        }
    }

    private static void Discard(string path)
    {
        if (File.Exists(path)) File.Delete(path);
    }

    private static string StringOf(JToken token)
    {
        if (token == null || token.Type == JTokenType.Null) return null;
        return token.ToString();
    }

    private static string SafeName(string name)
    {
        char[] chars = name.ToCharArray();
        for (int i = 0; i < chars.Length; i++)
        {
            char c = chars[i];
            bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                      || c == '.' || c == '-' || c == '_';
            if (!ok) chars[i] = '_';
        }
        return new string(chars);
    }

    private static int ParseInt(string raw, int fallback)
    {
        int value;
        return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) ? value : fallback;
    }

    private static float ParseFloat(string raw, float fallback)
    {
        float value;
        return float.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out value) ? value : fallback;
    }

    private static string Ranges(List<int> values)
    {
        string text = "";
        for (int i = 0; i < values.Count; i++)
        {
            int start = values[i];
            while (i + 1 < values.Count && values[i + 1] == values[i] + 1) i++;
            text += (text == "" ? "" : ",") + (values[i] == start ? start.ToString() : start + "-" + values[i]);
        }
        return text;
    }

    #endregion
}
