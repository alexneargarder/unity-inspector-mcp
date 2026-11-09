# Steam launch details

These are the commands `launch_game` runs on each platform when `BROFORCE_LAUNCH_CMD` isn't set, and the files of yours it changes.

## Finding Steam

On Windows the server reads the `InstallPath` value of `HKLM\SOFTWARE\WOW6432Node\Valve\Steam` from the registry, then the `SteamPath` value of `HKCU\Software\Valve\Steam`, and runs `steam.exe` in that folder.

On Linux it uses `steam` on `PATH`, or else `steam.sh` in `~/.local/share/Steam` or `~/.steam/steam`. Flatpak Steam is run with `flatpak run com.valvesoftware.Steam`, when `flatpak` is on `PATH`.

If none of those are found, or on macOS, the server does a protocol launch of `steam://rungameid/274190` through `cmd /c start ""` on Windows, `xdg-open` on Linux and `open` on macOS. That passes no arguments, so `launchArgs` and `vanilla` are dropped and the reply's note names them. The server then waits up to 60 seconds for the game to answer.

## Finding the profile

A `BROFORCE_PROFILE` name, or `Default` when it isn't set, is looked up in r2modman's profiles folder, `r2modmanPlus-local/Broforce/profiles`. On Linux that folder is under `$XDG_CONFIG_HOME` (or `~/.config`), and the Flatpak r2modman's `profiles` folder is checked after it. On Windows it's under `%APPDATA%`. If you've moved r2modman's data folder somewhere else, set `BROFORCE_PROFILE` to the profile's full path. If the profile you name doesn't have Unity Mod Manager in it, the launch is refused before anything runs and the reply lists the paths it looked at.

## Doorstop arguments

These are the arguments r2modman passes. Modded, with Doorstop 4:

```
--doorstop-enabled true --doorstop-target-assembly <profile>/UMM/Core/UnityModManager.dll
```

For vanilla it's `--doorstop-enabled false`. Doorstop 3 uses `--doorstop-enable` and `--doorstop-target` in place of those. The version comes from the profile's `.doorstop_version`, or the game folder's if the profile doesn't have one, and is 3 if neither does.

If `BROFORCE_PROFILE` isn't set and no profiles folder has a `Default` profile with Unity Mod Manager in it, no Doorstop arguments are passed and the game starts the way its own install loads mods (Unity Mod Manager installed into the game itself). Vanilla then only works when the game folder has `winhttp.dll`, `doorstop_config.ini`, or `run_umm.sh` together with `.doorstop_version`. Otherwise the reply says `--vanilla` was ignored.

## Windows

```
steam.exe -applaunch 274190 <Doorstop arguments> <launchArgs>
```

Windows doesn't need a Launch Option.

## Linux, native

```
steam -applaunch 274190 <Doorstop arguments> --r2profile <profile name> <launchArgs>
```

The Doorstop target is the real path of the profile's `UnityModManager.dll`, with symlinks resolved. For a modded launch the server first makes the profile's `*.sh` files executable, the same as r2modman does. Launch Options need the `linux_wrapper.sh` line under [Launch Options](#launch-options). Only Wine reads its `WINEDLLOVERRIDES` part, so the native game ignores it.

`BROFORCE_LAUNCH_TYPE` decides between native and Proton. With `auto`, the default, it's Proton when the game folder has a `.forceproton` file or any `.exe`. `native` and `proton` force one or the other.

Any Doorstop argument or `launchArgs` token with whitespace in it is refused on Linux, since Steam on Linux splits `-applaunch` arguments at spaces even when they're quoted (steam-for-linux issue 8315). Use `BROFORCE_LAUNCH_CMD` for arguments like that.

## Linux, Proton

Proton uses the same command, but the Doorstop target is `Z:` followed by the real path. For a modded launch the server also adds `"winhttp"="native,builtin"` under `[Software\\Wine\\DllOverrides]` in `<steamapps>/compatdata/274190/pfx/user.reg`, and keeps a `user.reg.bak` copy when it changes the file, as r2modman does. Before that it waits up to 10 seconds for any `wineserver` still running in that prefix to exit, since one exiting saves its registry over `user.reg`.

If there's no `user.reg` yet, because the game has never been run under Proton, the reply's note says the override couldn't be set. Launch Options should be empty.

## Flatpak r2modman

A profile from the Flatpak r2modman's folder, `~/.var/app/com.github.ebkr.r2modman/config/r2modmanPlus-local/Broforce`, doesn't use `-applaunch`. The server writes `wrapper_args.txt` in that folder, next to `web_start_wrapper.sh`, with one argument per line, in this order:

- `<that folder>/linux_wrapper.sh` for a native game, or `--` for Proton
- the Doorstop arguments with `--r2profile <name>`, or the vanilla one
- `launchArgs`

That's the same order r2modman writes them in. After writing the file the server runs `xdg-open steam://run/274190/`. `web_start_wrapper.sh`, which Steam runs through the Launch Option, reads the file once and blanks it. Under Proton, its `WINEDLLOVERRIDES` part does what the `user.reg` step does.

If the file still has exactly what the server wrote when the launch wait ends, Steam never ran the wrapper. The server blanks the file then, so your next ordinary launch from Steam isn't modded, and a reply saying no game started says to launch again.

The Proton `user.reg` step above applies here too. Arguments that are empty, contain a newline or start with `#` are refused, since the wrapper skips them. Whitespace inside an argument is fine here. This still needs a Steam executable to be found, otherwise it's a protocol launch.

## Launch Options

On Linux, Broforce's Launch Options in Steam (in the game's properties) should hold the line r2modman's Linux setup screen gives you, and nothing else.

- With the native game and the regular r2modman, it's `WINEDLLOVERRIDES="winhttp,version=n,b" "<r2modman folder>/linux_wrapper.sh" %command%`, where `<r2modman folder>` is `~/.config/r2modmanPlus-local/Broforce`.
- With the Flatpak r2modman, native or Proton, it's `WINEDLLOVERRIDES="winhttp,version=n,b" "<Flatpak r2modman folder>/web_start_wrapper.sh" %command%`, where the folder is `~/.var/app/com.github.ebkr.r2modman/config/r2modmanPlus-local/Broforce`.
- Proton with the regular r2modman needs none, so leave Launch Options empty.

The `WINEDLLOVERRIDES` part is optional. When a launch from an r2modman profile on Linux ends with no game, or with a game that isn't listening, the reply names the Launch Options that launch needs. A vanilla launch of the native game with the regular r2modman needs none, so nothing is named for it.

## Waits

For a modded Steam launch the server polls until the mod answers, for up to 120 seconds, to cover Steam starting from cold. For a vanilla Steam launch it waits up to 120 seconds for the game's process to appear and stay up for 2 seconds. It doesn't wait for Steam's process to exit, since a cold start can leave it running as the Steam client. Only a non-zero exit from it ends the wait early.
