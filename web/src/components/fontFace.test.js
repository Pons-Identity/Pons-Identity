import { expect, test } from 'vitest';
import { faceName, guessFace, missingFaces } from './fontFace.js';

test('a file name tells the style and weight, bold italic included', () => {
  expect(guessFace('AcmeSans-BoldItalic.woff2')).toEqual({ style: 'italic', weight: 700 });
  expect(guessFace('Acme Sans Bold Italic.otf')).toEqual({ style: 'italic', weight: 700 });
  expect(guessFace('AcmeSans-Bold.woff2')).toEqual({ style: 'normal', weight: 700 });
  expect(guessFace('AcmeSans-Italic.ttf')).toEqual({ style: 'italic', weight: 400 });
  expect(guessFace('AcmeSans-Regular.woff')).toEqual({ style: 'normal', weight: 400 });
});

test('longer weight words win, so semibold and extra bold are not read as bold', () => {
  expect(guessFace('Acme-SemiBold.woff2').weight).toBe(600);
  expect(guessFace('Acme-ExtraBold.woff2').weight).toBe(800);
  expect(guessFace('Acme-ExtraLight.woff2').weight).toBe(200);
  expect(guessFace('Acme-Light.woff2').weight).toBe(300);
  expect(guessFace('Acme-Black Italic.woff2')).toEqual({ style: 'italic', weight: 900 });
});

test('a file with no recognisable name is regular upright, for the administrator to correct', () => {
  expect(guessFace('font.woff2')).toEqual({ style: 'normal', weight: 400 });
  expect(guessFace(undefined)).toEqual({ style: 'normal', weight: 400 });
});

test('faces are named the way people say them', () => {
  expect(faceName('normal', 400)).toBe('Regular');
  expect(faceName('italic', 400)).toBe('Italic');
  expect(faceName('italic', 700)).toBe('Bold italic');
  expect(faceName('normal', 700)).toBe('Bold');
});

test('the common faces a family lacks are listed, so the administrator sees what the browser will draw itself', () => {
  expect(missingFaces([{ style: 'normal', weight: 400 }, { style: 'italic', weight: 400 }])).toEqual(['Bold', 'Bold italic']);
  expect(missingFaces([{ style: 'normal', weight: 400 }, { style: 'normal', weight: 700 }, { style: 'italic', weight: 400 }, { style: 'italic', weight: 700 }])).toEqual([]);
});
