// Real names for MM's fictional circuits (the mapping Enzoli's 2016 mod used; the user's choice,
// 2026-10-09). MM keys on the location name (session ambience, per-circuit driver stats, dialogue
// "CurrentCircuit", track traits, politics, FF20's race export folders), so the save keeps it: the
// game shows the real name through the league patch's text file (MM_Data/league-text.txt, written by
// `mmsave track-names`) and the site through circuitName(). Only type imports: the site bundles this.

export const REAL_CIRCUITS: Record<string, string> = {
  Ardennes: "Spa-Francorchamps",
  Beijing: "Shanghai",
  "Black Sea": "Sochi",
  "Cape Town": "Monaco",
  Doha: "Abu Dhabi",
  Dubai: "Bahrain",
  Guildford: "Silverstone",
  Milan: "Monza",
  Munich: "Hockenheim",
  Phoenix: "Austin",
  "Rio de Janeiro": "São Paulo",
  Sydney: "Melbourne",
  Tondela: "Barcelona",
  Vancouver: "Montreal",
  Yokohama: "Suzuka",
};

/** The name to show for MM's location name (Singapore is already real). */
export const circuitName = (location: string): string => REAL_CIRCUITS[location] ?? location;

/** The league patch's text renames ("~Sydney=Melbourne" renames the word in every text). */
export function circuitTextLines(): string[] {
  return Object.entries(REAL_CIRCUITS).map(([mm, real]) => `~${mm}=${real}`);
}
