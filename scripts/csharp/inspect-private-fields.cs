// #name Inspect Private Fields
// #description Dump all field values (including private) of a component on a named GameObject
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

        ScriptContext.Logger(goName + " -> " + comp.GetType().FullName + ":");

        var fields = comp.GetType().GetFields(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);

        foreach (var field in fields.OrderBy(f => f.Name))
        {
            try
            {
                var value = field.GetValue(comp);
                var access = field.IsPublic ? "public" : field.IsPrivate ? "private" : "protected";
                var valueStr = value == null ? "null" : value.ToString();
                if (valueStr.Length > 200)
                    valueStr = valueStr.Substring(0, 200) + "...";
                ScriptContext.Logger("  [" + access + "] " + field.FieldType.Name + " " +
                    field.Name + " = " + valueStr);
            }
            catch (Exception ex)
            {
                ScriptContext.Logger("  " + field.Name + " = <error: " + ex.Message + ">");
            }
        }
    }
}
