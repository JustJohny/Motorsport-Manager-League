// What each HQ building is called in MM's UI and what it does, by building type (HQsBuildingInfo.Type).
// The save's building names are MM's older internal ones ("Logistics Centre" is the game's
// Forecasting Centre); the UI shows the localised strings below (resources.assets, "Headquarters
// Screen"). The save's names stay the toolkit's keys, so only display text comes from here.
// No imports: the site bundles this file.

export interface HqInfo {
  /** The name MM's HQ screen shows. */
  name: string;
  /** MM's own building description. */
  description: string;
  /** What each level gives, after MM's effect lines. */
  effects: string[];
}

/** Part type whose level 3-5 components a development building unlocks (one tier per building level). */
const unlocks = (part: string) => `Level 1 / 2 / 3 unlocks level 3 / 4 / 5 ${part} components`;
const driverRates = (...stats: string[]) => `Drivers' ${stats.join(" and ")} improve faster`;

export const HQ_INFO: Record<number, HqInfo> = {
  0: {
    name: "Design Centre",
    description: "The centre of new car and new part design, staffed by Designers. Upgrading the Design Centre helps towards unlocking new buildings.",
    effects: ["Part design time −0 / 1 / 2 / 3 days by level", "Higher max reliability on new parts (+5% per level)", "Needed for higher-tier buildings"],
  },
  1: {
    name: "Factory",
    description: "This is where the car is built, repaired and tweaked before flying off to the races. Upgrading the Factory helps towards unlocking new buildings.",
    effects: ["More part development staff (mechanics improving parts)", "Part improvement slots per list: 2 / 4 / 6 / 8 by level", "Needed for higher-tier buildings"],
  },
  2: {
    name: "Telemetry Centre",
    description: "The Telemetry Centre unlocks components for Gearbox Part development and allows your drivers to improve their consistency and smoothness.",
    effects: [unlocks("Gearbox"), driverRates("smoothness", "consistency")],
  },
  3: {
    name: "Test Track",
    description: "The Test Track unlocks components for Engine Part development and gives your drivers the chance to work on their overtaking skills, as well as their cornering.",
    effects: [unlocks("Engine"), driverRates("cornering", "overtaking")],
  },
  4: {
    name: "Wind Tunnel",
    description: "The Wind Tunnel unlocks components for Front Wing part development (if in Single Seater series) and also allows your drivers to improve their feedback rating.",
    effects: [unlocks("Front Wing"), driverRates("feedback")],
  },
  5: {
    name: "Simulator",
    description: "The Simulator unlocks components for rear aerodynamic part development and gives your drivers the chance to improve their adaptability and consistency.",
    effects: [unlocks("Rear Wing"), driverRates("consistency", "adaptability")],
  },
  6: {
    name: "Brakes R&D Facility",
    description: "The Brakes Research Facility unlocks components for Brakes part development and also helps your drivers improve their braking skills.",
    effects: [unlocks("Brakes"), driverRates("braking")],
  },
  7: {
    name: "Handling Development Centre",
    description: "The Handling Development Centre unlocks components for Suspension part development and gives your drivers the chance to improve their cornering and smoothness.",
    effects: [unlocks("Suspension"), driverRates("cornering", "smoothness")],
  },
  8: {
    name: "Scouting Facility",
    description: "The Scouting Facility unlocks more unscouted drivers from different championships. The variety of drivers also improves with each upgrade.",
    effects: ["Each level unlocks another set of hidden drivers"],
  },
  9: {
    name: "Staff Centre",
    description: "The Staff Centre helps your Lead Designer and Race Mechanics to improve their skills. It also allows the drivers to better their fitness and focus.",
    effects: ["Lead designer and mechanics improve their stats", driverRates("fitness", "focus")],
  },
  10: {
    name: "Forecasting Centre",
    description: "The Forecasting Centre improves your base of operations when away at the race, improving weather reports and allowing you to see weather patterns forming much earlier.",
    effects: ["Better race weekend weather forecasts, seen earlier"],
  },
  11: {
    name: "Road Car Factory",
    description: "A very expensive option, the Road Car Factory costs a lot to set up, but can generate huge income.",
    effects: ["Monthly income"],
  },
  12: {
    name: "Tour Centre",
    description: "The Tour Centre allows for tours around the HQ, increasing the happiness of the fans and making money.",
    effects: ["Monthly income", "Happier fans"],
  },
  13: {
    name: "Theme Park",
    description: "The Theme Park is a huge addition, but generates huge amounts of revenue - while the fans are happy!",
    effects: ["Large monthly income", "Happier fans"],
  },
  14: {
    name: "Helipad",
    description: "The Helipad unlocks five-star sponsors: the best and wealthiest sponsors available.",
    effects: ["Five-star sponsors unlocked"],
  },
};

/** The name MM's UI shows for a building; falls back to the save's name. */
export const hqName = (type: number, saveName?: string) => HQ_INFO[type]?.name ?? saveName ?? `Building #${type}`;
