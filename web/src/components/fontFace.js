// Weight words as font files usually spell them. Longer words come first, so "semibold" is not read as "bold".
const WEIGHT_WORDS = [
  ['extrabold', 800], ['ultrabold', 800], ['semibold', 600], ['demibold', 600], ['extralight', 200], ['ultralight', 200],
  ['bold', 700], ['light', 300], ['medium', 500], ['black', 900], ['heavy', 900], ['hairline', 100], ['thin', 100], ['regular', 400],
];
const WEIGHT_NAMES = { 100: 'Thin', 200: 'Extra light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' };
// The four faces a family usually needs. Without one, the browser draws that face itself.
const COMMON_FACES = [['normal', 400], ['normal', 700], ['italic', 400], ['italic', 700]];

/**
 * A guess at a font file's style and weight from its name, such as "AcmeSans-BoldItalic.woff2" (italic, 700). The administrator
 * sees the guess and can change it, so a wrong guess costs one click.
 */
export function guessFace(filename) {
  const name = String(filename || '').replace(/\.[^.]+$/, '').toLowerCase().replace(/[\s_-]/g, '');
  const style = /italic|oblique/.test(name) ? 'italic' : 'normal';
  const hit = WEIGHT_WORDS.find(([word]) => name.includes(word));
  return { style, weight: hit ? hit[1] : 400 };
}

/** A face as people name it: "Bold", "Bold italic", "Italic" (for regular italic), "Light". */
export function faceName(style, weight) {
  if (style === 'italic') return weight === 400 ? 'Italic' : `${WEIGHT_NAMES[weight] || weight} italic`;
  return WEIGHT_NAMES[weight] || String(weight);
}

/** The common faces (regular, bold, italic, bold italic) that a family's faces do not include, by name. */
export function missingFaces(faces) {
  return COMMON_FACES
    .filter(([style, weight]) => !faces.some((f) => f.style === style && f.weight === weight))
    .map(([style, weight]) => faceName(style, weight));
}
