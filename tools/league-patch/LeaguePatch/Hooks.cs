using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using UnityEngine;

namespace LeaguePatch
{
    /// <summary>
    /// Called by the patched game: at the end of SessionManager.StartSession (a session goes green),
    /// AtlasManager.UpdateAtlasesWithMods (UI sprites (re)built) and LocalisationReader.LoadFromFile
    /// (a text table loaded).
    /// </summary>
    public static class Hooks
    {
        // MM_Data/league-patch.ini, read at every session start so it can be switched without restarting.
        private const string ConfigFile = "league-patch.ini";

        /// <summary>
        /// Retires the player team's cars when qualifying and the race start. A retirement for parts
        /// (AIRetiredBehaviour, as when a part fails) sends the car to its garage without a flag:
        /// yellow flags, safety cars and VSCs only come from crashes and spins (CrashDirector).
        /// A car out of the race is never picked for a crash.
        /// </summary>
        public static void OnSessionStart(SessionManager session)
        {
            try
            {
                if (!Enabled("retirePlayerTeam")) return;
                SessionDetails.SessionType type = session.sessionType;
                if (type != SessionDetails.SessionType.Race && type != SessionDetails.SessionType.Qualifying) return;
                VehicleManager vehicles = Game.instance.vehicleManager;
                for (int i = 0; i < vehicles.vehicleCount; i++)
                {
                    RacingVehicle v = vehicles.GetVehicle(i);
                    if (v == null || !v.isPlayerDriver || v.behaviourManager.isOutOfRace) continue;
                    v.behaviourManager.ChangeBehaviour(AIBehaviourStateManager.Behaviour.Retired);
                    v.behaviourManager.GetBehaviour<AIRetiredBehaviour>().SetRetirementReason(AIRetiredBehaviour.Reason.Parts);
                    Debug.Log("LeaguePatch: retired " + v.driver.name + " at the start of " + type);
                }
            }
            catch (Exception e)
            {
                Debug.LogError("LeaguePatch: " + e);
            }
        }

        // MM_Data/league-sprites/<Atlas>/<sprite name>.png: replaces that sprite of the UI atlas
        // (e.g. TrackImages/TrackImages-Guildford.png). MM's mod system can only swap three atlases whole.
        private const string SpritesFolder = "league-sprites";
        private static readonly Dictionary<string, Texture2D> sTextures = new Dictionary<string, Texture2D>();

        public static void OnAtlasesUpdated(AtlasManager atlases)
        {
            try
            {
                string root = Path.Combine(Application.dataPath, SpritesFolder);
                if (!Directory.Exists(root)) return;
                FieldInfo field = typeof(AtlasManager).GetField("mSprites", BindingFlags.NonPublic | BindingFlags.Instance);
                Dictionary<string, Sprite>[] sprites = (Dictionary<string, Sprite>[])field.GetValue(atlases);
                int replaced = 0;
                foreach (string dir in Directory.GetDirectories(root))
                {
                    AtlasManager.Atlas atlas;
                    try { atlas = (AtlasManager.Atlas)Enum.Parse(typeof(AtlasManager.Atlas), Path.GetFileName(dir)); }
                    catch (ArgumentException) { Debug.LogWarning("LeaguePatch: no atlas called " + Path.GetFileName(dir)); continue; }
                    Dictionary<string, Sprite> table = sprites[(int)atlas];
                    foreach (string file in Directory.GetFiles(dir, "*.png"))
                    {
                        string name = Path.GetFileNameWithoutExtension(file);
                        Texture2D tex;
                        if (!sTextures.TryGetValue(file, out tex))
                        {
                            tex = new Texture2D(2, 2, TextureFormat.ARGB32, false);
                            tex.LoadImage(File.ReadAllBytes(file));
                            tex.name = name;
                            sTextures[file] = tex;
                        }
                        Sprite old;
                        Vector2 pivot = new Vector2(0.5f, 0.5f);
                        float ppu = 100f;
                        if (table.TryGetValue(name, out old) && old != null)
                        {
                            pivot = new Vector2(old.pivot.x / old.rect.width, old.pivot.y / old.rect.height);
                            ppu = old.pixelsPerUnit;
                        }
                        Sprite sprite = Sprite.Create(tex, new Rect(0, 0, tex.width, tex.height), pivot, ppu);
                        sprite.name = name;
                        table[name] = sprite;
                        replaced++;
                    }
                }
                Debug.Log("LeaguePatch: " + replaced + " UI sprites from " + SpritesFolder);
            }
            catch (Exception e)
            {
                Debug.LogError("LeaguePatch: " + e);
            }
        }

        // MM_Data/league-text.txt: "PSG_10003767=Silverstone" sets that text ID in every language;
        // "~Guildford=Silverstone" renames a whole word or phrase in every text.
        private const string TextFile = "league-text.txt";
        private static Dictionary<string, string> sIdText;
        private static Dictionary<string, string> sRenames;
        private static Regex sRenameRegex;
        private static readonly HashSet<string> sTextDone = new HashSet<string>();

        public static void OnTextLoaded(Dictionary<string, LocalisationEntry> entries)
        {
            try
            {
                if (sIdText == null) ReadTextRules();
                if (sIdText.Count == 0 && sRenames.Count == 0) return;
                int changed = 0;
                foreach (KeyValuePair<string, LocalisationEntry> kv in entries)
                {
                    if (!sTextDone.Add(kv.Key)) continue;
                    Dictionary<string, string> text = kv.Value.text;
                    string exact;
                    List<string> languages = new List<string>(text.Keys);
                    if (sIdText.TryGetValue(kv.Key, out exact))
                    {
                        foreach (string lang in languages) text[lang] = exact;
                        changed++;
                        continue;
                    }
                    if (sRenameRegex == null) continue;
                    foreach (string lang in languages)
                    {
                        string before = text[lang];
                        if (string.IsNullOrEmpty(before)) continue;
                        string after = sRenameRegex.Replace(before, m => sRenames[m.Value]);
                        if (after != before) { text[lang] = after; changed++; }
                    }
                }
                if (changed > 0) Debug.Log("LeaguePatch: " + changed + " texts from " + TextFile);
            }
            catch (Exception e)
            {
                Debug.LogError("LeaguePatch: " + e);
            }
        }

        private static void ReadTextRules()
        {
            sIdText = new Dictionary<string, string>();
            sRenames = new Dictionary<string, string>();
            string path = Path.Combine(Application.dataPath, TextFile);
            if (!File.Exists(path)) return;
            foreach (string raw in File.ReadAllLines(path))
            {
                string line = raw.Trim();
                int eq = line.IndexOf('=');
                if (line.Length == 0 || line.StartsWith("#") || eq <= 0) continue;
                string key = line.Substring(0, eq).Trim(), value = line.Substring(eq + 1).Trim();
                if (key.StartsWith("~")) sRenames[key.Substring(1)] = value;
                else sIdText[key] = value;
            }
            if (sRenames.Count == 0) return;
            // Longest first, so "Rio de Janeiro" wins over a shorter overlapping name.
            List<string> keys = new List<string>(sRenames.Keys);
            keys.Sort((a, b) => b.Length.CompareTo(a.Length));
            string[] parts = keys.ConvertAll(k => Regex.Escape(k)).ToArray();
            sRenameRegex = new Regex(@"(?<![\w])(" + string.Join("|", parts) + @")(?![\w])");
        }

        /// <summary>A "key=true" line in MM_Data/league-patch.ini.</summary>
        private static bool Enabled(string key)
        {
            string path = Path.Combine(Application.dataPath, ConfigFile);
            if (!File.Exists(path)) return false;
            foreach (string raw in File.ReadAllLines(path))
            {
                string line = raw.Trim();
                int eq = line.IndexOf('=');
                if (eq <= 0 || line.StartsWith("#")) continue;
                if (line.Substring(0, eq).Trim() == key)
                    return line.Substring(eq + 1).Trim().ToLowerInvariant() == "true";
            }
            return false;
        }
    }
}
