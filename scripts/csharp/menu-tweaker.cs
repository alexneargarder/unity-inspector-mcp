// #name Menu Tweaker
// #description Live-edit FlexMenu element properties without rebuilding. Target by name, type, or wildcard pattern.
// #tags menus, debugging, flexmenu
// #args elementName: Name or pattern to match (use * to list all, Item* for wildcard, or exact name), type: Filter by element type (ActionButton, TextElement, etc.), properties: Property=Value pairs (e.g. Width=100 Height=30 FontSize=5)

using System;
using System.Collections.Generic;
using RocketLib.Menus.Core;
using RocketLib.Menus.Elements;
using RocketLib.Menus.Layout;
using UnityEngine;

public class MenuTweaker
{
    public static void Main()
    {
        var menu = FlexMenu.activeMenu;
        if (menu == null)
        {
            ScriptContext.Logger("No active FlexMenu found. Open a FlexMenu first.");
            return;
        }

        string elementName = ScriptContext.GetArg("elementName", "");
        string typeName = ScriptContext.GetArg("type", "");

        if (string.IsNullOrEmpty(elementName) && string.IsNullOrEmpty(typeName))
        {
            ScriptContext.Logger("Usage: elementName=<name|pattern> [type=<type>] [Property=Value ...]");
            ScriptContext.Logger("  elementName=*           List all elements");
            ScriptContext.Logger("  elementName=BackButton  Target one element by name");
            ScriptContext.Logger("  elementName=Item*       Target elements matching wildcard");
            ScriptContext.Logger("  type=ActionButton       Target all elements of a type");
            ScriptContext.Logger("Properties: Width, Height, FontSize, Text, Padding, Spacing, WidthMode, HeightMode, Visible");
            return;
        }

        if (elementName == "*" && string.IsNullOrEmpty(typeName) && !HasPropertyArgs())
        {
            ScriptContext.Logger($"Active menu: {menu.MenuTitle} ({menu.GetType().Name})");
            ListElements(menu.RootContainer, 0);
            return;
        }

        var targets = FindTargets(menu.RootContainer, elementName, typeName);

        if (targets.Count == 0)
        {
            ScriptContext.Logger($"No elements matched. Use elementName=* to list all elements.");
            return;
        }

        if (!HasPropertyArgs())
        {
            ScriptContext.Logger($"Matched {targets.Count} element(s) (no properties to change):");
            foreach (var t in targets)
                LogElementSummary(t);
            return;
        }

        int updated = 0;
        foreach (var element in targets)
        {
            bool changed = ApplyProperties(element);
            if (changed) updated++;
        }

        if (updated > 0)
        {
            menu.RefreshLayout();
            ScriptContext.Logger($"Updated {updated} element(s) and refreshed layout.");
        }
    }

    static bool HasPropertyArgs()
    {
        foreach (var pair in ScriptContext.Args)
        {
            if (pair.Key != "elementName" && pair.Key != "type")
                return true;
        }
        return false;
    }

    static List<LayoutElement> FindTargets(LayoutContainer root, string namePattern, string typeName)
    {
        var all = GetAllElements(root);
        var results = new List<LayoutElement>();

        foreach (var element in all)
        {
            bool nameMatch = string.IsNullOrEmpty(namePattern) || namePattern == "*" || MatchesPattern(element.Name, namePattern);
            bool typeMatch = string.IsNullOrEmpty(typeName) || element.GetType().Name.Equals(typeName, StringComparison.OrdinalIgnoreCase);

            if (nameMatch && typeMatch)
                results.Add(element);
        }

        return results;
    }

    static bool MatchesPattern(string name, string pattern)
    {
        if (string.IsNullOrEmpty(name)) return false;
        if (pattern.EndsWith("*"))
        {
            string prefix = pattern.Substring(0, pattern.Length - 1);
            return name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }
        if (pattern.StartsWith("*"))
        {
            string suffix = pattern.Substring(1);
            return name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase);
        }
        return name.Equals(pattern, StringComparison.OrdinalIgnoreCase);
    }

    static List<LayoutElement> GetAllElements(LayoutElement element)
    {
        var result = new List<LayoutElement>();
        result.Add(element);
        if (element is LayoutContainer container)
        {
            foreach (var child in container.Children)
                result.AddRange(GetAllElements(child));
        }
        return result;
    }

    static bool ApplyProperties(LayoutElement element)
    {
        bool changed = false;
        foreach (var pair in ScriptContext.Args)
        {
            if (pair.Key == "elementName" || pair.Key == "type") continue;

            string prop = pair.Key;
            string val = pair.Value;

            try
            {
                switch (prop.ToLower())
                {
                    case "width":
                        element.Width = float.Parse(val);
                        changed = true;
                        break;
                    case "height":
                        element.Height = float.Parse(val);
                        changed = true;
                        break;
                    case "widthmode":
                        element.WidthMode = (SizeMode)Enum.Parse(typeof(SizeMode), val, true);
                        changed = true;
                        break;
                    case "heightmode":
                        element.HeightMode = (SizeMode)Enum.Parse(typeof(SizeMode), val, true);
                        changed = true;
                        break;
                    case "fontsize":
                        if (element is ActionButton btn)
                        {
                            btn.FontSize = float.Parse(val);
                            changed = true;
                        }
                        else if (element is TextElement txt)
                        {
                            txt.FontSize = float.Parse(val);
                            changed = true;
                        }
                        break;
                    case "text":
                        if (element is ActionButton b)
                        {
                            b.Text = val;
                            changed = true;
                        }
                        else if (element is TextElement t)
                        {
                            t.Text = val;
                            changed = true;
                        }
                        break;
                    case "padding":
                        if (element is LayoutContainer pc)
                        {
                            pc.Padding = float.Parse(val);
                            changed = true;
                        }
                        break;
                    case "spacing":
                        if (element is LayoutContainer sc)
                        {
                            sc.Spacing = float.Parse(val);
                            changed = true;
                        }
                        break;
                    case "visible":
                        element.IsVisible = bool.Parse(val);
                        changed = true;
                        break;
                }
            }
            catch (Exception ex)
            {
                ScriptContext.Logger($"  Error on {element.Name}: {prop}={val}: {ex.Message}");
            }
        }
        return changed;
    }

    static void LogElementSummary(LayoutElement element)
    {
        string type = element.GetType().Name;
        string name = element.Name ?? "(unnamed)";
        string details = $"{element.WidthMode}:{element.Width} x {element.HeightMode}:{element.Height}";

        if (element is ActionButton btn)
            details += $" FontSize:{btn.FontSize} Text:\"{btn.Text}\"";
        else if (element is TextElement txt)
            details += $" FontSize:{txt.FontSize} Text:\"{txt.Text}\"";

        ScriptContext.Logger($"  [{type}] {name} - {details}");
    }

    static void ListElements(LayoutElement element, int depth)
    {
        string indent = new string(' ', depth * 2);
        string type = element.GetType().Name;
        string name = element.Name ?? "(unnamed)";
        string id = element.Id ?? "";

        string details = $"{element.WidthMode}:{element.Width} x {element.HeightMode}:{element.Height}";

        if (element is ActionButton btn)
            details += $" FontSize:{btn.FontSize} Text:\"{btn.Text}\"";
        else if (element is TextElement txt)
            details += $" FontSize:{txt.FontSize} Text:\"{txt.Text}\"";

        if (element is LayoutContainer container)
        {
            details += $" Padding:{container.Padding} Spacing:{container.Spacing}";
            ScriptContext.Logger($"{indent}[{type}] {name} ({id}) - {details}");
            foreach (var child in container.Children)
            {
                ListElements(child, depth + 1);
            }
        }
        else
        {
            ScriptContext.Logger($"{indent}[{type}] {name} ({id}) - {details}");
        }
    }
}
