import type { Claim } from './types';

export const RULE_LABELS: Record<string, string> = {
  'setback.front.min': 'Front setback — minimum',
  'setback.front.max': 'Front setback — max / build-to line',
  'setback.side.min': 'Side setback — minimum',
  'setback.rear.min': 'Rear setback — minimum',
  'height.max': 'Building height — maximum',
  'height.max.principal': 'Principal building height — maximum',
  'lot.coverage.max': 'Lot coverage — maximum',
  'lot.area.min': 'Lot area — minimum',
  'use.permitted.multifamily': 'Multifamily dwellings',
  'use.permitted.agriculture': 'Agricultural uses',
};

export function getRuleLabel(key: string): string {
  return RULE_LABELS[key] || key;
}

export type RuleCategory =
  | 'Setbacks'
  | 'Height'
  | 'Lot dimensions'
  | 'Permitted uses'
  | 'Other';

export function getRuleCategory(key: string): RuleCategory {
  if (key.startsWith('setback.')) return 'Setbacks';
  if (key.startsWith('height.')) return 'Height';
  if (key.startsWith('lot.')) return 'Lot dimensions';
  if (key.startsWith('use.')) return 'Permitted uses';
  return 'Other';
}

export const CATEGORY_ORDER: RuleCategory[] = [
  'Setbacks',
  'Height',
  'Lot dimensions',
  'Permitted uses',
  'Other',
];

export function formatClaimValue(claim: Claim): {
  display: string;
  unit: string | null;
} {
  const { value_text, value_numeric, value_unit } = claim;

  if (
    (value_text === 'true' || value_text === 'false') &&
    (value_unit === null || value_unit === 'bool')
  ) {
    return {
      display: value_text === 'true' ? 'Permitted' : 'Not permitted',
      unit: null,
    };
  }

  if (
    value_numeric === null &&
    value_text !== null &&
    value_text.length > 25
  ) {
    return { display: value_text, unit: null };
  }

  if (value_numeric !== null) {
    if (value_unit === 'percent') {
      return { display: `${value_numeric}%`, unit: null };
    }
    if (value_unit === 'acres' && value_numeric < 1) {
      return { display: value_numeric.toFixed(2), unit: 'acres' };
    }
    return { display: String(value_numeric), unit: value_unit };
  }

  return { display: value_text || '—', unit: value_unit };
}
