/**
 * Parsing and normalisation for the financial-criteria extractor's output,
 * shared by every LLM provider (same pattern as categorization.ts and
 * nameScreenParsing.ts).
 *
 * The prompt asks for plain numbers, but a model occasionally slips back to
 * "$5M" or "5,000,000". Those are converted rather than thrown away; anything
 * that still isn't a usable number becomes null, never a guess.
 */
import type { FinancialCriteria, FinancialRange } from './types.js';

export const FINANCIAL_CRITERIA_KEYS = ['revenue', 'ebitda', 'enterprise_value'] as const;

export function emptyRange(): FinancialRange {
  return { min: null, max: null, is_flexible: false };
}

const MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  mn: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
};

/** A finite, non-negative amount, or null. Accepts numbers and strings such as "$1.5M" or "25 million". */
export function toAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  if (/^\s*[-(]/.test(value)) return null; // negative amounts aren't criteria

  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[,\s]/g, '')
    .replace(/^[^\d.]+/, ''); // leading currency symbols/codes: $, £, €, usd, ...
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([a-z]*)\+?$/);
  if (!match) return null;

  const base = Number(match[1]);
  const suffix = match[2] ?? '';
  if (suffix && !(suffix in MULTIPLIERS)) return null;
  const amount = Math.round(base * (suffix ? MULTIPLIERS[suffix]! : 1));
  return Number.isFinite(amount) ? amount : null;
}

function toRange(value: unknown): FinancialRange {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyRange();
  const raw = value as Record<string, unknown>;

  let min = toAmount(raw.min);
  let max = toAmount(raw.max);
  // A reversed range is a model slip, not a meaningful statement.
  if (min !== null && max !== null && min > max) [min, max] = [max, min];

  const flex = raw.is_flexible;
  const isFlexible = flex === true || (typeof flex === 'string' && flex.trim().toLowerCase() === 'true');

  return { min, max, is_flexible: isFlexible };
}

/**
 * Parses the model's reply into exactly the three criteria. Throws only when
 * there is no JSON object at all; a missing or malformed criterion becomes an
 * empty range, and any extra keys are dropped.
 */
export function parseFinancialCriteria(text: string): FinancialCriteria {
  const match = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON object found');

  const raw = JSON.parse(match[0]) as unknown;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('top-level JSON is not an object');
  }
  const obj = raw as Record<string, unknown>;

  return {
    revenue: toRange(obj.revenue),
    ebitda: toRange(obj.ebitda),
    enterprise_value: toRange(obj.enterprise_value),
  };
}

/** True when at least one criterion has a min or a max. */
export function hasAnyCriteria(criteria: FinancialCriteria): boolean {
  return FINANCIAL_CRITERIA_KEYS.some((k) => criteria[k].min !== null || criteria[k].max !== null);
}

/**
 * True when the company is a Target and nothing else, or has no category at
 * all (parked page, login wall). Either way there are no buyer criteria to find.
 */
export function isTargetOnly(categories: string[]): boolean {
  const real = categories.map((c) => c.trim().toLowerCase()).filter(Boolean);
  return real.every((c) => c === 'target');
}

/** 10000000 -> "10M", 2500000000 -> "2.5B". No currency symbol: the site's currency isn't stored. */
export function formatAmount(n: number): string {
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, label] of units) {
    if (n >= size) return `${Number((n / size).toFixed(2))}${label}`;
  }
  return String(n);
}

/** "10M–50M", "20M+", "up to 100M", "3M (flexible)", or null when nothing is stated. */
export function formatRange(range: FinancialRange): string | null {
  const { min, max, is_flexible } = range;
  let text: string;
  if (min !== null && max !== null) {
    text = min === max ? formatAmount(min) : `${formatAmount(min)}–${formatAmount(max)}`;
  } else if (min !== null) {
    text = `${formatAmount(min)}+`;
  } else if (max !== null) {
    text = `up to ${formatAmount(max)}`;
  } else {
    return null;
  }
  return is_flexible ? `${text} (flexible)` : text;
}
