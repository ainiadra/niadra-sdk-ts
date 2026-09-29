/**
 * Hedges (the claim contract spec, section 5.4): a number the output says it cannot confirm, says as a value
 * that no longer holds, or doubts, is not asserted, and no category detects it. "Não consigo confirmar se o
 * frete de R$ 24,90 ainda vale" states no price.
 *
 * A number's clause is its sentence cut at clause breaks: a comma, semicolon or colon before a space, a
 * parenthesis, a dash, and the clause words ("mas", "but", "porque"). A break inside a number does not count.
 * A number is hedged when:
 *
 * 1. a denial stands before it in its clause ("não consigo confirmar", "I can't confirm", "whether");
 * 2. it is the number of its clause nearest to a past marker ("o valor anterior", "previously listed"), on
 *    either side, within `WINDOW` words, with no word of the present between them ("now", "agora");
 * 3. it is the number of its clause nearest before a doubt ("pode ter mudado", "has changed"), within
 *    `WINDOW` words;
 * 4. its clause follows one that is only an opener ("Antes, ele estava em R$ 1.240,00");
 * 5. its clause holds a past word ("foi", "was", "on file"), and a later clause of its sentence holds a
 *    denial followed by a word of continuity ("mas não consigo confirmar se esse total continua igual").
 *
 * A hedge that governs something else leaves the number asserted: "O total é R$ 500, mas não consigo
 * confirmar o prazo" states R$ 500. The words match whole words of the folded text, in sequence, with both
 * apostrophes alike, and never inside a number.
 */

import type { Mention } from "./numbers.js";
import { WINDOW } from "./roles.js";
import { type Span, pattern, sentenceOf, units, words } from "./text.js";

/** Before a number, to the end of its clause: the output says it cannot confirm what follows, or asks it. */
export const DENIALS: readonly string[] = [
  "nao posso confirmar", "nao consigo confirmar", "nao tenho como confirmar", "nao da para confirmar",
  "nao e possivel confirmar", "nao posso garantir", "nao consigo garantir", "nao tenho como garantir",
  "nao posso afirmar", "nao consigo afirmar", "nao tenho como afirmar", "nao posso verificar",
  "nao consigo verificar", "nao tenho como verificar", "nao tenho confirmacao", "sem confirmacao",
  "nao sei se", "nao tenho informacao", "nao tenho informacoes", "nao tenho a informacao",
  "nao tenho essa informacao", "preciso verificar", "precisa verificar", "precisamos verificar",
  "confirmar se", "verificar se", "conferir se", "saber se", "dizer se",
  "can't confirm", "cannot confirm", "can not confirm", "couldn't confirm", "unable to confirm",
  "not able to confirm", "can't verify", "cannot verify", "unable to verify", "can't guarantee",
  "cannot guarantee", "can't promise", "cannot promise", "don't have confirmation",
  "do not have confirmation", "no confirmation", "don't have information", "do not have information",
  "don't have the information", "do not have the information", "need to verify", "whether", "confirm if",
  "verify if", "check if", "know if", "sure if",
  "no puedo confirmar", "no logro confirmar", "no consigo confirmar", "no tengo como confirmar",
  "no es posible confirmar", "no puedo garantizar", "no puedo asegurar", "no puedo verificar",
  "no tengo confirmacion", "sin confirmacion", "no se si", "no tengo informacion", "necesito verificar",
  "hay que verificar", "confirmar si", "verificar si", "saber si", "decir si",
];

/** Beside a number: a value that no longer holds, as the one seen before. */
export const PAST_MARKERS: readonly string[] = [
  "valor anterior", "preco anterior", "total anterior", "o anterior", "a anterior", "os anteriores",
  "anteriormente", "quando visto", "quando vista", "quando voce viu", "antes era", "era antes",
  "previous price", "previous total", "previous value", "earlier price", "earlier total", "earlier value",
  "old price", "was the earlier", "was previously", "were previously", "previously listed",
  "previously quoted", "previously shown", "previously priced", "seen previously", "shown previously",
  "quoted previously", "listed previously", "last shown", "last quoted", "last listed", "when seen",
  "when you saw it",
  "precio anterior", "el anterior", "la anterior", "cuando lo vio", "cuando lo viste",
];

/** After a number: the output doubts that it still holds. */
export const DOUBTS: readonly string[] = [
  "pode ter mudado", "pode ter sido alterado", "pode ter sido alterada", "pode ter sido atualizado",
  "pode ter sido atualizada", "pode nao valer", "pode nao estar valendo", "nao vale mais", "ja nao vale",
  "precisa ser confirmado", "precisa ser confirmada", "precisa ser verificado", "precisa ser verificada",
  "nao esta confirmado", "nao esta confirmada", "nao foi confirmado", "nao foi confirmada", "mudou",
  "foi alterado", "foi alterada", "venceu", "expirou", "esta desatualizado", "esta desatualizada",
  "may have changed", "might have changed", "could have changed", "has changed", "have changed",
  "had changed", "is outdated", "is out of date", "no longer applies", "no longer holds", "no longer valid",
  "may no longer", "might no longer", "may not apply", "has expired", "expired", "needs to be confirmed",
  "needs to be verified", "needs to be checked", "is not confirmed", "isn't confirmed", "not confirmed",
  "unconfirmed",
  "puede haber cambiado", "pudo haber cambiado", "ha cambiado", "ya cambio", "ya no vale",
  "ya no es valido", "ya no aplica", "vencio", "expiro", "necesita confirmarse", "no esta confirmado",
  "no esta confirmada", "esta desactualizado", "esta desactualizada",
];

/** A clause of its own before the number's: what follows is said as it was. */
export const OPENERS: readonly string[] = [
  "antes", "anteriormente", "da ultima vez", "na ultima vez", "na ultima consulta", "na ultima cotacao",
  "previously", "earlier", "before", "last time", "the last time", "in the last quote",
  "la ultima vez", "en la ultima cotizacion",
];

/** In the number's clause, with a later denial that it still holds: the number said as it was. */
export const PAST_WORDS: readonly string[] = [
  "foi", "foram", "era", "eram", "estava", "estavam", "ficou", "ficava", "custava", "custavam",
  "registrado", "registrada", "informado", "informada",
  "was", "were", "had been", "used to be", "on file", "on record", "quoted",
  "fue", "fueron", "eran", "estaba", "estaban", "costaba", "costaban", "quedo",
];

/** After a denial: what it denies is that the value still holds. */
export const CONTINUITY: readonly string[] = [
  "ainda", "continua", "continuam", "segue", "seguem", "mesmo", "mesma", "igual", "atual", "atualizado",
  "atualizada", "vigente", "vale", "valendo", "valido", "valida", "mantem", "mantido", "mantida",
  "still", "remains", "remain", "current", "same", "valid", "applies", "apply", "holds", "unchanged",
  "anymore",
  "todavia", "aun", "sigue", "siguen", "mismo", "misma", "actual", "mantiene",
];

/** Between a past marker and a number: the number is the one that holds now. */
export const PRESENT: readonly string[] = [
  "agora", "hoje", "atual", "atualmente", "novo", "nova", "para",
  "now", "today", "current", "currently", "new", "to",
  "ahora", "hoy", "actual", "actualmente", "nuevo", "nueva",
];

/** Words that start a clause. The Portuguese "e" only as written: folded, "é" is "e" too. */
export const CLAUSE_WORDS: readonly string[] = [
  "mas", "porem", "contudo", "entretanto", "pois", "porque", "ja que", "e",
  "but", "however", "because", "since", "although", "though", "and",
  "pero", "sino", "pues", "aunque", "ya que", "y",
];

const BREAK = pattern(String.raw`[,;:](?=\s|$)|[()\u2014\u2013]|(?<=\s)-(?=\s)`, "g");
const NOT_SPACE = pattern(String.raw`[^\s]`);

interface Hit {
  /** Word indexes: the phrase's first word, and the one after its last. */
  readonly first: number;
  readonly past: number;
  readonly start: number;
  readonly end: number;
}

const plainWord = (word: string): string => word.replaceAll("\u2019", "'");

const phrasesOf = (entries: readonly string[]): string[][] =>
  entries.map((entry) => words(entry).map((w) => plainWord(w.text)));

const LISTS = {
  denials: phrasesOf(DENIALS),
  past: phrasesOf(PAST_MARKERS),
  doubts: phrasesOf(DOUBTS),
  openers: phrasesOf(OPENERS),
  pastWords: phrasesOf(PAST_WORDS),
  continuity: phrasesOf(CONTINUITY),
  present: phrasesOf(PRESENT),
  clause: phrasesOf(CLAUSE_WORDS),
};

/** The numbers of `numbers` (the output's mentions that are not labels) the output does not assert. */
export function hedged(text: string, numbers: readonly Mention[]): ReadonlySet<Mention> {
  const out = new Set<Mention>();
  if (numbers.length === 0) return out;
  const all = units(text);
  const found = words(text);
  const tokens = found.map((w) => plainWord(w.text));
  const inside = (start: number, end: number): boolean => numbers.some((m) => m.start < end && start < m.end);

  const hits = (name: keyof typeof LISTS): Hit[] => {
    const at = new Map<string, Hit>();
    for (const phrase of LISTS[name]) {
      for (let i = 0; i + phrase.length <= tokens.length; i++) {
        if (!phrase.every((word, k) => tokens[i + k] === word)) continue;
        const start = found[i]?.start ?? 0;
        const end = found[i + phrase.length - 1]?.end ?? 0;
        if (!inside(start, end)) at.set(`${i}:${i + phrase.length}`, { first: i, past: i + phrase.length, start, end });
      }
    }
    return [...at.values()].sort((a, b) => a.first - b.first || a.past - b.past);
  };

  const breaks: Span[] = [];
  for (const m of all.matchAll(BREAK)) {
    if (!inside(m.index, m.index + m[0].length)) breaks.push([m.index, m.index + m[0].length]);
  }
  for (const h of hits("clause")) {
    if (tokens[h.first] !== "e" || all.charAt(h.start) === "e" || all.charAt(h.start) === "E") breaks.push([h.start, h.end]);
  }

  const clause = (start: number, end: number): Span => {
    const [low, high] = sentenceOf(text, start);
    return [
      Math.max(low, ...breaks.filter(([, e]) => e <= start).map(([, e]) => e)),
      Math.min(high, ...breaks.filter(([s]) => s >= end).map(([s]) => s)),
    ];
  };
  const within = (hit: Hit, [low, high]: Span): boolean => low <= hit.start && hit.end <= high;

  const indexes = numbers.map((m): Span | null => {
    const mine = found.flatMap((w, i) => (m.start <= w.start && w.start < m.end ? [i] : []));
    return mine.length > 0 ? [mine[0] ?? 0, (mine[mine.length - 1] ?? 0) + 1] : null;
  });
  const clauses = numbers.map((m) => clause(m.start, m.end));
  const denials = hits("denials");
  const present = new Set(hits("present").map((h) => h.first));

  // 1. A denial before the number, in its clause.
  numbers.forEach((m, k) => {
    const low = clauses[k]?.[0] ?? 0;
    if (denials.some((d) => within(d, [low, m.start]))) out.add(m);
  });

  /**
   * The number of the hit's clause nearest to it within `WINDOW` words: before it, or on either side with no
   * word of the present between them. At the same distance, the one after it.
   */
  const nearest = (hit: Hit, eitherSide: boolean): Mention | null => {
    let best: { gap: number; side: number; number: Mention } | null = null;
    for (const [k, m] of numbers.entries()) {
      const span = indexes[k];
      const own = clauses[k];
      if (span == null || own === undefined || !within(hit, own)) continue;
      let gap: number;
      let side: number;
      let between: Span;
      if (span[1] <= hit.first) [gap, side, between] = [hit.first - span[1], 1, [span[1], hit.first]];
      else if (span[0] >= hit.past && eitherSide) [gap, side, between] = [span[0] - hit.past, 0, [hit.past, span[0]]];
      else continue;
      if (gap > WINDOW || (eitherSide && [...present].some((i) => between[0] <= i && i < between[1]))) continue;
      if (best === null || gap < best.gap || (gap === best.gap && side < best.side)) best = { gap, side, number: m };
    }
    return best?.number ?? null;
  };

  // 2. The number nearest to a past marker; 3. the number nearest before a doubt.
  for (const hit of hits("past")) {
    const near = nearest(hit, true);
    if (near !== null) out.add(near);
  }
  for (const hit of hits("doubts")) {
    const near = nearest(hit, false);
    if (near !== null) out.add(near);
  }

  // 4. The clause after one that is only an opener.
  for (const hit of hits("openers")) {
    const [low, high] = clause(hit.start, hit.end);
    const following = breaks.filter(([s]) => s === high).map(([, e]) => e);
    if (NOT_SPACE.test(all.slice(low, hit.start)) || NOT_SPACE.test(all.slice(hit.end, high)) || following.length === 0) continue;
    const next = Math.max(...following);
    numbers.forEach((m, k) => {
      if (clauses[k]?.[0] === next) out.add(m);
    });
  }

  // 5. A past word in the number's clause, and a later clause of its sentence that denies it still holds.
  const pastWords = hits("pastWords");
  const continuity = hits("continuity");
  numbers.forEach((m, k) => {
    const own = clauses[k];
    if (own === undefined || out.has(m) || !pastWords.some((v) => within(v, own))) return;
    const end = sentenceOf(text, m.start)[1];
    const denied = denials.some((d) => {
      if (!(own[1] <= d.start && d.end <= end)) return false;
      const rest: Span = [d.end, clause(d.start, d.end)[1]];
      return continuity.some((c) => within(c, rest));
    });
    if (denied) out.add(m);
  });
  return out;
}
