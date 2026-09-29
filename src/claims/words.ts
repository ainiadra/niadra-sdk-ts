/**
 * Numbers written in words, in Portuguese, English and Spanish, from zero to the millions: "quinze", "dois
 * mil e quinhentos", "twenty-five", "doscientos treinta". The parser reads them only right before a unit, a
 * currency or a percent word ("quinze dias úteis", "trezentos reais"): a number word alone is never a number,
 * because "um", "one" and "un" are also articles.
 */

import { type Decimal, fromInteger } from "./decimal.js";
import type { Word } from "./text.js";

export type Language = "pt" | "en" | "es";

const UNITS: Record<Language, Partial<Record<string, number>>> = {
  pt: {
    zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8,
    nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16,
    dezasseis: 16, dezessete: 17, dezassete: 17, dezoito: 18, dezenove: 19, dezanove: 19, vinte: 20,
    trinta: 30, quarenta: 40, cinquenta: 50, cincoenta: 50, sessenta: 60, setenta: 70, oitenta: 80,
    noventa: 90, cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300,
    quatrocentos: 400, quatrocentas: 400, quinhentos: 500, quinhentas: 500, seiscentos: 600,
    seiscentas: 600, setecentos: 700, setecentas: 700, oitocentos: 800, oitocentas: 800, novecentos: 900,
    novecentas: 900,
  },
  en: {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
    eighty: 80, ninety: 90,
  },
  es: {
    cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
    nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16,
    diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21,
    veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27,
    veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70,
    ochenta: 80, noventa: 90, cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300,
    trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500,
    seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800,
    ochocientas: 800, novecientos: 900, novecientas: 900,
  },
};
const HUNDRED: Record<Language, readonly string[]> = { pt: [], en: ["hundred"], es: [] };
const THOUSAND: Record<Language, readonly string[]> = { pt: ["mil"], en: ["thousand"], es: ["mil"] };
const MILLION: Record<Language, readonly string[]> = {
  pt: ["milhao", "milhoes"],
  en: ["million", "millions"],
  es: ["millon", "millones"],
};
const AND: Record<Language, string> = { pt: "e", en: "and", es: "y" };

function unitOf(lang: Language, word: string): number | undefined {
  return Object.hasOwn(UNITS[lang], word) ? UNITS[lang][word] : undefined;
}

function isNumberWord(lang: Language, word: string): boolean {
  return (
    unitOf(lang, word) !== undefined ||
    HUNDRED[lang].includes(word) ||
    THOUSAND[lang].includes(word) ||
    MILLION[lang].includes(word)
  );
}

/**
 * The number written in words from `found[i]` on, and the index past its last word; null when no number
 * starts there. "e", "and" and "y" join number words and never end or start one; a hyphen separates words,
 * so "twenty-five" reads as "twenty five".
 */
export function readWords(lang: Language, found: readonly Word[], i: number): [Decimal, number] | null {
  let total = 0n;
  let current = 0n;
  let j = i;
  // After a unit or a teen, another one needs "e", "and" or "y" first: "un veinticinco" is two numbers.
  let small = false;
  for (let word = found[j]?.text; word !== undefined; word = found[j]?.text) {
    const next = found[j + 1]?.text;
    if (word === AND[lang] && j > i && next !== undefined && isNumberWord(lang, next)) {
      j += 1;
      small = false;
      continue;
    }
    const unit = unitOf(lang, word);
    if (small && unit !== undefined) break;
    if (MILLION[lang].includes(word)) {
      total = (total + (current > 1n ? current : 1n)) * 1_000_000n;
      current = 0n;
    } else if (THOUSAND[lang].includes(word)) {
      total += (current > 1n ? current : 1n) * 1000n;
      current = 0n;
    } else if (HUNDRED[lang].includes(word)) current = (current > 1n ? current : 1n) * 100n;
    else if (unit !== undefined) current += BigInt(unit);
    else break;
    small = unit !== undefined && unit < 20;
    j += 1;
  }
  while (j > i && found[j - 1]?.text === AND[lang]) j -= 1;
  return j > i ? [fromInteger(total + current), j] : null;
}
