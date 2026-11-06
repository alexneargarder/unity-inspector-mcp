// #name Diff Component
// #description Log every value on a live component that differs from a default of the same kind. Needs RocketLib.
// #tags inspection, debugging, diff, units, rocketlib
// #args path: GameObject path or name
// #args component: Component type. Default: its NetworkedUnit/Unit/TestVanDammeAnim
// #args against: "prefab" for RocketLib's UnitType prefab (Unit default), "fresh" for a new component on a throwaway object (default otherwise), or a GameObject path
// #args maxDifferences: Differences to log before stopping (default 50)

using RocketLib.Utils;

public static class DiffComponent
{
    private static GameObject scratch;

    // Renderer.material/materials and Collider.material instantiate a private copy of the shared material
    // and assign it back, so a comparer that reads every property would mutate the objects it compares
    private static readonly string[] MaterialProperties = { "material", "materials", "sharedMaterial", "sharedMaterials", "mesh" };

    public static void Main()
    {
        try
        {
            Run();
        }
        finally
        {
            DestroyScratch();
        }
    }

    public static void Unload()
    {
        DestroyScratch();
    }

    private static void Run()
    {
        string path = ScriptContext.GetArg("path", "");
        if (string.IsNullOrEmpty(path))
        {
            ScriptContext.Logger("Usage: path=<GameObject path or name> [component=<TypeName>] [against=prefab|fresh|<GameObject path>] [maxDifferences=<n>]");
            return;
        }

        GameObject go = FindGameObject(path);
        if (go == null)
        {
            ScriptContext.Logger("GameObject not found: " + path);
            return;
        }

        string componentName = ScriptContext.GetArg("component", "");
        Component live = string.IsNullOrEmpty(componentName)
            ? go.GetComponent<NetworkedUnit>()
            : FindComponent(go, componentName);

        if (live == null)
        {
            if (string.IsNullOrEmpty(componentName))
                ScriptContext.Logger("No unit component on " + HierarchyPath(go) + " — pass component=<TypeName>. Has: " + ComponentNames(go));
            else
                ScriptContext.Logger("Component " + componentName + " not found on " + HierarchyPath(go) + ". Has: " + ComponentNames(go));
            return;
        }

        int maxDifferences;
        if (!int.TryParse(ScriptContext.GetArg("maxDifferences", "50"), out maxDifferences))
            maxDifferences = 50;

        string against = ScriptContext.GetArg("against", "");
        bool defaulted = string.IsNullOrEmpty(against);
        if (defaulted)
            against = live is Unit ? "prefab" : "fresh";

        string label;
        Component reference;
        try
        {
            reference = ResolveReference(live, against, defaulted, out label);
        }
        catch (Exception ex)
        {
            ScriptContext.Logger("Could not resolve against=" + against + ": " + ex.GetType().Name + ": " + ex.Message);
            return;
        }

        if (reference == null)
            return;

        HashSet<string> skipProperties = ComparerSkipProperties();
        if (skipProperties == null)
        {
            ScriptContext.Logger("This RocketLib's ObjectComparer has no SkipProperties set to add to — reading the material properties would instantiate a copy of every shared material, so the diff was not run");
            return;
        }

        List<string> added = new List<string>();
        foreach (string name in MaterialProperties)
        {
            if (skipProperties.Add(name))
                added.Add(name);
        }

        Type comparedType = SharedType(live, reference);
        List<Difference> differences;
        try
        {
            differences = Compare(comparedType, live, reference);
        }
        finally
        {
            foreach (string name in added)
                skipProperties.Remove(name);
        }

        if (differences == null)
            return;

        int logged = 0;
        foreach (Difference difference in differences)
        {
            if (logged >= maxDifferences)
            {
                ScriptContext.Logger("... " + (differences.Count - logged) + " more");
                break;
            }

            ScriptContext.Logger(difference.PropertyPath + ": '" + difference.Value1 + "' vs '" + difference.Value2 + "'");
            logged++;
        }

        ScriptContext.Logger(differences.Count + (differences.Count == 1 ? " difference: " : " differences: ")
            + comparedType.Name + " on " + HierarchyPath(go) + " vs " + label);
    }

    private static Component ResolveReference(Component live, string against, bool defaulted, out string label)
    {
        label = null;

        if (string.Equals(against, "prefab", StringComparison.OrdinalIgnoreCase))
            return PrefabReference(live, defaulted, out label);

        if (string.Equals(against, "fresh", StringComparison.OrdinalIgnoreCase))
            return FreshReference(live, out label);

        GameObject other = FindGameObject(against);
        if (other == null)
        {
            ScriptContext.Logger("GameObject not found for against=" + against);
            return null;
        }

        Component reference = other.GetComponent(live.GetType());
        if (reference == null)
        {
            ScriptContext.Logger(HierarchyPath(other) + " has no " + live.GetType().Name + ". Has: " + ComponentNames(other));
            return null;
        }

        label = HierarchyPath(other);
        return reference;
    }

    // The prefab is read in place, never instantiated — ObjectComparer only reflects over it, and the
    // material getters are skipped, which is what keeps a read from instantiating its shared materials
    private static Component PrefabReference(Component live, bool allowFresh, out string label)
    {
        label = null;

        Unit unit = live as Unit;
        if (unit == null)
            unit = live.GetComponent<Unit>();

        if (unit == null)
        {
            ScriptContext.Logger("against=prefab needs a Unit on the object — use against=fresh or a GameObject path");
            return null;
        }

        if (Map.Instance == null)
        {
            ScriptContext.Logger("against=prefab needs a loaded level — the unit prefabs hang off Map.Instance");
            return null;
        }

        UnitType type = unit.GetUnitType();
        Unit prefab = type.GetUnitPrefab();
        if (prefab == null)
        {
            if (!allowFresh)
            {
                ScriptContext.Logger("No prefab for UnitType." + type + " — use against=fresh or a GameObject path");
                return null;
            }

            ScriptContext.Logger("No prefab for UnitType." + type + " — comparing against a fresh " + live.GetType().Name + " instead");
            return FreshReference(live, out label);
        }

        if (ReferenceEquals(live, unit))
        {
            label = "prefab of UnitType." + type;
            return prefab;
        }

        Component reference = prefab.GetComponent(live.GetType());
        if (reference == null)
        {
            ScriptContext.Logger("The UnitType." + type + " prefab has no " + live.GetType().Name + " — use against=fresh");
            return null;
        }

        label = live.GetType().Name + " on the prefab of UnitType." + type;
        return reference;
    }

    private static Component FreshReference(Component live, out string label)
    {
        label = null;
        Type type = live.GetType();

        scratch = new GameObject("DiffComponent (" + type.Name + ")");
        // Deactivated before the component is added, so it never gets Awake/OnEnable/Start and cannot touch the game
        scratch.SetActive(false);
        if (ScriptContext.GameObjects != null)
            ScriptContext.GameObjects.Add(scratch);

        Component reference = typeof(Transform).IsAssignableFrom(type) ? scratch.transform : scratch.AddComponent(type);
        if (reference == null)
        {
            ScriptContext.Logger("Could not add a fresh " + type.Name + " to compare against");
            return null;
        }

        label = "a fresh " + reference.GetType().Name;
        return reference;
    }

    private static HashSet<string> ComparerSkipProperties()
    {
        FieldInfo field = typeof(ObjectComparer).GetField("SkipProperties", BindingFlags.NonPublic | BindingFlags.Static);
        return field == null ? null : field.GetValue(null) as HashSet<string>;
    }

    // ObjectComparer.Compare<T> reflects over typeof(T) rather than the runtime type, so calling it with
    // Component-typed arguments would only compare Component's own members
    private static List<Difference> Compare(Type type, Component live, Component reference)
    {
        MethodInfo compare = typeof(ObjectComparer).GetMethod("Compare", BindingFlags.Public | BindingFlags.Static);
        if (compare == null)
        {
            ScriptContext.Logger("This RocketLib's ObjectComparer has no public static Compare");
            return null;
        }

        return (List<Difference>)compare.MakeGenericMethod(type).Invoke(null, new object[] { live, reference });
    }

    private static Type SharedType(Component live, Component reference)
    {
        Type type = live.GetType();
        while (type != null && !type.IsInstanceOfType(reference))
            type = type.BaseType;
        return type ?? typeof(Component);
    }

    private static GameObject FindGameObject(string path)
    {
        GameObject go = GameObject.Find(path);
        if (go != null)
            return go;

        string rooted = path.StartsWith("/") ? path : "/" + path;
        GameObject asset = null;
        foreach (Transform transform in Resources.FindObjectsOfTypeAll<Transform>())
        {
            if (transform == null || transform.gameObject == null || HierarchyPath(transform.gameObject) != rooted)
                continue;
            if (transform.gameObject.scene.IsValid())
                return transform.gameObject;
            if (asset == null)
                asset = transform.gameObject;
        }

        if (asset != null)
            ScriptContext.Logger(path + " matches no object in a loaded scene; using the prefab asset at that path.");
        return asset;
    }

    private static Component FindComponent(GameObject go, string typeName)
    {
        foreach (Component component in go.GetComponents<Component>())
        {
            if (component == null)
                continue;

            Type type = component.GetType();
            if (type.Name == typeName || type.FullName == typeName)
                return component;
        }

        return null;
    }

    private static string ComponentNames(GameObject go)
    {
        return string.Join(", ", go.GetComponents<Component>()
            .Where(c => c != null)
            .Select(c => c.GetType().Name)
            .ToArray());
    }

    private static string HierarchyPath(GameObject go)
    {
        string path = go.name;
        Transform parent = go.transform.parent;
        while (parent != null)
        {
            path = parent.name + "/" + path;
            parent = parent.parent;
        }

        return "/" + path;
    }

    private static void DestroyScratch()
    {
        if (scratch != null)
        {
            if (ScriptContext.GameObjects != null)
                ScriptContext.GameObjects.Remove(scratch);
            UnityEngine.Object.Destroy(scratch);
        }

        scratch = null;
    }
}
