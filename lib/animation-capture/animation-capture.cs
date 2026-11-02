// #name Animation Capture
// #description Sweep a bro through a list of pinned animation states, step each state's frames through ChangeFrame, and write one PNG strip per state plus a capture.json record of the sheet cells the game addressed. Completion is signalled by a "done" file in the output directory; failure by an "error" file.
// #tags animation, sprites, capture, testing
// #args outDir: Directory the game writes strips, capture.json and the done/error sentinel into (created if missing)
// #args statesFile: Path to the JSON state list (lib/animation-capture/states/base-states.json is the shape to follow)
// #args player: Player index whose character is captured (default 0)
// #args box: World-unit half-size of the crop box; each strip cell is 2*box pixels (default 24)
// #args suppress: "false" to let the swept animations fire their real specials and attacks (default true)

using System.IO;
using Newtonsoft.Json.Linq;

public class AnimationCapture : MonoBehaviour
{
    private const string DoneFile = "done";
    private const string ErrorFile = "error";
    private const string CaptureFile = "capture.json";
    private const string NoPixelFailure = "the character's renderers contributed no pixel to the crop";

    // A failure inside Main() can happen before outDir is usable, so there is no sentinel file to
    // poll for. This goes to the UMM log, which the driver tails when its wait times out.
    private const string StartupFailure = "animation-capture startup failed: ";

    // ScriptContext.Logger only carries the [Script:name] prefix while Main()/Unload() is running
    private static Action<string> cachedLogger;
    private static AnimationCapture instance;
    private static string outDir;

    private TestVanDammeAnim character;
    private int playerIndex;
    private JArray states;
    private float box;
    private int cellPx;

    private readonly JArray stateRecords = new JArray();
    private readonly List<Texture2D> cells = new List<Texture2D>();
    private readonly Dictionary<string, object> snapshot = new Dictionary<string, object>();

    private JArray currentFrames;
    private JObject currentSetup;
    private JArray currentValues;
    private string currentStepField;
    private string currentName;
    private JArray cropCenter;

    private readonly List<MethodInfo> currentBefore = new List<MethodInfo>();
    private readonly List<MethodInfo> currentAfter = new List<MethodInfo>();
    private bool afterPending;

    private readonly List<GameObject> hiddenOverlays = new List<GameObject>();
    private readonly List<ReactionBubble> heldBubbles = new List<ReactionBubble>();
    private readonly List<Vector3> heldBubbleScales = new List<Vector3>();
    private JArray overlapProbe;

    private readonly JArray errors = new JArray();
    private string stateError;
    private string fatal;
    private float savedTimeScale = 1f;
    private bool timeScaleHeld;

    private int stateIndex = -1;
    private int frameIndex;
    private bool inState;
    private bool awaitingCapture;
    private bool finished;

    private bool stateSawWritten;
    private int stateOnscreenCells;
    private int stateContributedCells;
    private int stateEmptyCells;
    private readonly List<string> stateContributionFailures = new List<string>();
    private readonly Dictionary<string, int> opaqueByCell = new Dictionary<string, int>();
    private bool sheetReadLogged;
    private bool blankLogged;
    private bool noCameraLogged;

    private RenderTexture captureTexture;
    private RenderTexture contributionTexture;

    private static void Log(string message)
    {
        if (cachedLogger != null) cachedLogger(message);
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

        if (string.IsNullOrEmpty(outDir))
        {
            Log(StartupFailure + "outDir is required");
            return;
        }

        try
        {
            Directory.CreateDirectory(outDir);
            Discard(Path.Combine(outDir, DoneFile));
            Discard(Path.Combine(outDir, ErrorFile));
        }
        catch (Exception ex)
        {
            Log(StartupFailure + "could not prepare " + outDir + ": " + ex.Message);
            return;
        }

        AnimationCapture created = null;
        try
        {
            if (string.IsNullOrEmpty(statesFile)) throw new Exception("statesFile is required");
            if (player < 0 || player > 3) throw new Exception("player must be 0-3, got " + player);
            if (boxSize < 1f) throw new Exception("box must be at least 1, got " + boxSize);

            JArray stateList = ReadStates(statesFile);
            TestVanDammeAnim hero = ResolveCharacter(player);

            GameObject go = new GameObject("AnimationCapture");
            UnityEngine.Object.DontDestroyOnLoad(go);
            ScriptContext.GameObjects.Add(go);

            instance = go.AddComponent<AnimationCapture>();
            created = instance;
            instance.character = hero;
            instance.playerIndex = player;
            instance.states = stateList;
            instance.box = boxSize;
            instance.cellPx = Mathf.Max(1, Mathf.RoundToInt(boxSize * 2f));
            SuppressBubbles();
            if (suppress) SuppressSideEffects(hero);
            else Log("Side-effect suppression is off: the swept animations will fire for real");
            instance.Begin();

            Log("Capturing " + stateList.Count + " states from " + hero.GetType().Name + " into " + outDir);
        }
        catch (Exception ex)
        {
            if (created != null) created.Abort();
            Log(StartupFailure + ex.Message);
            WriteError(ex.Message);
        }
    }

    private void Abort()
    {
        finished = true;
        ReleaseTimeScale();
        RestoreOverlays();
        ReleaseBubbles();
    }

    // Several states walk frames that fire the real thing: AnimateSpecial calls UseSpecial, the
    // pocketted special calls UsePockettedSpecial, and knife melee swings at whatever is nearby.
    // Skipping them keeps the frames identical and the level intact. ScriptContext.Harmony is only
    // live inside Main(), and its patches come off automatically on unload.
    // ReactionBubble rewrites its own transform every frame — LateUpdate calls CheckScale and the
    // non-animated arm of Update reassigns localScale outright — so a scale or position hold only
    // lasts until the next frame unless both are skipped for the duration of the sweep.
    private static void SuppressBubbles()
    {
        MethodInfo skip = AccessTools.Method(typeof(AnimationCapture), "SkipDuringSweep");
        Patch(AccessTools.DeclaredMethod(typeof(ReactionBubble), "Update"), skip, "ReactionBubble.Update");
        Patch(AccessTools.DeclaredMethod(typeof(ReactionBubble), "LateUpdate"), skip, "ReactionBubble.LateUpdate");
    }

    private static void SuppressSideEffects(TestVanDammeAnim hero)
    {
        MethodInfo skip = AccessTools.Method(typeof(AnimationCapture), "SkipDuringSweep");
        Type type = hero.GetType();
        Type[] twoBools = new Type[] { typeof(bool), typeof(bool) };

        Patch(Declared(AccessTools.Method(type, "UseSpecial", Type.EmptyTypes), Type.EmptyTypes), skip, "UseSpecial");
        Patch(Declared(AccessTools.Method(type, "UsePockettedSpecial", Type.EmptyTypes), Type.EmptyTypes), skip, "UsePockettedSpecial");
        Patch(Declared(AccessTools.Method(type, "PerformKnifeMeleeAttack", twoBools), twoBools), skip, "PerformKnifeMeleeAttack");
        Patch(Declared(AccessTools.Method(type, "PerformPunchAttack", twoBools), twoBools), skip, "PerformPunchAttack");

        PatchOverloads(typeof(Map), "HitUnits", skip);
        PatchOverloads(typeof(MapController), "DamageGround", skip);

        // Land dereferences the returned wave, so CreateShockWave cannot be skipped and the wave is retired instead
        Type[] threeFloats = new Type[] { typeof(float), typeof(float), typeof(float) };
        Patch(AccessTools.Method(typeof(EffectsController), "CreateShockWave", threeFloats), null,
            new HarmonyMethod(AccessTools.Method(typeof(AnimationCapture), "RetireDuringSweep")),
            "EffectsController.CreateShockWave");
    }

    private static void RetireDuringSweep(ExplosionGroundWave __result)
    {
        if (__result == null || !SweepLive()) return;
        __result.EffectDie();
    }

    private static void PatchOverloads(Type type, string name, MethodInfo prefix)
    {
        MethodInfo[] methods = type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                                               | BindingFlags.Instance | BindingFlags.DeclaredOnly);
        int found = 0;

        for (int i = 0; i < methods.Length; i++)
        {
            if (methods[i].Name != name || methods[i].IsGenericMethodDefinition) continue;
            found++;
            Patch(methods[i], prefix, type.Name + "." + name + "/" + methods[i].GetParameters().Length);
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
            Log("Not suppressing " + label + ": no such method on this build");
            return;
        }

        try
        {
            ScriptContext.Harmony.Patch(target, prefix, postfix);
        }
        catch (Exception ex)
        {
            Log("Could not suppress " + label + ": " + ex.Message);
        }
    }

    // Harmony reads a prefix's return value as "run the original", so this runs the original only
    // once the sweep is over or gone: while it is live, the call is skipped.
    private static bool SkipDuringSweep()
    {
        return !SweepLive();
    }

    private static bool SweepLive()
    {
        return instance != null && !instance.finished;
    }

    public static void Unload()
    {
        if (instance == null) return;

        instance.finished = true;
        instance.ReleaseTimeScale();
        instance.RestoreSnapshot();
        instance.RunAfter(null);
        instance.RestoreOverlays();
        instance.ReleaseBubbles();
        instance.DisposeCells();
        instance.ReleaseCaptureTexture();
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
        HideOverlays();
        HoldBubbles();

        SpriteSM body = GetSprite();
        Vector3 center = CropCenterOf(body);
        cropCenter = Vec(center);
        string intruder = ProbeOverlaps(body, center);
        if (intruder != null)
        {
            throw new Exception("another hero '" + intruder + "' that no player slot holds is drawn in the capture "
                + "crop and the sweep would strip it: raise swapSettle or wait for the old character to be destroyed");
        }
    }

    // The player-number bubble (Rambo(Clone)/Player1Bubble) hangs 16 units above the bro, inside the
    // crop, and the game puts back both its GameObject and its renderer within a frame. A zero
    // localScale is the one hold nothing undoes: ReactionBubble.CheckScale only ever flips the sign
    // of the scale it finds, so zero stays zero even if the object is re-activated mid-sweep.
    // Every bubble in the scene is held, not just this bro's: another unit's bubble drifts into the
    // crop just as easily.
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

                if (intruder == null) intruder = OtherCharacterOf(r);
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

    private string OtherCharacterOf(Renderer r)
    {
        Vector3 scale = r.transform.lossyScale;
        if (scale.x == 0f || scale.y == 0f) return null;

        for (Transform t = r.transform; t != null; t = t.parent)
        {
            TestVanDammeAnim rig = t.GetComponent<TestVanDammeAnim>();
            if (rig == null) continue;
            // IsEnemy is false only for heroes and rescue bros, and a RescueBro is a caged one the level owns
            if (rig == character || rig.IsEnemy || rig is RescueBro || HeldBySlot(rig) || IsCompanion(rig)) return null;
            return rig.gameObject.name;
        }
        return null;
    }

    private static bool HeldBySlot(TestVanDammeAnim rig)
    {
        if (HeroController.players == null) return false;

        for (int i = 0; i < HeroController.players.Length; i++)
        {
            Player slot = HeroController.players[i];
            if (slot != null && slot.character == rig) return true;
        }
        return false;
    }

    private bool IsCompanion(TestVanDammeAnim rig)
    {
        // Boondock Bros' trailing bro is a separate root that points back at its lead through leadingBro
        FieldInfo lead = AccessTools.Field(rig.GetType(), "leadingBro");
        if (lead == null) return false;
        TestVanDammeAnim leader = lead.GetValue(rig) as TestVanDammeAnim;
        return leader != null && leader == character;
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

    private void Update()
    {
        if (finished || awaitingCapture) return;

        if (!inState)
        {
            stateIndex++;
            if (stateIndex >= states.Count)
            {
                finished = true;
                Finish();
                return;
            }

            stateError = null;
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
        if (!awaitingCapture) return;

        awaitingCapture = false;
        RecordStep(frameIndex);
        frameIndex++;
    }

    // A lethal state kills the player and the game replaces the character object, so the stored
    // reference is a destroyed Unity object by the time the next state starts.
    private bool RefreshCharacter()
    {
        if (character != null) return true;

        try
        {
            character = ResolveCharacter(playerIndex);
            Log("Re-resolved the character after it was destroyed");
            return true;
        }
        catch (Exception ex)
        {
            stateError = "no character for player " + playerIndex + ": " + ex.Message;
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
            snapshot.Clear();
            stateSawWritten = false;
            stateOnscreenCells = 0;
            stateContributedCells = 0;
            stateEmptyCells = 0;
            stateContributionFailures.Clear();

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

            // Resolved before anything is pinned, so a state that names a method the character does
            // not have errors without having touched the bro
            currentBefore.Clear();
            currentAfter.Clear();
            afterPending = false;
            ResolveMethods(state["before"], "before", currentBefore);
            ResolveMethods(state["after"], "after", currentAfter);

            Remember(currentStepField);
            if (currentSetup != null)
            {
                foreach (JProperty prop in currentSetup.Properties()) Remember(prop.Name);
            }

            return true;
        }
        catch (Exception ex)
        {
            stateError = "state '" + currentName + "': " + ex.Message;
            return false;
        }
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
            stateError = "state '" + currentName + "' setup: " + ex.Message;
            return;
        }

        // From here on the state may have switched the bro, so its after list runs on every exit: a
        // clean finish, a step that threw, a before that threw, or an unload mid-sweep.
        afterPending = true;

        for (int i = 0; i < currentBefore.Count; i++)
        {
            string problem = CallOnCharacter(currentBefore[i], "before");
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
            string problem = CallOnCharacter(currentAfter[i], "after");
            if (problem == null) continue;
            problems = problems == null ? problem : problems + "; " + problem;
        }

        if (problems == null) return;
        // Logged as well as recorded: on the Unload path there is no record and no capture.json, so
        // the log line the driver's timeout tail prints is the only place this can surface
        Log(problems);
        if (record != null) record["afterError"] = problems;
        errors.Add(problems);
    }

    // Returns the failure message, or null: the caller decides where it belongs. Not named Invoke,
    // which would hide MonoBehaviour's own Invoke overloads.
    private string CallOnCharacter(MethodInfo method, string phase)
    {
        try
        {
            method.Invoke(character, null);
            return null;
        }
        catch (Exception ex)
        {
            // Reflection wraps whatever the method threw; the message is the useful half, and
            // reading StackTrace off a dynamically compiled frame crashes the game
            Exception cause = ex is TargetInvocationException && ex.InnerException != null
                ? ex.InnerException
                : ex;
            return "state '" + currentName + "' " + phase + " " + method.Name + ": " + cause.Message;
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
            ApplySetup();
            SetField(currentStepField, currentValues[index]);
            character.ForceChangeFrame();
            return true;
        }
        catch (Exception ex)
        {
            stateError = "state '" + currentName + "' step " + index + ": " + ex.Message;
            return false;
        }
    }

    private bool RecordStep(int index)
    {
        try
        {
            JObject frame = new JObject();
            frame["step"] = currentValues[index].DeepClone();

            bool offscreen;
            string contributionFailure;
            cells.Add(Crop(out offscreen, out contributionFailure));
            if (offscreen) frame["offscreen"] = true;
            else stateOnscreenCells++;

            SpriteSM body = GetSprite();
            frame["body"] = CellOf(body, body == null ? null : MaterialOf(body));

            SpriteSM gun = character.gunSprite;
            if (gun == null)
            {
                frame["gun"] = JValue.CreateNull();
            }
            else
            {
                JObject gunCell = CellOf(gun, MaterialOf(gun));
                gunCell["enabled"] = gun.gameObject.activeInHierarchy;
                frame["gun"] = gunCell;
            }

            if (!offscreen) RecordContribution(frame, index, contributionFailure, body, gun);

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
            stateError = "state '" + currentName + "' frame " + index + ": " + ex.Message;
            return false;
        }
    }

    private void RecordContribution(JObject frame, int index, string failure, SpriteSM body, SpriteSM gun)
    {
        frame["contributed"] = failure == null;
        if (failure == null)
        {
            stateContributedCells++;
            return;
        }

        if (failure == NoPixelFailure)
        {
            bool? empty = AddressedCellsEmpty(body, gun);
            if (empty.HasValue) frame["cellEmpty"] = empty.Value;
            if (empty.HasValue && empty.Value)
            {
                stateEmptyCells++;
                return;
            }
        }

        string message = "state '" + currentName + "' frame " + index + ": " + failure;
        stateContributionFailures.Add(message);
        Log(message);
    }

    private bool? AddressedCellsEmpty(SpriteSM body, SpriteSM gun)
    {
        if (body == null) return null;

        try
        {
            if (OpaqueInCell(body) > 0) return false;
            if (gun != null && gun.gameObject.activeInHierarchy && OpaqueInCell(gun) > 0) return false;
            return true;
        }
        catch (Exception ex)
        {
            if (!sheetReadLogged)
            {
                sheetReadLogged = true;
                Log("Could not read a sprite sheet to classify an uncontributed frame: " + ex.Message);
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
            throw new Exception("cell " + w + "x" + h + " at " + x + "," + y + " lies outside the "
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
            RestoreSnapshot();
            if (character != null) character.ForceChangeFrame();

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
            if (stateError == null) stateError = "state '" + currentName + "' teardown: " + ex.Message;
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
        for (int i = 0; i < stateContributionFailures.Count; i++) AddStateError(stateContributionFailures[i]);
    }

    // BeginState failed before the frame loop: keep its snapshot restored and log the state as errored
    private void FinishFailedState()
    {
        RestoreSnapshot();
        DisposeCells();

        JObject record = new JObject();
        record["name"] = currentName;
        record["skipped"] = new JValue("error: " + stateError);
        record["frames"] = currentFrames;
        stateRecords.Add(record);
        errors.Add(stateError);
    }

    private void Skip(string reason)
    {
        JObject record = new JObject();
        record["name"] = currentName;
        record["skipped"] = reason;
        record["frames"] = new JArray();
        stateRecords.Add(record);
    }

    private void Finish()
    {
        // First, and before anything that could throw: a later restore failing must never be able
        // to leave the game frozen
        ReleaseTimeScale();
        RestoreOverlays();
        ReleaseBubbles();
        ReleaseCaptureTexture();

        try
        {
            JObject doc = new JObject();
            doc["bro"] = DescribeBro();
            doc["states"] = stateRecords;
            doc["errors"] = errors;
            File.WriteAllText(Path.Combine(outDir, CaptureFile), doc.ToString());
        }
        catch (Exception ex)
        {
            fatal = "writing " + CaptureFile + ": " + ex.Message;
        }

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

    #endregion

    #region Field pinning

    private void Remember(string name)
    {
        if (snapshot.ContainsKey(name)) return;
        FieldInfo field = ResolveField(name);
        if (field == null) throw new Exception("unknown field '" + name + "'");
        snapshot[name] = field.GetValue(character);
    }

    private void RestoreSnapshot()
    {
        if (character == null) return;

        foreach (KeyValuePair<string, object> entry in snapshot)
        {
            try
            {
                FieldInfo field = ResolveField(entry.Key);
                if (field != null) field.SetValue(character, entry.Value);
            }
            catch (Exception ex)
            {
                Log("Could not restore " + entry.Key + ": " + ex.Message);
            }
        }
        snapshot.Clear();
    }

    private void ApplySetup()
    {
        if (currentSetup == null) return;
        foreach (JProperty prop in currentSetup.Properties()) SetField(prop.Name, prop.Value);
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
            into.Add(ResolveMethod(name));
        }
    }

    // Walks the character's type and its bases the way the field lookup does, at any visibility. Only
    // a parameterless instance method can be invoked with no arguments, so anything else is the
    // state's error, reported like an unknown setup field.
    private MethodInfo ResolveMethod(string name)
    {
        BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
                             | BindingFlags.DeclaredOnly;
        bool named = false;

        for (Type type = character.GetType(); type != null; type = type.BaseType)
        {
            MethodInfo[] methods = type.GetMethods(flags);
            for (int i = 0; i < methods.Length; i++)
            {
                MethodInfo method = methods[i];
                if (method.Name != name) continue;

                named = true;
                if (method.GetParameters().Length == 0 && !method.IsGenericMethodDefinition) return method;
            }
        }

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

    private Texture2D Crop(out bool offscreen, out string contributionFailure)
    {
        Texture2D cell = new Texture2D(cellPx, cellPx, TextureFormat.RGBA32, false);
        Color32[] pixels = new Color32[cellPx * cellPx];
        offscreen = true;
        contributionFailure = null;

        Camera cam = Camera.main;
        if (cam == null) cam = Camera.current;

        if (cam != null)
        {
            Vector3 center = CropCenterOf(GetSprite());
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
                if (r == null || !r.enabled) continue;
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

    // A lethal run can end with the character destroyed; the sweep's records matter more than the
    // description of who walked them, so a failure here costs a few fields, not capture.json.
    private JObject DescribeBro()
    {
        RefreshCharacter();

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

    private static JArray ReadStates(string path)
    {
        if (!File.Exists(path)) throw new Exception("state file not found: " + path);

        JToken root = JToken.Parse(File.ReadAllText(path));
        JArray states = root as JArray;
        JObject wrapper = root as JObject;
        if (states == null && wrapper != null) states = wrapper["states"] as JArray;
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
        return int.TryParse(raw, out value) ? value : fallback;
    }

    private static float ParseFloat(string raw, float fallback)
    {
        float value;
        return float.TryParse(raw, out value) ? value : fallback;
    }

    #endregion
}
