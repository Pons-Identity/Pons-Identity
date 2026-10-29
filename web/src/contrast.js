import { getContrastRatio } from '@mui/material/styles';

// WCAG 2 contrast. The admin is warned below 4.5:1, the level WCAG asks for normal-size text. MUI's helper is used so every
// color form the theme produces (hex, and the rgb() that MUI's darken makes for hover) is read the same way.
export const MIN_CONTRAST = 4.5;

/** The contrast ratio of two colors, from 1 (none) to 21 (black on white). */
export const contrastRatio = (a, b) => getContrastRatio(a, b);

/** Whichever of white and black reads better on the background. */
export function bestText(background) {
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, '#000000') ? '#ffffff' : '#000000';
}
