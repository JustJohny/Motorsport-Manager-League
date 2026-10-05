using System;
using System.IO;
using UnityEngine;

namespace LeaguePatch
{
    /// <summary>
    /// Called by the patched game at the end of SessionManager.StartSession, when a session goes green.
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
