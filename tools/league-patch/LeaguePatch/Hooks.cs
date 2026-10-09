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
    /// AtlasManager.UpdateAtlasesWithMods (UI sprites (re)built), LocalisationReader.LoadFromFile
    /// (a text table loaded), FrontendCar.SetSponsorTexture (a car's sponsor decals set) and
    /// UnityVehicle.OnStart (a car put on track), and at both ends of TeamManager.ValidateTeamData
    /// (a save loaded).
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

        // MM_Data/league-stickers/<teamID>/<slot>.png, slot 0-5 in MM's SponsorSlot order (rear wing,
        // front wing, nose, side pods, end plates, air intake): a member team's stickers. A team with a
        // folder shows its stickers, and nothing on spots without one: its MM sponsors still pay but
        // don't show. Teams without a folder keep MM's decals.
        private const string StickersFolder = "league-stickers";
        private static readonly Dictionary<string, Texture2D> sStickers = new Dictionary<string, Texture2D>();
        private static readonly HashSet<int> sStickerTeamsLogged = new HashSet<int>();
        private static readonly Regex sSponsorMaterial = new Regex(@"^Sponsor\s*(\d\d)", RegexOptions.IgnoreCase);
        private const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance;

        private static string StickerDir(int teamID)
        {
            return Path.Combine(Path.Combine(Application.dataPath, StickersFolder), teamID.ToString());
        }

        /// <summary>The team's sticker for a slot, or null for a blank spot (cached until the file changes).</summary>
        private static Texture2D Sticker(int teamID, int slot)
        {
            string file = Path.Combine(StickerDir(teamID), slot + ".png");
            if (!File.Exists(file)) return null;
            float scale = StickerScale(Path.Combine(StickerDir(teamID), slot + ".scale"));
            string key = file + "|" + File.GetLastWriteTimeUtc(file).Ticks + "|" + scale;
            Texture2D tex;
            if (!sStickers.TryGetValue(key, out tex))
            {
                tex = new Texture2D(2, 2, TextureFormat.ARGB32, true);
                tex.LoadImage(File.ReadAllBytes(file));
                if (scale < 0.999f) tex = Shrunk(tex, scale);
                tex.name = "LeagueSticker_" + teamID + "_" + slot;
                sStickers[key] = tex;
            }
            return tex;
        }

        /// <summary>"&lt;slot&gt;.scale" beside a sticker: its size as a share of the spot (0.25..1), 1 without one.</summary>
        private static float StickerScale(string file)
        {
            float scale;
            if (!File.Exists(file) || !float.TryParse(File.ReadAllText(file).Trim(), System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out scale)) return 1f;
            return Mathf.Clamp(scale, 0.25f, 1f);
        }

        /// <summary>The sticker shrunk around its centre on a transparent decal of the same size.</summary>
        private static Texture2D Shrunk(Texture2D src, float scale)
        {
            int w = src.width, h = src.height;
            int sw = Mathf.Max(1, Mathf.RoundToInt(w * scale)), sh = Mathf.Max(1, Mathf.RoundToInt(h * scale));
            int x0 = (w - sw) / 2, y0 = (h - sh) / 2;
            Color32[] pixels = new Color32[w * h];
            for (int y = 0; y < sh; y++)
            {
                for (int x = 0; x < sw; x++)
                    pixels[(y0 + y) * w + x0 + x] = src.GetPixelBilinear((x + 0.5f) / sw, (y + 0.5f) / sh);
            }
            Texture2D dst = new Texture2D(w, h, TextureFormat.ARGB32, true);
            dst.wrapMode = TextureWrapMode.Clamp;
            dst.SetPixels32(pixels);
            dst.Apply(true);
            UnityEngine.Object.Destroy(src);
            return dst;
        }

        private static void LogStickers(int teamID, string where)
        {
            if (sStickerTeamsLogged.Add(teamID)) Debug.Log("LeaguePatch: stickers for team " + teamID + " (" + where + ")");
        }

        /// <summary>
        /// After FrontendCar.SetSponsorTexture (menus, car screens, team screens): every sponsor spot of a
        /// member team's car gets its sticker, or none.
        /// </summary>
        public static void OnFrontendCarSponsors(FrontendCar car)
        {
            try
            {
                int team = (int)typeof(FrontendCar).GetField("mTeamID", Private).GetValue(car);
                if (team < 0 || !Directory.Exists(StickerDir(team))) return;
                foreach (string field in new[] { "chassisSponsorMaterials", "frontWingSponsorMaterials", "rearWingSponsorMaterials" })
                {
                    Material[] materials = (Material[])typeof(FrontendCar).GetField(field, Private).GetValue(car);
                    for (int i = 0; i < materials.Length; i++)
                    {
                        if (materials[i] != null) materials[i].SetTexture("_MainTex", Sticker(team, i));
                    }
                }
                LogStickers(team, "car");
            }
            catch (Exception e)
            {
                Debug.LogError("LeaguePatch: " + e);
            }
        }

        /// <summary>
        /// After UnityVehicle.OnStart (a car on track): its "SponsorXX" materials, which MM never sets
        /// for race cars, get the team's stickers (slot XX - 1, as FrontendCar maps them), or none.
        /// </summary>
        public static void OnRaceCarStart(UnityVehicle car)
        {
            try
            {
                RacingVehicle vehicle = typeof(UnityVehicle).GetField("mVehicle", Private).GetValue(car) as RacingVehicle;
                Team team = vehicle == null || vehicle.driver == null ? null : vehicle.driver.contract.GetTeam();
                if (team == null || !Directory.Exists(StickerDir(team.teamID))) return;
                foreach (Renderer renderer in car.GetComponentsInChildren<Renderer>(true))
                {
                    Material[] materials = renderer.sharedMaterials;
                    bool changed = false;
                    for (int i = 0; i < materials.Length; i++)
                    {
                        if (materials[i] == null) continue;
                        Match m = sSponsorMaterial.Match(materials[i].name);
                        if (!m.Success) continue;
                        int slot = int.Parse(m.Groups[1].Value) - 1;
                        if (slot < 0 || slot > 5) continue;
                        // Its own copy: the model's materials are shared by every car on track.
                        materials[i] = new Material(materials[i]);
                        materials[i].SetTexture("_MainTex", Sticker(team.teamID, slot));
                        changed = true;
                    }
                    if (changed) renderer.sharedMaterials = materials;
                }
                LogStickers(team.teamID, "race");
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

        // Team names from the save, taken just before TeamManager.ValidateTeamData runs on load.
        private struct TeamIdentity { public string name, shortName; public Nationality nationality; }
        private static readonly Dictionary<Team, TeamIdentity> sSavedTeams = new Dictionary<Team, TeamIdentity>();

        /// <summary>
        /// At the start of TeamManager.ValidateTeamData. On every load FF20 resets each team's name,
        /// short name and nationality from Databases/Teams.txt (Rebirth only the short name), which
        /// undoes a league's renames; remember what the save says.
        /// </summary>
        public static void OnTeamsValidating(TeamManager teams)
        {
            try
            {
                sSavedTeams.Clear();
                foreach (Team team in teams.GetEntityList())
                    sSavedTeams[team] = new TeamIdentity { name = team.name, shortName = team.GetShortName(true), nationality = team.nationality };
            }
            catch (Exception e)
            {
                Debug.LogError("LeaguePatch: " + e);
            }
        }

        /// <summary>At the end of TeamManager.ValidateTeamData: put the save's names back.</summary>
        public static void OnTeamsValidated(TeamManager teams)
        {
            try
            {
                int kept = 0;
                foreach (KeyValuePair<Team, TeamIdentity> saved in sSavedTeams)
                {
                    Team team = saved.Key;
                    TeamIdentity was = saved.Value;
                    bool changed = false;
                    if (!string.IsNullOrEmpty(was.name) && team.name != was.name) { team.name = was.name; changed = true; }
                    if (!string.IsNullOrEmpty(was.shortName) && team.GetShortName(true) != was.shortName) { team.SetShortName(was.shortName); changed = true; }
                    if (was.nationality != null && team.nationality != was.nationality) team.nationality = was.nationality;
                    if (changed) kept++;
                }
                sSavedTeams.Clear();
                if (kept > 0) Debug.Log("LeaguePatch: kept the save's names for " + kept + " teams");
            }
            catch (Exception e)
            {
                Debug.LogError("LeaguePatch: " + e);
            }
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
