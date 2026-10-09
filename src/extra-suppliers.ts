// League fuel suppliers added to FIRE Fantasy 20 (the user's request, 2026-10-09): Orlen and
// Slovnaft, with their real logos (assets/supplier-logos: the user's files, 2026-10-09). F1
// numbers are the user's pick; other tiers scale them by that tier's median fuel supplier against F1's, as FF20's own fuel rows scale.
// Only type imports: the site may bundle this.

export interface ExtraFuelSupplier {
  name: string;
  /** Logo ID in MM's database (texture Supplier_Fuel_<logoID-1> in the supplierlogos bundle). */
  logoId: number;
  /** In F1: price ($), fuel efficiency and improvability. */
  price: number;
  fuel: number;
  improvability: number;
  /** The logo file, relative to the project. */
  logo: string;
}

export const EXTRA_FUEL_SUPPLIERS: ExtraFuelSupplier[] = [
  { name: "Orlen", logoId: 10, price: 6_000_000, fuel: 3, improvability: 3, logo: "assets/supplier-logos/orlen.png" },
  { name: "Slovnaft", logoId: 11, price: 4_000_000, fuel: 4, improvability: 1, logo: "assets/supplier-logos/slovnaft.png" },
];

export interface TierMedians { price: number; fuel: number; improvability: number }

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
export const tierMedians = (rows: TierMedians[]): TierMedians =>
  ({ price: median(rows.map((r) => r.price)), fuel: median(rows.map((r) => r.fuel)), improvability: median(rows.map((r) => r.improvability)) });

/** The supplier's numbers in a tier: F1's scaled by the tier's medians (stats to 0.5, price to $0.5M). */
export function scaledForTier(s: ExtraFuelSupplier, f1: TierMedians, tier: TierMedians): TierMedians {
  const r = (a: number, b: number) => (b ? a / b : 1);
  return {
    price: Math.max(500_000, Math.round((s.price * r(tier.price, f1.price)) / 500_000) * 500_000),
    fuel: Math.round(s.fuel * r(tier.fuel, f1.fuel) * 2) / 2,
    improvability: Math.round(s.improvability * r(tier.improvability, f1.improvability) * 2) / 2,
  };
}
