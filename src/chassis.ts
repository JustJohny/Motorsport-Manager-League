// MM's next-year chassis design (CarDesignScreen, UIPreferencesSettingsWidget, CarChassisStats) on
// plain data, shared by the toolkit and the site. See HANDOFF.md, "Season transition".
// Only type imports: the site bundles this file.

/** What a supplier contributes: its chassis stats and how it narrows the two sliders. */
export interface ChassisSupplier {
  type: string;
  /** CarChassisStats.Stats index → value: 0 TyreWear, 1 TyreHeating, 2 FuelEfficiency, 3 Improvability. */
  stats: Record<number, number>;
  /** Supplier.CarAspect → narrowing from the left (0 RearPackage, 1 NoseHeight). */
  minBound?: Record<number, number>;
  /** … and from the right. */
  maxBound?: Record<number, number>;
}

export interface ChassisResult { tyreWear: number; tyreHeating: number; fuelEfficiency: number; improvability: number }

/** GameStatsConstants.chassisSliderAmmount; the base (chassisBaseStat) is 0 in every series. */
export const SLIDER_AMOUNT = 10;
const ASPECT = { rear: 0, nose: 1 } as const;
/** CarChassisStats.GetSuppliers order (battery/ERS don't add these four stats). */
const ORDER = ["Engine", "Brakes", "Fuel", "Materials"];

/** The slider ranges the suppliers leave: [Σ min bounds, 1 − Σ max bounds] (UIPreferencesEntry.ClampSlider). */
export function sliderRange(suppliers: ChassisSupplier[]) {
  const range = (aspect: number): [number, number] => {
    const min = suppliers.reduce((s, x) => s + (x.minBound?.[aspect] ?? 0), 0);
    const max = suppliers.reduce((s, x) => s + (x.maxBound?.[aspect] ?? 0), 0);
    // MM puts the slider at 0 when the bounds cross; keep the middle of them instead of an error.
    return min <= 1 - max ? [min, 1 - max] : [(min + 1 - max) / 2, (min + 1 - max) / 2];
  };
  return { nose: range(ASPECT.nose), rear: range(ASPECT.rear) };
}

export const clampSlider = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));

/**
 * The chassis MM builds: the sliders' stats (nose: fuel efficiency ↔ tyre wear, rear: improvability
 * ↔ tyre heating, each pair ±5 around the base), then each supplier's stats added in MM's order,
 * every stat floored at 0 after each supplier (CarChassisStats.SetStat). `nose`/`rear` 0.5 = the
 * AI's default chassis.
 */
export function chassisStats(suppliers: ChassisSupplier[], nose = 0.5, rear = 0.5): ChassisResult {
  const half = SLIDER_AMOUNT / 2;
  const s = [
    -half + (1 - nose) * SLIDER_AMOUNT, // 0 TyreWear
    -half + (1 - rear) * SLIDER_AMOUNT, // 1 TyreHeating
    -half + nose * SLIDER_AMOUNT,       // 2 FuelEfficiency
    -half + rear * SLIDER_AMOUNT,       // 3 Improvability
  ];
  for (const type of ORDER) {
    const sup = suppliers.find((x) => x.type === type);
    if (!sup) continue;
    for (let k = 0; k < 4; k++) s[k] = Math.max(0, s[k] + (sup.stats[k] ?? 0));
  }
  return { tyreWear: s[0], tyreHeating: s[1], fuelEfficiency: s[2], improvability: s[3] };
}

/** TeamFinanceController.NextYearCarInvestement. */
export const INVESTMENT_LEVELS = ["Low", "Medium", "High"] as const;
