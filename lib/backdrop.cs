    public static readonly string[] KeptTypes = {
        "NetworkedUnit", "BossBlockPiece", "BossBlockWeapon", "BossSlugMover", "BossSlugFace", "BossSatan*",
        "Projectile", "Shrapnel",
    };
    public static readonly string[] HiddenTypes = {
        "ReactionBubble", "MapController", "ParallaxFollow", "ParallaxWeatherShifter", "HeroTransport", "Helicopter",
        "EffectsHolderTheme", "AssMouthOrifice", "JungleSeagull",
    };
    public static readonly string[] HiddenObjects = { "Cameras/RainHolder" };
    public static readonly string[] PlacedThrowableTypes = { "Coconut", "TrashBag" };
    public static readonly string[] MapRootTypes = { "MapController" };
    public static readonly string[] SkippedCameraLayers = { "UI", "FLUI", "Victory", "Cutscene" };

    public const string DefaultColour = "#FF00FF";
    private const int KeptMark = 1;
    private const int HiddenMark = 2;
    private const int ThrowableMark = 4;
    private const int MapRootMark = 8;
    private const int KeptScreenshots = 50;

    private static readonly Dictionary<Type, int> typeMarks = new Dictionary<Type, int>();

    public static Color32 ParseColour(string hex)
    {
        int value;
        if (hex == null || hex.Length != 7 || hex[0] != '#'
            || !int.TryParse(hex.Substring(1), System.Globalization.NumberStyles.AllowHexSpecifier,
                System.Globalization.CultureInfo.InvariantCulture, out value))
        {
            throw new Exception("backdrop must be a colour as #RRGGBB, got '" + hex + "'");
        }
        return new Color32((byte)((value >> 16) & 0xFF), (byte)((value >> 8) & 0xFF), (byte)(value & 0xFF), 255);
    }

    // Disabled and hidden, so it joins no frame's own render and no Camera.allCameras
    public static Camera CreateCamera()
    {
        GameObject go = new GameObject("UnityInspectorBackdropCamera");
        go.hideFlags = HideFlags.HideAndDontSave;
        Camera cam = go.AddComponent<Camera>();
        cam.enabled = false;
        return cam;
    }

    public static List<Renderer> HiddenRenderers()
    {
        List<Renderer> hidden = new List<Renderer>();
        Dictionary<int, bool> decided = new Dictionary<int, bool>();
        List<int> walked = new List<int>();
        Renderer[] renderers = UnityEngine.Object.FindObjectsOfType<Renderer>();

        for (int i = 0; i < renderers.Length; i++)
        {
            Renderer r = renderers[i];
            if (r == null || !r.enabled) continue;
            if (IsHidden(r.transform, decided, walked)) hidden.Add(r);
        }
        return hidden;
    }

    private static bool IsHidden(Transform start, Dictionary<int, bool> decided, List<int> walked)
    {
        walked.Clear();
        bool hide = false;
        for (Transform t = start; t != null; t = t.parent)
        {
            int id = t.GetInstanceID();
            bool known;
            if (decided.TryGetValue(id, out known))
            {
                hide = known;
                break;
            }
            walked.Add(id);

            int marks = ObjectMarks(t);
            if ((marks & ThrowableMark) != 0 && UnderMapRoot(t))
            {
                hide = true;
                break;
            }
            if ((marks & KeptMark) != 0)
            {
                hide = false;
                break;
            }
            if ((marks & HiddenMark) != 0 || IsHiddenObject(t))
            {
                hide = true;
                break;
            }
        }

        for (int i = 0; i < walked.Count; i++) decided[walked[i]] = hide;
        return hide;
    }

    private static int ObjectMarks(Transform t)
    {
        int marks = 0;
        MonoBehaviour[] behaviours = t.GetComponents<MonoBehaviour>();
        for (int i = 0; i < behaviours.Length; i++)
        {
            // A component whose script is missing comes back null
            if (behaviours[i] != null) marks |= TypeMarks(behaviours[i].GetType());
        }
        return marks;
    }

    private static int TypeMarks(Type type)
    {
        int marks;
        if (typeMarks.TryGetValue(type, out marks)) return marks;

        marks = 0;
        for (Type t = type; t != null; t = t.BaseType)
        {
            if (Listed(KeptTypes, t.Name)) marks |= KeptMark;
            if (Listed(HiddenTypes, t.Name)) marks |= HiddenMark;
            if (Listed(PlacedThrowableTypes, t.Name)) marks |= ThrowableMark;
            if (Listed(MapRootTypes, t.Name)) marks |= MapRootMark;
        }
        typeMarks[type] = marks;
        return marks;
    }

    private static bool Listed(string[] names, string name)
    {
        for (int i = 0; i < names.Length; i++)
        {
            string entry = names[i];
            if (entry.EndsWith("*"))
            {
                if (name.StartsWith(entry.Substring(0, entry.Length - 1), StringComparison.Ordinal)) return true;
            }
            else if (entry == name) return true;
        }
        return false;
    }

    private static bool UnderMapRoot(Transform t)
    {
        for (Transform up = t.parent; up != null; up = up.parent)
        {
            if ((ObjectMarks(up) & MapRootMark) != 0) return true;
        }
        return false;
    }

    private static bool IsHiddenObject(Transform t)
    {
        for (int i = 0; i < HiddenObjects.Length; i++)
        {
            string[] names = HiddenObjects[i].Split('/');
            Transform at = t;
            int n = names.Length - 1;
            while (n >= 0 && at != null && at.name == names[n])
            {
                at = at.parent;
                n--;
            }
            if (n < 0) return true;
        }
        return false;
    }

    public static List<Camera> Cameras()
    {
        int skipped = 0;
        for (int i = 0; i < SkippedCameraLayers.Length; i++)
        {
            int layer = LayerMask.NameToLayer(SkippedCameraLayers[i]);
            if (layer >= 0) skipped |= 1 << layer;
        }

        List<Camera> chosen = new List<Camera>();
        Camera[] all = Camera.allCameras;
        for (int i = 0; i < all.Length; i++)
        {
            Camera cam = all[i];
            if (cam == null || cam.targetTexture != null) continue;
            if (cam.cullingMask == 0 || (cam.cullingMask & skipped) != 0) continue;
            chosen.Add(cam);
        }

        chosen.Sort(new Comparison<Camera>(CompareByDepth));
        return chosen;
    }

    private static int CompareByDepth(Camera a, Camera b)
    {
        return a.depth.CompareTo(b.depth);
    }

    public static int Render(RenderTexture target, Camera temp, Color32 colour, List<Renderer> hidden)
    {
        List<Renderer> disabled = new List<Renderer>();
        List<Camera> cameras;
        try
        {
            for (int i = 0; i < hidden.Count; i++)
            {
                Renderer r = hidden[i];
                if (r == null || !r.enabled) continue;
                r.enabled = false;
                disabled.Add(r);
            }

            RenderTexture previousActive = RenderTexture.active;
            try
            {
                RenderTexture.active = target;
                GL.Clear(true, true, colour);
            }
            finally
            {
                RenderTexture.active = previousActive;
            }

            cameras = Cameras();
            for (int i = 0; i < cameras.Count; i++)
            {
                // CopyFrom also takes the camera's transform and its targetTexture
                temp.CopyFrom(cameras[i]);
                temp.enabled = false;
                temp.clearFlags = CameraClearFlags.Depth;
                temp.targetTexture = target;
                temp.Render();
            }
        }
        finally
        {
            for (int i = 0; i < disabled.Count; i++)
            {
                if (disabled[i] != null) disabled[i].enabled = true;
            }
            temp.targetTexture = null;
        }
        return cameras.Count;
    }

    public static string Screenshot(string hex)
    {
        Color32 colour = ParseColour(hex);
        int width = Mathf.Max(1, Screen.width);
        int height = Mathf.Max(1, Screen.height);
        RenderTexture previousActive = RenderTexture.active;
        RenderTexture target = new RenderTexture(width, height, 24);
        Camera temp = null;
        Texture2D image = null;
        byte[] png;

        try
        {
            target.Create();
            temp = CreateCamera();
            if (Render(target, temp, colour, HiddenRenderers()) == 0) throw new Exception("no screen camera to render");

            image = new Texture2D(width, height, TextureFormat.RGB24, false);
            RenderTexture.active = target;
            image.ReadPixels(new Rect(0, 0, width, height), 0, 0);
            image.Apply();
            RenderTexture.active = previousActive;
            png = image.EncodeToPNG();
        }
        finally
        {
            RenderTexture.active = previousActive;
            if (temp != null) UnityEngine.Object.DestroyImmediate(temp.gameObject);
            target.Release();
            UnityEngine.Object.DestroyImmediate(target);
            if (image != null) UnityEngine.Object.DestroyImmediate(image);
        }

        return SaveScreenshot(png);
    }

    private static string SaveScreenshot(byte[] png)
    {
        string folder = System.IO.Path.Combine(ModFolder(), "Screenshots");
        System.IO.Directory.CreateDirectory(folder);
        string stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss");
        string id = Guid.NewGuid().ToString("N").Substring(0, 8);
        string path = System.IO.Path.Combine(folder, "screenshot_" + stamp + "_" + id + ".png");
        System.IO.File.WriteAllBytes(path, png);
        PruneScreenshots(folder, path);
        return Application.platform == RuntimePlatform.LinuxPlayer ? path : path.Replace('\\', '/');
    }

    // Main is internal to the mod's assembly, so script code reaches it by reflection
    private static string ModFolder()
    {
        Type main = typeof(ScriptContext).Assembly.GetType("Unity_Inspector_Mod.Main");
        FieldInfo field = main == null ? null : main.GetField("mod", BindingFlags.Public | BindingFlags.Static);
        UnityModManagerNet.UnityModManager.ModEntry entry =
            field == null ? null : field.GetValue(null) as UnityModManagerNet.UnityModManager.ModEntry;
        if (entry == null) throw new Exception("could not read the Unity Inspector Mod's folder from Unity_Inspector_Mod.Main.mod");
        return entry.Path;
    }

    private static void PruneScreenshots(string folder, string keep)
    {
        try
        {
            string kept = System.IO.Path.GetFullPath(keep);
            System.IO.FileInfo[] files = new System.IO.DirectoryInfo(folder).GetFiles("screenshot_*.png");
            List<System.IO.FileInfo> older = new List<System.IO.FileInfo>();
            for (int i = 0; i < files.Length; i++)
            {
                if (!string.Equals(files[i].FullName, kept, StringComparison.Ordinal)) older.Add(files[i]);
            }
            older.Sort(new Comparison<System.IO.FileInfo>(NewestFirst));
            for (int i = KeptScreenshots - 1; i < older.Count; i++) older[i].Delete();
        }
        catch (Exception ex)
        {
            Console.WriteLine("[Unity Inspector backdrop] Could not prune old screenshots: " + ex.Message);
        }
    }

    private static int NewestFirst(System.IO.FileInfo a, System.IO.FileInfo b)
    {
        return b.LastWriteTimeUtc.CompareTo(a.LastWriteTimeUtc);
    }
