// #name Inspect Private Fields
// #description Dump every field value, private and inherited ones included, of a component on a named GameObject
// #tags inspection, debugging
// #args gameObjectName: Name of the GameObject to inspect
// #args componentType: Type name of the component (e.g., "TestVanDammeAnim")

public static class InspectPrivateFields
{
    public static void Main()
    {
        var goName = ScriptContext.GetArg("gameObjectName");
        var compType = ScriptContext.GetArg("componentType");

        if (string.IsNullOrEmpty(goName) || string.IsNullOrEmpty(compType))
        {
            ScriptContext.Logger("Usage: provide gameObjectName and componentType args");
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
            ScriptContext.Logger(goName + " matches no object in a loaded scene; this is the prefab asset of that name.");

        var components = go.GetComponents<Component>();
        var comp = components.FirstOrDefault(c =>
            c != null && (c.GetType().Name == compType || c.GetType().FullName == compType));

        if (comp == null)
        {
            ScriptContext.Logger("Component " + compType + " not found on " + goName);
            ScriptContext.Logger("Available components:");
            foreach (var c in components)
            {
                if (c != null)
                    ScriptContext.Logger("  " + c.GetType().FullName);
            }
            return;
        }

        var type = comp.GetType();
        ScriptContext.Logger(goName + " -> " + type.FullName + ":");

        foreach (var field in AllFields(type).OrderBy(f => f.Name))
        {
            var declared = field.DeclaringType == type ? "" : " (" + field.DeclaringType.Name + ")";
            try
            {
                var value = field.GetValue(comp);
                var access = field.IsPublic ? "public" : field.IsPrivate ? "private" : "protected";
                var valueStr = value == null ? "null" : value.ToString();
                if (valueStr.Length > 200)
                    valueStr = valueStr.Substring(0, 200) + "...";
                ScriptContext.Logger("  [" + access + "] " + field.FieldType.Name + " " +
                    field.Name + declared + " = " + valueStr);
            }
            catch (Exception ex)
            {
                ScriptContext.Logger("  " + field.Name + declared + " = <error: " + ex.Message + ">");
            }
        }
    }

    private static List<FieldInfo> AllFields(Type type)
    {
        var fields = new List<FieldInfo>();
        // GetFields never returns a base class's private fields
        for (var t = type; t != null && t != typeof(MonoBehaviour) && t != typeof(Behaviour) && t != typeof(Component); t = t.BaseType)
            fields.AddRange(t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly));
        return fields;
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
}
