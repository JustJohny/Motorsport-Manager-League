// Numbers that differ between the two game codes the toolkit knows (src/schema.ts GameCode): FIRE
// Fantasy 20, the league's game, and the old Rebirth: Redux install (vanilla 1.53 for these).
// Found by diffing both Assembly-CSharp.dll files (see docs/save-schema.md, "FF20 vs Rebirth").
// Pure data: the site bundles this file.

import type { GameRules } from "./league-types.ts";

export interface GameScale {
  /** DriverStats.ClampStats: each driver stat's max. */
  driverStatMax: number;
  /** DriverStats.GetAbility / GetAbilityPotential: stars = stat total / this. */
  driverAbilityDivisor: number;
  /** EngineerStats.ClampStats: each part contribution stat's max (the ability is still total / 24). */
  engineerStatMax: number;
  /** MechanicStats.ClampStats. */
  mechanicStatMax: number;
  /** TeamPrincipalStats.GetAbility: stars = stat total / this x 5. */
  principalAbilityDivisor: number;
  /** ContractPerson.GetContractTerminationCost: yearly wage / this, per month left (1..6). */
  buyoutWageDivisor: number;
  /** CarChassisStats.SetStat: chassis stats clamped to 0..this (Rebirth only floors at 0). */
  chassisStatMax: number;
  /** TeamFinanceController.GetCarDevCost: a year's car fund by level and championship id. */
  carDevCost: number[][];
  /** How the car fund is paid: Rebirth monthly (/ 12), FF20 after each race (/ the season's races). */
  carFundPaid: "month" | "race";
}

export const GAME_SCALE: Record<GameRules, GameScale> = {
  rebirth: {
    driverStatMax: 20,
    driverAbilityDivisor: 36,
    engineerStatMax: 20,
    mechanicStatMax: 20,
    principalAbilityDivisor: 60,
    buyoutWageDivisor: 12,
    chassisStatMax: Infinity,
    carDevCost: [
      [12e6, 8.4e6, 6e6, 8.4e6, 3.6e6, 12e6, 4.8e6],
      [18e6, 13.2e6, 8.4e6, 13.2e6, 7.2e6, 15.6e6, 8.4e6],
      [24e6, 18e6, 12e6, 18e6, 10.8e6, 21.6e6, 12e6],
    ],
    carFundPaid: "month",
  },
  ff20: {
    driverStatMax: 25,
    driverAbilityDivisor: 41.4,
    engineerStatMax: 25,
    mechanicStatMax: 20,
    principalAbilityDivisor: 90,
    buyoutWageDivisor: 8,
    chassisStatMax: 20,
    carDevCost: [
      [10e6, 7e6, 5e6, 7e6, 3e6, 10e6, 4e6],
      [15e6, 11e6, 7e6, 11e6, 6e6, 13e6, 7e6],
      [20e6, 15e6, 10e6, 15e6, 9e6, 18e6, 10e6],
    ],
    carFundPaid: "race",
  },
};

/** The scale for a game code; data published before FF20 has none and means Rebirth. */
export const gameScale = (game?: GameRules | null): GameScale => GAME_SCALE[game ?? "rebirth"];

/** A person's stat bar maximum for their kind. */
export function statMax(kind: string, game?: GameRules | null): number {
  const s = gameScale(game);
  return kind === "Driver" ? s.driverStatMax : kind === "Engineer" ? s.engineerStatMax : s.mechanicStatMax;
}
