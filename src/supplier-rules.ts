// League rules for next season's suppliers, shared by the toolkit, the site and (mirrored) the database.

/** The window opens once this many races of the season (or fewer) remain. */
export const SUPPLIER_WINDOW_RACES = 3;

export type SupplierWindow = "closed" | "open" | "done";

/**
 * MM only lets you pick suppliers at pre-season; the league opens the choice earlier. It stays open
 * while MM designs next year's car (each pull re-applies the choices) and closes once the car is built.
 */
export function supplierWindow(calendar: { ended: boolean }[], state: "waiting" | "designing" | "complete"): { status: SupplierWindow; racesLeft: number } {
  const racesLeft = calendar.filter((e) => !e.ended).length;
  if (state === "complete") return { status: "done", racesLeft };
  if (state === "designing" || racesLeft <= SUPPLIER_WINDOW_RACES) return { status: "open", racesLeft };
  return { status: "closed", racesLeft };
}

/** CarChassisStats.Stats index → label. They're ratings, so higher is better (dearer suppliers have more tyre wear). */
export const SUPPLIER_STATS: Record<number, string> = {
  0: "Tyre wear", 1: "Tyre heating", 2: "Fuel efficiency", 3: "Improvability", 4: "Starting charge", 5: "Harvest efficiency",
};
