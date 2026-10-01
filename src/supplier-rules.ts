// League rules for next season's suppliers, shared by the toolkit, the site and (mirrored) the database.

export type SupplierWindow = "closed" | "open" | "done";

/**
 * Members choose from the deals MM draws for next season, as in MM's car design screen. MM draws
 * them after the final race, so the window opens once the published snapshot has offers. It stays
 * open while MM designs next year's car (each pull re-applies the choices) and closes once it's built.
 */
export function supplierWindow(
  calendar: { ended: boolean }[], state: "waiting" | "designing" | "complete", options: Record<string, unknown[]>,
): { status: SupplierWindow; racesLeft: number } {
  const racesLeft = calendar.filter((e) => !e.ended).length;
  if (state === "complete") return { status: "done", racesLeft };
  if (Object.values(options).some((o) => o.length)) return { status: "open", racesLeft };
  return { status: "closed", racesLeft };
}

/** CarChassisStats.Stats index → label. They're ratings, so higher is better (dearer suppliers have more tyre wear). */
export const SUPPLIER_STATS: Record<number, string> = {
  0: "Tyre wear", 1: "Tyre heating", 2: "Fuel efficiency", 3: "Improvability", 4: "Starting charge", 5: "Harvest efficiency",
};
