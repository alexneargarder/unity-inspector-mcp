# C# Script Library

C# scripts that compile and run inside the game. `list_scripts` lists them with their descriptions and arguments, `execute_script` runs one and `unload_script` unloads it.

## Running a Script

`execute_script` takes a script's file name or its `// #name`, plus `args` for its arguments. A script outside this folder runs by absolute path; it just won't show up in `list_scripts`. `compileOnly: true` compiles it without running it, to check for errors.

`run-script.js` runs one script from the shell as soon as the game answers, for a script that has to be running in the game's first few seconds. `--wait` keeps trying until the game is up, and `--new-token` waits for a token other than the one the file held when it started, so you can start it before a relaunch.

```bash
node run-script.js --port <port> --token-file <file> [--host <host>] [--wait <seconds>] [--new-token] [--arg <key>=<value>]... <script>
```

## Script Format

Scripts are `.cs` files with optional comment-header metadata, which `list_scripts` reads:

```csharp
// #name Human-Readable Name
// #description What this script does and when to use it
// #tags comma, separated, tags
// #args paramName: Description of the parameter

public static class MyScript
{
    public static void Main()
    {
        var arg = ScriptContext.GetArg("paramName", "default");
        ScriptContext.Logger("Hello from script!");
    }

    public static void Unload()
    {
        // Undo what Main() did
    }
}
```

`Main()` runs the script and `Unload()` undoes it, and both are optional. Running a loaded script again unloads it first: `Unload()` runs and its patches and tracked GameObjects are removed, then `Main()` runs.

`ScriptContext` holds `Harmony` (the script's own Harmony instance, unpatched on unload), `Logger(msg)` (logs as `[Script:name]`), `GameObjects` (a `List<GameObject>` destroyed on unload), `Args` (a `Dictionary<string, string>` of the `args` passed) and `GetArg(key, defaultValue)`. `args` values arrive as strings, a non-string as its JSON text: `5`, `true`, `{"a":1}`.

- `Main()` and `Unload()` are each stopped at their next loop iteration once they have run 15 seconds.
- `ScriptContext.Harmony`, `GameObjects` and `Args` are null outside `Main()` and `Unload()`, so code that runs later (patches, coroutines, MonoBehaviours) keeps what it needs in a static field set in `Main()`.
- Opening the pause menu offline deactivates every GameObject not tagged `Unpausable`, and returning to the world map from it can lose an untagged `DontDestroyOnLoad` object for good, so tag a GameObject that outlives a scene `Unpausable`. `Time.time` keeps counting under the pause menu.

## Limits

- .NET 3.5: no `async`/`await` or `string.IsNullOrWhiteSpace`, and `string.Join` needs a `string[]`, so call `.ToArray()` on a list first. No local functions either: use a delegate local.
- Unity 2017.4: no `GameObject.TryGetComponent` or `FindAnyObjectByType`/`FindObjectsByType`; use `GetComponent` plus a null check and `FindObjectOfType`/`FindObjectsOfType`.
- The game's own `Math` class hides `System.Math` and has no `Min`, `Max`, `Log` or `Abs`: use `System.Math` or `Mathf`.
- An enum a script declares can't be used, by that script or any other: use `int` constants or an enum from a mod DLL.
- Stack traces name the script's methods but carry no file names or line numbers.

## Capturing Spawn Calls

`spawn-capture` writes to the log `read_log` reads, and its patches stay after it has logged `captureCount` calls, so unload it once you have the captures.
