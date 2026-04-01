// #name Watch Field
// #description Monitor a field on a component and log whenever its value changes. Runs until unloaded.
// #tags debugging, monitoring
// #args gameObjectName: Name of the GameObject to watch
// #args componentType: Type name of the component (e.g., "TestVanDammeAnim")
// #args fieldName: Name of the field to watch (e.g., "health")

public static class WatchField
{
    private static GameObject watcherGO;

    public static void Main()
    {
        var goName = ScriptContext.GetArg("gameObjectName");
        var compType = ScriptContext.GetArg("componentType");
        var fieldName = ScriptContext.GetArg("fieldName");

        if (string.IsNullOrEmpty(goName) || string.IsNullOrEmpty(compType) || string.IsNullOrEmpty(fieldName))
        {
            ScriptContext.Logger("Usage: provide gameObjectName, componentType, and fieldName args");
            return;
        }

        var go = GameObject.Find(goName);
        if (go == null)
        {
            var allObjects = Resources.FindObjectsOfTypeAll<GameObject>();
            go = allObjects.FirstOrDefault(g => g.name == goName);
        }

        if (go == null)
        {
            ScriptContext.Logger("GameObject not found: " + goName);
            return;
        }

        var comp = go.GetComponents<Component>()
            .FirstOrDefault(c => c != null && (c.GetType().Name == compType || c.GetType().FullName == compType));

        if (comp == null)
        {
            ScriptContext.Logger("Component " + compType + " not found on " + goName);
            return;
        }

        var field = comp.GetType().GetField(fieldName,
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);

        if (field == null)
        {
            ScriptContext.Logger("Field " + fieldName + " not found on " + compType);
            return;
        }

        watcherGO = new GameObject("FieldWatcher_" + fieldName);
        UnityEngine.Object.DontDestroyOnLoad(watcherGO);
        ScriptContext.GameObjects.Add(watcherGO);

        var watcher = watcherGO.AddComponent<FieldWatcher>();
        watcher.target = comp;
        watcher.field = field;
        watcher.fieldName = fieldName;
        watcher.targetName = goName + "." + compType + "." + fieldName;

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
            return;
        }

        try
        {
            var currentObj = field.GetValue(target);
            var currentValue = currentObj != null ? currentObj.ToString() : "null";

            if (currentValue != lastValue)
            {
                UnityModManager.ModEntry mod = null;
                foreach (var m in UnityModManager.modEntries)
                {
                    if (m.Info.Id == "Unity Inspector Mod")
                    {
                        mod = m;
                        break;
                    }
                }
                if (mod != null)
                    mod.Logger.Log("[Script:watch-field] " + targetName + ": " + lastValue + " -> " + currentValue);

                lastValue = currentValue;
            }
        }
        catch
        {
            // Target may have been destroyed
        }
    }
}
