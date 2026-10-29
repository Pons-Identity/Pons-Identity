// The class name that sets an installed font family, for the sign-in page's CSS and HTML: "Acme Sans" is `idp-font-acme-sans`.
// The same rule as src/fonts.js on the server, which writes the class rules.
export const fontClass = (family) => `idp-font-${String(family).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
