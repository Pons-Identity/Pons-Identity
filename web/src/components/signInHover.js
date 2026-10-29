import { hoverTooltip } from '@codemirror/view';
import { BUILTIN_CLASSES, VARIABLES, scopedRuleSelector } from '../loginTemplate.js';

// Hover tips for the sign-in page's CSS and HTML editors, in the manner of VS Code's rule calculator. Hovering a selector shows the
// elements it matches in the page, as `<tag class="...">` lines, with its specificity. Hovering a property shows what it does and
// which elements the rule it is in applies to. A built-in class says what it is; a file name shows the image. The matching runs on
// the same markup the page is drawn from (the administrator's template, or the built-in page), scoped the same way the page scopes
// its CSS.

// Pseudo-classes and pseudo-elements that depend on the pointer, focus or text: the matching leaves them out.
const STATE = /::?(hover|focus|focus-visible|focus-within|active|visited|placeholder|before|after|selection|first-line|first-letter)\b/g;
// The mode classes the page adds to its content (light or dark), which the markup does not contain.
const MODE_CLASS = /\.idp-(light|dark)\b/g;

const VARIABLE_DOCS = {
  '--idp-primary': 'The primary color for the current mode (buttons, links). The light and dark colors are set under Branding.',
  '--idp-header': 'The header color, or the primary color when no header color is set.',
};

// What the common CSS properties do, for the tip on a property name. Any other property still gets the elements its rule matches.
const PROPERTY_DOCS = {
  'color': 'The text color.',
  'background': 'The background: a color, a picture and how the picture sits, in one value.',
  'background-color': 'The color behind the element.',
  'background-image': 'A picture behind the element, such as url(\'picture.png\').',
  'background-size': 'How a background picture is scaled: cover fills the box, contain fits it inside.',
  'background-position': 'Where a background picture sits in the box, such as center.',
  'border': 'The line around the box: width, style and color.',
  'border-radius': 'Rounds the corners of the box. Larger values give rounder corners.',
  'box-shadow': 'A shadow around the box: horizontal and vertical offset, blur, spread and color.',
  'display': 'How the box takes part in the layout: block, inline, flex, grid, or none to hide it.',
  'width': 'The width of the box.',
  'max-width': 'The widest the box can be, however wide its container is.',
  'min-width': 'The narrowest the box can be, however narrow its container is.',
  'height': 'The height of the box.',
  'max-height': 'The tallest the box can be.',
  'min-height': 'The shortest the box can be.',
  'padding': 'Space between the edge of the box and its content.',
  'margin': 'Space outside the box, between it and its neighbours.',
  'font-family': 'The typeface, as a list of family names; the first installed one is used.',
  'font-size': 'The size of the text.',
  'font-weight': 'How bold the text is, from 100 (thin) to 900 (black); 400 is normal and 700 bold.',
  'font-style': 'Whether the text is upright, italic or oblique.',
  'line-height': 'The height of each line of text, as a multiple of the font size.',
  'letter-spacing': 'The space between letters.',
  'text-align': 'How lines of text are aligned: left, center, right or justify.',
  'text-decoration': 'Underlines, overlines or strike-through on the text.',
  'text-transform': 'Changes the case of the text: uppercase, lowercase or capitalize.',
  'opacity': 'How see-through the element is, from 0 (invisible) to 1 (solid).',
  'position': 'How the box is placed: static, relative, absolute, fixed or sticky.',
  'top': 'The distance from the top edge, for a box that is positioned.',
  'left': 'The distance from the left edge, for a box that is positioned.',
  'right': 'The distance from the right edge, for a box that is positioned.',
  'bottom': 'The distance from the bottom edge, for a box that is positioned.',
  'z-index': 'Which box is stacked in front when boxes overlap. Larger is in front.',
  'overflow': 'What happens to content that does not fit: shown, hidden, scrolled or clipped.',
  'filter': 'Visual effects on the element, such as blur(), brightness() and contrast().',
  'transform': 'Moves, rotates, scales or skews the element.',
  'transition': 'Animates changes to a property over time.',
  'cursor': 'The pointer shape over the element, such as pointer for a link.',
  'gap': 'The space between the items of a flex or grid layout.',
  'flex': 'How a flex item grows and shrinks to fill its row or column.',
  'justify-content': 'How items are spaced along the main axis of a flex or grid layout.',
  'align-items': 'How items are aligned across the cross axis of a flex or grid layout.',
  'outline': 'A line drawn outside the box, often for focus.',
};

/** The selector of the rule that `pos` is in, when `pos` is in a selector rather than in a block. Null otherwise. */
export function selectorAt(text, pos) {
  const open = text.indexOf('{', pos);
  if (open < 0) return null;
  const close = text.indexOf('}', pos);
  if (close >= 0 && close < open) return null;
  const start = text.lastIndexOf('}', Math.max(0, pos - 1)) + 1;
  if (pos < start) return null;
  const raw = text.slice(start, open).replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));
  if (!raw.trim() || raw.includes(';') || raw.trim().startsWith('@')) return null;
  const lead = raw.length - raw.trimStart().length;
  return { selector: raw.trim(), from: start + lead, to: start + raw.trimEnd().length };
}

/** The rule whose block `pos` is inside, with its selector; null when `pos` is outside every block. */
export function ruleAt(text, pos) {
  const open = text.lastIndexOf('{', pos);
  if (open < 0 || text.lastIndexOf('}', pos) > open) return null;
  const start = text.lastIndexOf('}', open - 1) + 1;
  const raw = text.slice(start, open).replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));
  if (!raw.trim() || raw.trim().startsWith('@')) return null;
  return { selector: raw.trim() };
}

// Specificity compares by ids, then classes (and attributes and pseudo-classes), then elements.
const compareSpecificity = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * The specificity of a selector as (ids, classes and attributes and pseudo-classes, elements), the way CSS counts it. A selector
 * list counts as its most specific part.
 */
export function specificityOf(selector) {
  const parts = String(selector).replace(/"[^"]*"|'[^']*'/g, '').split(',').map((p) => p.trim()).filter(Boolean);
  let best = [0, 0, 0];
  for (const part of parts) {
    const ids = (part.match(/#[\w-]+/g) || []).length;
    const attrs = (part.match(/\[[^\]]*\]/g) || []).length;
    const withoutAttrs = part.replace(/\[[^\]]*\]/g, ' ');
    const classes = (withoutAttrs.match(/\.[\w-]+/g) || []).length;
    const pseudoClasses = (withoutAttrs.match(/(^|[^:]):[\w-]+/g) || []).length;
    const pseudoElements = (withoutAttrs.match(/::[\w-]+/g) || []).length;
    const bare = withoutAttrs.replace(/::?[\w-]+(\([^)]*\))?/g, ' ').replace(/[#.][\w-]+/g, ' ');
    const elements = (bare.match(/(^|[\s>+~(])[a-zA-Z][\w-]*/g) || []).length + pseudoElements;
    const score = [ids, classes + attrs + pseudoClasses, elements];
    if (compareSpecificity(score, best) > 0) best = score;
  }
  return best;
}

/** Matches the selector against the page's markup, without the pointer, focus or text states. */
export function matchesFor(markup, selector) {
  const states = [...selector.matchAll(STATE)].map((m) => m[0]);
  const bare = selector.replace(STATE, '');
  const scoped = scopedRuleSelector(bare);
  if (!scoped) return { error: 'The selector is empty.' };
  // The mode classes are not in the markup (the page adds them when drawn), so a dark-mode rule finds the elements it would in dark mode.
  const matchable = scopedRuleSelector(bare.replace(MODE_CLASS, '')) || '.idp-login';
  const doc = new DOMParser().parseFromString(`<body><div class="idp-login">${markup}</div></body>`, 'text/html');
  try {
    const elements = [...doc.body.querySelectorAll(matchable)];
    return {
      count: elements.length,
      elements: elements.slice(0, 8).map(openTag),
      specificity: specificityOf(scoped),
      ignored: [...new Set(states)],
    };
  } catch {
    return { error: 'The browser does not understand this selector.' };
  }
}

// An element as it appears in the markup: `<div id="x" class="a b">`, the way VS Code shows it.
function openTag(el) {
  const attrs = [];
  if (el.id) attrs.push(`id="${el.id}"`);
  const classes = [...el.classList].join(' ');
  if (classes) attrs.push(`class="${classes}"`);
  return `<${el.tagName.toLowerCase()}${attrs.map((a) => ` ${a}`).join('')}>`;
}

// The run of characters a name is made of, around a position, and where it starts and ends.
function wordAt(text, pos, re = /[\w-]/) {
  let from = pos;
  let to = pos;
  while (from > 0 && re.test(text[from - 1])) from--;
  while (to < text.length && re.test(text[to])) to++;
  return { from, to, value: text.slice(from, to) };
}

// The file name (or URL) under the pointer, in quotes, in url(...), or in an attribute.
function fileAt(text, pos) {
  const word = wordAt(text, pos, /[^\s"'()<>{};,=]/);
  return word.value ? word : null;
}

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
};

const code = (text) => {
  const node = el('div', text, 'cm-signin-element');
  node.style.fontFamily = 'monospace';
  return node;
};

function tooltip(from, to, children) {
  return {
    pos: from,
    end: to,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-signin-tip';
      dom.style.cssText = 'padding:6px 8px;max-width:440px;font-size:12.5px;line-height:1.45;';
      dom.append(...children);
      return { dom };
    },
  };
}

function imageTip(from, to, name, url) {
  const img = document.createElement('img');
  img.src = url;
  img.alt = name;
  img.style.cssText = 'display:block;max-width:240px;max-height:160px;margin-top:4px;';
  return tooltip(from, to, [el('strong', name), img]);
}

// The elements a selector matches, the way VS Code's tip lists them, with the selector's specificity.
function matchLines(markupOf, selector, where) {
  const result = matchesFor(markupOf(), selector);
  if (result.error) return [el('div', result.error)];
  const lines = [];
  if (result.count === 0) lines.push(el('div', `No element in ${where} matches this rule.`));
  for (const tag of result.elements) lines.push(code(tag));
  if (result.count > result.elements.length) lines.push(el('div', `…and ${result.count - result.elements.length} more`));
  lines.push(el('div', `Selector Specificity: (${result.specificity.join(', ')})`, 'cm-signin-specificity'));
  if (result.ignored.length) lines.push(el('div', `${result.ignored.join(', ')} is not checked: it depends on the pointer, focus or text.`));
  return lines;
}

// A meta class (the page's mode) says what it is; it does not match elements of its own.
const metaTip = (from, to, doc) => tooltip(from, to, [el('strong', `.${doc.name}`), el('div', doc.what)]);

function matchTip(from, to, markupOf, selector, where, note) {
  return tooltip(from, to, [el('strong', selector), ...(note ? [el('div', note)] : []), ...matchLines(markupOf, selector, where)]);
}

/**
 * CSS editor hover. `markup()` gives the page's markup for the matching, `assets()` the uploaded images (name to address),
 * `fontClasses()` the font class names (class to family), and `where` names the markup in the tip ("the built-in page").
 */
export function cssHover({ markup, assets = () => ({}), fontClasses = () => ({}), where = 'the sign-in page' }) {
  return hoverTooltip((view, pos) => {
    const text = view.state.doc.toString();
    const place = typeof where === 'function' ? where() : where;
    const names = assets();
    const file = fileAt(text, pos);
    if (file && names[file.value]) return imageTip(file.from, file.to, file.value, names[file.value]);

    const word = wordAt(text, pos);
    const isVariable = text.slice(word.from - 2, word.from) === '--';
    if (isVariable && VARIABLE_DOCS[`--${word.value}`]) {
      return tooltip(word.from - 2, word.to, [el('strong', `--${word.value}`), el('div', VARIABLE_DOCS[`--${word.value}`])]);
    }
    const isClass = text[word.from - 1] === '.' && word.value.startsWith('idp-');
    if (isClass) {
      const family = fontClasses()[word.value];
      if (family) return tooltip(word.from - 1, word.to, [el('strong', `.${word.value}`), el('div', `Sets the font "${family}".`)]);
      const doc = BUILTIN_CLASSES.find((c) => c.name === word.value);
      if (doc?.meta) return metaTip(word.from - 1, word.to, doc);
      if (doc) return matchTip(word.from - 1, word.to, markup, `.${word.value}`, place, doc.what);
    }

    const rule = selectorAt(text, pos);
    if (rule && pos >= rule.from && pos <= rule.to) return matchTip(rule.from, rule.to, markup, rule.selector, place);

    // A property name inside a block: what it does, and the elements the rule it is in applies to.
    const inBlock = ruleAt(text, pos);
    if (inBlock && /^\s*:/.test(text.slice(word.to, word.to + 12)) && word.value) {
      const doc = PROPERTY_DOCS[word.value] || (word.value.startsWith('margin') ? PROPERTY_DOCS.margin
        : word.value.startsWith('padding') ? PROPERTY_DOCS.padding : 'A CSS property. The rule applies to the elements listed.');
      return tooltip(word.from, word.to, [el('strong', word.value), el('div', doc),
        el('div', `Applies to the elements of this rule, ${inBlock.selector}:`), ...matchLines(markup, inBlock.selector, place)]);
    }
    return null;
  }, { hoverTime: 300 });
}

/**
 * HTML editor hover: a {{variable}} says what it becomes; a file name shows the image; a class in class="..." shows what the
 * built-in classes are for, and the elements in the page that have it.
 */
export function htmlHover({ markup, assets = () => ({}), fontClasses = () => ({}), where = 'the sign-in page' }) {
  return hoverTooltip((view, pos) => {
    const text = view.state.doc.toString();
    const place = typeof where === 'function' ? where() : where;
    for (const m of text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
      const from = m.index;
      const to = from + m[0].length;
      if (pos < from || pos > to) continue;
      const variable = VARIABLES.find((v) => v.name === m[1]);
      if (!variable) return tooltip(from, to, [el('strong', `{{${m[1]}}}`), el('div', 'Not a variable this page has. It will be left empty.')]);
      return tooltip(from, to, [el('strong', `{{${variable.name}}}`), el('div', variable.description)]);
    }

    const names = assets();
    const file = fileAt(text, pos);
    if (file && names[file.value]) return imageTip(file.from, file.to, file.value, names[file.value]);

    for (const m of text.matchAll(/\bclass\s*=\s*"([^"]*)"/g)) {
      const start = m.index + m[0].indexOf('"') + 1;
      const end = start + m[1].length;
      if (pos < start || pos > end) continue;
      const word = wordAt(text, pos);
      if (!word.value || word.from < start || word.to > end) return null;
      const family = fontClasses()[word.value];
      if (family) return tooltip(word.from, word.to, [el('strong', word.value), el('div', `Sets the font "${family}".`)]);
      const doc = BUILTIN_CLASSES.find((c) => c.name === word.value);
      if (doc?.meta) return metaTip(word.from, word.to, doc);
      if (doc) return matchTip(word.from, word.to, markup, `.${word.value}`, place, doc.what);
      return null;
    }
    return null;
  }, { hoverTime: 300 });
}
