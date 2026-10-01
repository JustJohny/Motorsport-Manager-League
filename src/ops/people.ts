import type { Obj } from "../graph.ts";
import { walk } from "../graph.ts";
import { JOB, JOBS, NULL_DATE, personName, type Save } from "../model.ts";

export interface RenamePersonOp {
  op: "renamePerson";
  team: string | number;
  /** The team slot holding the person: drivers 0–2, lead designer 6, mechanics 7–8, scout 9, chairman 10, assistant 11, principal 12. */
  slotID: number;
  firstName: string;
  lastName: string;
  /** Defaults to "F. Last". */
  shortName?: string;
  /** Defaults to the first three letters of the last name, as MM writes them ("Ham"). */
  threeLetterName?: string;
  /** A country key already used in the save, e.g. "UK", "Germany", "RussianFederation". */
  nationality?: string;
  /** "YYYY-MM-DD". The peak-age date moves by the same amount, so the career curve keeps its shape. */
  dateOfBirth?: string;
  gender?: "male" | "female";
}

const GENDER = { male: 0, female: 1 } as const;

/**
 * Give someone a new identity. Driver names are also dictionary keys in every mechanic's
 * relationship tables, and the contract-end calendar text spells the name out, so both follow.
 */
export function renamePerson(save: Save, op: RenamePersonOp): string {
  const g = save.g;
  const team = save.team(op.team);
  const slot = save.slots(team).find((s) => s.slotID === op.slotID);
  if (!slot?.personHired) throw new Error(`${team.name}: slot ${op.slotID} is empty`);
  const p = g.deref<Obj>(slot.personHired);
  const oldName = p.name as string;
  const oldFull = personName(p);
  const name = `${op.firstName} ${op.lastName}`;

  if (slot.jobType === JOB.Driver && name !== oldName) {
    const clash = g.list(save.data.driverManager.mEntities).find((d) => d !== p && d.name === name);
    if (clash) throw new Error(`Another driver is already called ${name}; mechanics key relationships by driver name`);
  }

  p.mFirstName = op.firstName;
  p.mLastName = op.lastName;
  p.mShortName = op.shortName ?? `${op.firstName[0]}. ${op.lastName}`;
  p.mThreeLetterName = op.threeLetterName ?? threeLetters(op.lastName);
  p.name = name;

  if (slot.jobType === JOB.Driver) {
    for (const m of g.list(save.data.mechanicManager.mEntities)) {
      for (const key of ["mDictDriversRelationships", "mDictRelationshipModificationHistory"]) {
        if (m[key] && oldName in m[key]) m[key] = renameKey(m[key], oldName, name);
      }
    }
  }

  for (const c of [p.contract, p.nextYearContract]) {
    const ev = c && g.deref<Obj>(c).mCalendarEvent;
    const texts = ev && g.deref<Obj>(ev).mDynamicDescription?.translatedText;
    if (!texts) continue;
    for (const lang of Object.keys(texts)) {
      texts[lang] = String(texts[lang]).split(oldName).join(name).split(oldFull).join(name);
    }
  }

  if (op.nationality) p.nationality = g.ref(nationality(save, op.nationality));

  if (op.dateOfBirth) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(op.dateOfBirth)) throw new Error(`dateOfBirth must be YYYY-MM-DD, got ${op.dateOfBirth}`);
    const born = `${op.dateOfBirth}T00:00:00.0000000`;
    const shift = Date.parse(born.slice(0, 19) + "Z") - Date.parse(p.dateOfBirth.slice(0, 19) + "Z");
    if (p.peakAge && p.peakAge !== NULL_DATE) {
      p.peakAge = new Date(Date.parse(p.peakAge.slice(0, 19) + "Z") + shift).toISOString().slice(0, 19) + ".0000000";
    }
    p.dateOfBirth = born;
  }

  if (op.gender && GENDER[op.gender] !== p.gender) {
    p.gender = GENDER[op.gender];
    // Portrait parts share index ranges across genders, but a look borrowed from someone of the
    // new gender reads right in game.
    const donor = portraitDonor(save, p, name);
    if (donor) p.portrait = { ...donor.portrait };
  }

  return `${team.name}: ${JOBS[slot.jobType as number] ?? slot.jobType} ${oldName} → ${name}`;
}

function threeLetters(lastName: string): string {
  const plain = lastName.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z]/g, "");
  return plain.slice(0, 1).toUpperCase() + plain.slice(1, 3).toLowerCase();
}

/** A copy of `dict` with `from` renamed to `to`, keeping the key order. */
function renameKey(dict: Obj, from: string, to: string): Obj {
  return Object.fromEntries(Object.entries(dict).map(([k, v]) => [k === from ? to : k, v]));
}

function nationality(save: Save, key: string): Obj {
  // Search the id index too: a nationality whose definition sat inside an earlier renamee's
  // old reference is no longer in the tree until the next write pulls it back in.
  let found = [...save.g.byId.values()].find((o) => o.mCountryKey === key && o.mNationalityID) ?? null;
  if (!found) walk(save.data, (o) => {
    if (!found && o.mCountryKey === key && o.mNationalityID) found = o;
  });
  if (!found) throw new Error(`No nationality "${key}" in the save`);
  return found;
}

/** Someone of `p`'s (new) gender and kind, picked by name so reruns choose the same face. */
function portraitDonor(save: Save, p: Obj, seed: string): Obj | null {
  const pools = ["driverManager", "engineerManager", "mechanicManager", "scoutManager", "chairmanManager", "assistantManager", "teamPrincipalManager"];
  const pool = pools.flatMap((m) => save.data[m] ? save.g.list(save.data[m].mEntities) : [])
    .filter((o) => o !== p && o.gender === p.gender && o.$type === p.$type && o.portrait);
  if (!pool.length) return null;
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}
