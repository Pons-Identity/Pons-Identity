import { useEffect } from 'react';

// Loads an installed font family (its @font-face rules come from the IdP, so no outside host is contacted) into a <link> in the
// head. An empty family removes the link. `id` lets a preview load its own family beside the one the site uses.
export default function useFontStylesheet(family, id = 'brand-font') {
  useEffect(() => {
    const existing = document.getElementById(id);
    if (!family) {
      existing?.remove();
      return;
    }
    const link = existing || Object.assign(document.createElement('link'), { id, rel: 'stylesheet' });
    link.href = `/api/branding/font.css?family=${encodeURIComponent(family)}`;
    if (!existing) document.head.appendChild(link);
  }, [family, id]);

  useEffect(() => () => document.getElementById(id)?.remove(), [id]);
}
