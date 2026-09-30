import { homedir } from "node:os";
import { join } from "node:path";

/** Default MM save folder: native Windows, or the default Wine prefix on Linux. */
export function defaultSavesDir(): string {
  const rel = ["AppData", "LocalLow", "Playsport Games", "Motorsport Manager", "Cloud", "Saves"];
  if (process.platform === "win32") return join(homedir(), ...rel);
  return join(homedir(), ".wine", "drive_c", "users", process.env.USER ?? "", ...rel);
}
