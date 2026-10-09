import type { GameRules } from "./league-types.ts";

/** A car sticker spot: where its decals sit on the car, the main place first. */
export interface StickerSpot { name: string; alsoOn: string[] }

/**
 * The six decal spots by slot. A slot is MM's sponsor slot: the league game patch puts slot i on the
 * car's "Sponsor0<i+1>" decals. MM's own car has one place per slot; FIRE Fantasy 20's F1 car spreads
 * each slot over several decals (Modding/Models/Vehicle/F1, checked on both its car-screen and race
 * models 2026-10-09).
 */
const SPOTS: Record<GameRules, StickerSpot[]> = {
  rebirth: [
    { name: "Rear wing", alsoOn: [] },
    { name: "Front wing", alsoOn: [] },
    { name: "Nose", alsoOn: [] },
    { name: "Side pods", alsoOn: [] },
    { name: "End plates", alsoOn: [] },
    { name: "Air intake", alsoOn: [] },
  ],
  ff20: [
    { name: "Side pods", alsoOn: ["front wing centre", "front of the cockpit"] },
    { name: "Engine cover fin", alsoOn: ["chassis sides", "front of the cockpit"] },
    { name: "Rear wing", alsoOn: ["front wing end plates", "nose top"] },
    { name: "Air intake", alsoOn: ["nose"] },
    { name: "Cockpit sides", alsoOn: ["nose"] },
    { name: "Beam wing", alsoOn: ["nose tip", "engine cover"] },
  ],
};

export function stickerSpots(game: GameRules | undefined): StickerSpot[] {
  return SPOTS[game ?? "rebirth"];
}

/** Sticker sizes: a share of the spot, 1 = fitted to it as uploaded; above 1 it's cut off at the decal's edges. */
export const STICKER_SCALE = { min: 0.25, max: 2 } as const;
