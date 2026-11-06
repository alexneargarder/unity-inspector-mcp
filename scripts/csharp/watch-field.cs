// #name Watch Field
// #description Monitor a field on a component and log whenever its value changes. Runs until unloaded.
// #tags debugging, monitoring
// #args gameObjectName: Name of the GameObject to watch
// #args componentType: Type name of the component (e.g., "TestVanDammeAnim")
// #args fieldName: Name of the field to watch (e.g., "health")

public static class WatchField
{
    private static GameObject watcherGO;
    // ScriptContext.Logger only carries the [Script:name] prefix while Main()/Unload() is running
    internal static System.Action<string> cachedLogger;

    public static void Main()
    {
        cachedLogger = ScriptContext.Logger;
        var goName = ScriptContext.GetArg("gameObjectName");
        var compType = ScriptContext.GetArg("componentType");
        var fieldName = ScriptContext.GetArg("fieldName");

        if (string.IsNullOrEmpty(goName) || string.IsNullOrEmpty(compType) || string.IsNullOrEmpty(fieldName))
        {
            ScriptContext.Logger("Usage: provide gameObjectName, componentType, and fieldName args");
            return;
        }

        bool isAsset;
        var go = FindGameObject(goName, out isAsset);
        if (go == null)
        {
            ScriptContext.Logger("GameObject not found: " + goName);
            return;
        }
        if (isAsset)
            ScriptContext.Logger(goName + " matches no object in a loaded scene; watching the prefab asset of that name, which the game does not change.");

        var comp = go.GetComponents<Component>()
            .FirstOrDefault(c => c != null && (c.GetType().Name == compType || c.GetType().FullName == compType));

        if (comp == null)
        {
            ScriptContext.Logger("Component " + compType + " not found on " + goName);
            return;
        }

        FieldInfo field = null;
        // GetField never returns a base class's private field
        for (var t = comp.GetType(); field == null && t != null && t != typeof(MonoBehaviour) && t != typeof(Behaviour) && t != typeof(Component); t = t.BaseType)
            field = t.GetField(fieldName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);

        if (field == null)
        {
            ScriptContext.Logger("Field " + fieldName + " not found on " + compType);
            return;
        }

        watcherGO = new GameObject("FieldWatcher_" + fieldName);
        watcherGO.tag = "Unpausable";
        UnityEngine.Object.DontDestroyOnLoad(watcherGO);
        ScriptContext.GameObjects.Add(watcherGO);

        var watcher = watcherGO.AddComponent<FieldWatcher>();
        watcher.target = comp;
        watcher.field = field;
        watcher.fieldName = fieldName;
        watcher.targetName = goName + "." + compType + "." + fieldName +
            (field.DeclaringType == comp.GetType() ? "" : " (" + field.DeclaringType.Name + ")");

        try
        {
            var initialValue = field.GetValue(comp);
            watcher.lastValue = initialValue != null ? initialValue.ToString() : "null";
        }
        catch
        {
            watcher.lastValue = "<error>";
        }

        ScriptContext.Logger("Watching " + watcher.targetName + " (current: " + watcher.lastValue + "). Use unload_script to stop.");
    }

    private static GameObject FindGameObject(string name, out bool isAsset)
    {
        isAsset = false;
        var go = GameObject.Find(name);
        if (go != null) return go;

        GameObject asset = null;
        foreach (var candidate in Resources.FindObjectsOfTypeAll<GameObject>())
        {
            if (candidate == null || candidate.name != name) continue;
            if (candidate.scene.IsValid()) return candidate;
            if (asset == null) asset = candidate;
        }
        isAsset = asset != null;
        return asset;
    }

    public static void Unload()
    {
        ScriptContext.Logger("Field watcher stopped.");
    }
}

public class FieldWatcher : MonoBehaviour
{
    public Component target;
    public FieldInfo field;
    public string fieldName;
    public string targetName;
    public string lastValue;

    void Update()
    {
        if (target == null || field == null)
        {
            var log = WatchField.cachedLogger;
            if (log != null)
                log(targetName + ": the watched object was destroyed; nothing more to watch. Use unload_script to stop.");
            enabled = false;
            return;
        }

        try
        {
            var currentObj = field.GetValue(target);
            var currentValue = currentObj != null ? currentObj.ToString() : "null";

            if (currentValue != lastValue)
            {
                var log = WatchField.cachedLogger;
                if (log != null)
                    log(targetName + ": " + lastValue + " -> " + currentValue);

                lastValue = currentValue;
            }
        }
        catch
        {
            // Target may have been destroyed
        }
    }
}
