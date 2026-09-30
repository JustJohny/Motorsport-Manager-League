import type { Obj } from "../graph.ts";
import type { Save } from "../model.ts";

export interface SetBudgetOp {
  op: "setBudget";
  team: string | number;
  amount: number;
  /** Shown in the in-game finance history. */
  reason?: string;
}

/** Set a team's budget and record the difference as a transaction, so it shows in game. */
export function setBudget(save: Save, op: SetBudgetOp): string {
  const team = save.team(op.team);
  const fin = save.finance(team);
  const before = Number(fin.currentBudget);
  const delta = op.amount - before;
  fin.currentBudget = op.amount;

  const history = save.g.deref<Obj>(fin.transactionHistory);
  const list = save.g.rawList(history.transactions);
  const template = list.length ? save.g.deref<Obj>(list[list.length - 1]) : null;
  if (template && delta !== 0) {
    const t = save.g.clone(template);
    t.name = op.reason ?? "League adjustment";
    t.amount = Math.abs(delta);
    t.fundsAfterTransaction = op.amount;
    t.transactionDate = save.now;
    t.transactionType = delta >= 0 ? 0 : 1; // 0 = income, 1 = expenditure
    list.push(t);
  }
  return `${team.name}: budget ${before} -> ${op.amount}`;
}
