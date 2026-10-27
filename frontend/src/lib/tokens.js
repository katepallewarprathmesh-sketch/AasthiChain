// The design tokens. One ground, one ink, one accent, one scale.
//
// The frontend grew to 107 distinct hex colours and 35 distinct font sizes
// across 62 components, every one of them written inline at the point of use.
// Nothing was wrong with any single value; the problem is that there is no
// such thing as "the" body size or "the" border colour, so every new screen
// invents its own and the product looks assembled rather than designed.
//
// These are the values already carrying the most weight in the codebase,
// promoted to names. Adopting them is incremental: a screen that imports
// them stops inventing, and tests/uitaste.test.mjs keeps the invented
// counts falling rather than rising.
//
// Rules this encodes, each one measurable:
//   - a tone step between surfaces, never a line and never a shadow
//   - money and every aligned figure set in tabular numerals
//   - one accent, used on the action
//   - a type scale with gaps in it, so hierarchy comes from scale and not
//     from half-point adjustments

export const colour = {
  // Ground and ink
  ground: '#ffffff',
  groundAlt: '#f9fafb', // the tone step between surfaces
  ink: '#111827',
  inkMuted: '#6b7280',
  inkFaint: '#9ca3af',
  line: '#e5e7eb', // borders that genuinely divide data, as in a table

  // One accent. It belongs on the action and on nothing decorative.
  accent: '#1e3a5f',
  accentInk: '#ffffff',

  // State. Used for meaning, never for decoration: settled, refused, pending.
  good: '#047857',
  goodGround: '#ecfdf5',
  bad: '#b91c1c',
  badGround: '#fef2f2',
  warn: '#b45309',
  warnGround: '#fffbeb',
};

// Seven steps, with real gaps. Hierarchy comes from the jump between them.
export const type = {
  display: 42,
  title: 28,
  heading: 20,
  subheading: 16,
  body: 15,
  small: 13,
  micro: 11,
};

// One spacing rhythm. Section gaps are clearly larger than anything inside a
// section, which is what makes a page read as sections at all.
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 40,
  section: 72,
};

export const radius = { sm: 6, md: 9, lg: 12, pill: 999 };

// Every figure a reader compares down a column: balances, token counts,
// prices, block heights. Proportional digits make a column of rupees ragged
// and make two amounts of the same magnitude look different lengths.
export const figures = {
  fontVariantNumeric: 'tabular-nums',
  fontFeatureSettings: '"tnum" 1',
};

// Money carries its figures plus the weight that makes it the primary number
// on the screen it appears on.
export const money = { ...figures, fontWeight: 600, color: colour.ink };

// A surface is separated from the page by tone, not by a hairline and not by
// a shadow. Shadows are for things that genuinely float: a menu, a dialog.
export const surface = {
  background: colour.groundAlt,
  borderRadius: radius.lg,
  padding: space.xl,
};

// Pending work must not look like finished work. A settled row and a row
// waiting on a counterparty are different facts and were rendered
// identically.
export const row = {
  settled: { color: colour.ink },
  pending: { color: colour.inkMuted, background: colour.warnGround },
  failed: { color: colour.bad, background: colour.badGround },
};

export default { colour, type, space, radius, figures, money, surface, row };
