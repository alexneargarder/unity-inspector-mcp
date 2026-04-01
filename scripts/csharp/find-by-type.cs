// #name Find Objects By Type
// #description Find all active instances of a type in the scene with key state info
// #tags inspection, debugging
// #args typeName: Type name to search for (e.g., "Mook", "TestVanDammeAnim", "Projectile")
// #args maxResults: Maximum results to return (default: 50)

public static class FindByType
{
    public static void Main()
    {
        var typeName = ScriptContext.GetArg("typeName");
        var maxStr = ScriptContext.GetArg("maxResults", "50");

        if (string.IsNullOrEmpty(typeName))
        {
            ScriptContext.Logger("Usage: provide typeName arg (e.g., typeName=Mook)");
            return;
        }

        int maxResults;
        if (!int.TryParse(maxStr, out maxResults))
            maxResults = 50;

        // Find the type across all loaded assemblies
        Type targetType = null;
        var candidates = new List<Type>();

        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            try
            {
                foreach (var type in assembly.GetTypes())
                {
                    if (type.Name == typeName || type.FullName == typeName)
                    {
                        targetType = type;
                        break;
                    }
                    if (type.Name.Contains(typeName))
                    {
                        candidates.Add(type);
                    }
                }
                if (targetType != null) break;
            }
            catch { }
        }

        if (targetType == null && candidates.Count > 0)
        {
            ScriptContext.Logger("Exact type '" + typeName + "' not found. Similar types:");
            foreach (var c in candidates.Take(20))
            {
                ScriptContext.Logger("  " + c.FullName);
            }
            return;
        }

        if (targetType == null)
        {
            ScriptContext.Logger("Type not found: " + typeName);
            return;
        }

        if (!typeof(UnityEngine.Object).IsAssignableFrom(targetType))
        {
            ScriptContext.Logger(typeName + " is not a UnityEngine.Object subtype, cannot use FindObjectsOfType");
            return;
        }

        var objects = UnityEngine.Object.FindObjectsOfType(targetType);
        ScriptContext.Logger("Found " + objects.Length + " instances of " + targetType.FullName + ":");

        var count = 0;
        foreach (var obj in objects)
        {
            if (count >= maxResults)
            {
                ScriptContext.Logger("  ... and " + (objects.Length - maxResults) + " more");
                break;
            }

            var go = obj as GameObject;
            var comp = obj as Component;

            if (comp != null)
            {
                go = comp.gameObject;
            }

            if (go != null)
            {
                var pos = go.transform.position;
                var info = "  " + go.name + " (" + obj.GetType().Name + ")";
                info += " pos:(" + pos.x.ToString("F1") + ", " + pos.y.ToString("F1") + ")";
                info += go.activeSelf ? " [active]" : " [inactive]";

                // Try to get health for Unit subclasses
                if (obj is Unit)
                {
                    var unit = (Unit)obj;
                    info += " hp:" + unit.health;
                }

                ScriptContext.Logger(info);
            }
            else
            {
                ScriptContext.Logger("  " + obj.name + " (" + obj.GetType().Name + ")");
            }

            count++;
        }
    }
}
