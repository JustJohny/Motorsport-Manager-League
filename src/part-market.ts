/**
 * The league's part market: members sell customer copies of their parts to other members.
 * Pure rules, shared by the toolkit, the site and the SQL in migration 029 (a test checks they agree).
 *
 * Rules agreed with the user (2026-10-13):
 * - Listed parts: the organizer picks, per season, the part types every team must design itself.
 * - The buyer gets a customer copy: the seller keeps their part. The copy has 90 % of the part's
 *   gain over the series' floor stat, the same reliability and the same components (grey-area
 *   risk included).
 * - The seller lists a part at a price; a buyer takes one or two copies. Money is reserved, and
 *   the copies are delivered at the next apply. The seller pays MM's materials cost per copy.
 * - Customer copies don't count as the buyer's own work: they don't open design slots, and they
 *   leave at the season's end, before MM carries the best parts into next season.
 * - Buyers improve them like any part.
 */

/** Share of the seller's gain over the floor that a customer copy gets. */
export const CUSTOMER_SPEC = 0.9;

/** Listed parts when the organizer hasn't chosen: the aero, as in real F1. */
export const DEFAULT_LISTED: readonly string[] = ["FrontWing", "RearWing"];

/**
 * Customer copies get a GUID starting with this, so the toolkit can tell them apart in any save
 * without the site (still a valid GUID for MM).
 */
export const CUSTOMER_GUID_PREFIX = "c0c0c0c0-";

export const isCustomerPart = (guid: string) => guid.startsWith(CUSTOMER_GUID_PREFIX);

/** The copy's main stat: the floor (rules.partStatSeasonMinValue) plus 90 % of what's above it. */
export function customerStat(statWithPerformance: number, floor: number): number {
  return Math.round(floor + CUSTOMER_SPEC * Math.max(0, statWithPerformance - floor));
}
