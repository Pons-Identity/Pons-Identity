// The images a page shows. Session branding carries their addresses (the server resolves them); the settings' previews have only the
// names, and resolve them with the list of uploaded images (`assets`: name to address).
// The header has its own logo and logotype (Branding). The sign-in page has its own (Sign-in page settings): the two never mix.
export function brandImages(branding = {}, assets = {}) {
  return {
    logo: branding.logoUrl || assets[branding.logoImage] || branding.logo || '',
    wordmark: branding.wordmarkUrl || assets[branding.wordmarkImage] || '',
    background: branding.loginBackgroundUrl || assets[branding.loginBackground] || '',
    favicon: branding.faviconUrl || assets[branding.faviconImage] || '',
  };
}

/** The logo and logotype the sign-in page shows: its own, or the older logo upload while none is chosen. */
export function signInImages(branding = {}, assets = {}) {
  return {
    logo: branding.loginLogoUrl || assets[branding.loginLogoImage] || branding.logo || '',
    wordmark: branding.loginWordmarkUrl || assets[branding.loginWordmarkImage] || '',
    background: branding.loginBackgroundUrl || assets[branding.loginBackground] || '',
  };
}

/** The mark in the header: the logotype when there is one, otherwise the logo. */
export function headerMark(branding = {}, assets = {}) {
  const { logo, wordmark } = brandImages(branding, assets);
  return wordmark || logo;
}
