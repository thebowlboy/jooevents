import type {
  FieldRegistryFieldDefinitionDto,
  FieldRegistryGroup,
  FieldRegistryKind
} from '@jooevents/contracts';

export const FIELD_REGISTRY_GROUP_LADDER = Object.freeze([
  'identity', 'contact', 'presence', 'talk', 'logistics', 'materials', 'other', 'consent'
] as const satisfies readonly FieldRegistryGroup[]);

export interface FieldRegistryPlacementSuggestion {
  readonly index: number;
  readonly group: FieldRegistryGroup;
  readonly reasonKey: string;
}

const consentLabel = /\b(consent|agree|code of conduct|permission|recorded)\b/iu;
const labelRules: readonly { readonly pattern: RegExp; readonly group: FieldRegistryGroup }[] = [
  { pattern: /\b(travel|arrival|departure|visa|dietary|hotel)\b/iu, group: 'logistics' },
  { pattern: /\b(bio|pronoun|name|headline)\b/iu, group: 'identity' },
  { pattern: /\b(slide|deck|material|headshot)\b/iu, group: 'materials' },
  { pattern: /\b(twitter|linkedin|github|website|social)\b/iu, group: 'presence' },
  { pattern: /\b(title|abstract|format|track|topic|session)\b/iu, group: 'talk' }
];

export function classifyFieldRegistryField(
  kind: FieldRegistryKind,
  label: string
): FieldRegistryGroup {
  if (kind === 'email' || kind === 'phone') return 'contact';
  if (kind === 'url') return 'presence';
  if (kind === 'date' || kind === 'datetime') return 'logistics';
  if (kind === 'file') return 'materials';
  if (kind === 'checkbox' && consentLabel.test(label)) return 'consent';
  return labelRules.find((rule) => rule.pattern.test(label))?.group ?? 'other';
}

export function suggestFieldRegistryPlacement(
  field: { readonly kind: FieldRegistryKind; readonly label: string },
  current: readonly FieldRegistryFieldDefinitionDto[]
): FieldRegistryPlacementSuggestion {
  const group = classifyFieldRegistryField(field.kind, field.label);
  if (current.length === 0) {
    return Object.freeze({ index: 0, group, reasonKey: 'field_registry.placement.first' });
  }
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (current[index]?.group === group) {
      return Object.freeze({
        index: index + 1,
        group,
        reasonKey: `field_registry.placement.after_${group}`
      });
    }
  }
  for (
    let ladderIndex = FIELD_REGISTRY_GROUP_LADDER.indexOf(group) + 1;
    ladderIndex < FIELD_REGISTRY_GROUP_LADDER.length;
    ladderIndex += 1
  ) {
    const following = FIELD_REGISTRY_GROUP_LADDER[ladderIndex];
    const index = current.findIndex((candidate) => candidate.group === following);
    if (index >= 0) {
      return Object.freeze({
        index,
        group,
        reasonKey: `field_registry.placement.before_${following}`
      });
    }
  }
  return Object.freeze({
    index: current.length,
    group,
    reasonKey: group === 'consent'
      ? 'field_registry.placement.consent_last'
      : 'field_registry.placement.end'
  });
}
