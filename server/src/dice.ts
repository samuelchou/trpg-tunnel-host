import crypto from "node:crypto";

export interface DiceTerm {
  /** 例如 "2d6"、"-1d4"、"+3" */
  label: string;
  sign: 1 | -1;
  /** 骰子項目的每顆點數；常數項目為 undefined */
  rolls?: number[];
  value: number;
}

export interface DiceRoll {
  notation: string;
  terms: DiceTerm[];
  total: number;
}

const MAX_DICE = 100;
const MAX_SIDES = 1000;
const MAX_TERMS = 10;

/**
 * 支援「NdM」加減常數或其他骰子，例如 1d20+3、2d6+1d4-1、d100。
 * 格式錯誤或超過上限時丟出錯誤，錯誤訊息會直接回給 GM。
 */
export function rollDice(notation: string): DiceRoll {
  const compact = notation.replace(/\s+/g, "").toLowerCase();
  if (!compact) throw new Error("骰子表示法是空的");
  if (!/^[+-]?(\d*d\d+|\d+)([+-](\d*d\d+|\d+))*$/.test(compact)) {
    throw new Error(`看不懂「${notation}」，請用像 1d20+3、2d6+1d4-1 這樣的格式`);
  }

  const parts = compact.match(/[+-]?[^+-]+/g)!;
  if (parts.length > MAX_TERMS) throw new Error(`最多 ${MAX_TERMS} 個項目`);

  const terms = parts.map((part): DiceTerm => {
    const sign = part.startsWith("-") ? -1 : 1;
    const body = part.replace(/^[+-]/, "");
    const dice = body.match(/^(\d*)d(\d+)$/);
    if (!dice) {
      const value = Number(body);
      return { label: part, sign, value: sign * value };
    }
    const count = dice[1] === "" ? 1 : Number(dice[1]);
    const sides = Number(dice[2]);
    if (count < 1 || count > MAX_DICE) throw new Error(`骰子數量要在 1 到 ${MAX_DICE} 之間`);
    if (sides < 2 || sides > MAX_SIDES) throw new Error(`骰子面數要在 2 到 ${MAX_SIDES} 之間`);
    const rolls = Array.from({ length: count }, () => crypto.randomInt(1, sides + 1));
    const sum = rolls.reduce((a, b) => a + b, 0);
    return { label: part, sign, rolls, value: sign * sum };
  });

  return { notation: compact, terms, total: terms.reduce((a, t) => a + t.value, 0) };
}

/** 例如「1d20+3 → [14]+3 = 17」 */
export function describeRoll(roll: DiceRoll): string {
  const detail = roll.terms
    .map((t, i) => {
      const op = t.sign < 0 ? "-" : i === 0 ? "" : "+";
      return op + (t.rolls ? `[${t.rolls.join(",")}]` : String(Math.abs(t.value)));
    })
    .join("");
  return `${roll.notation} → ${detail} = ${roll.total}`;
}
