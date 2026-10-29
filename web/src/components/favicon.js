import { useEffect } from 'react';

// Draws an image, fitted and centred, onto a square canvas and returns it as a PNG address. Null where the browser cannot do it.
export function imageAsPng(url, size = 64) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) return resolve(null);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        return resolve(canvas.toDataURL('image/png'));
      } catch {
        return resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

const ID = 'site-favicon';

// The browser tab icon. An uploaded favicon is used as it is. With none, a logo is converted to a 64-pixel PNG; if that cannot be
// done here, the logo itself is offered. With neither, the browser's own icon is used.
export default function useFavicon({ faviconUrl = '', logoUrl = '' }) {
  useEffect(() => {
    let cancelled = false;
    const existing = document.getElementById(ID);
    const setHref = (href) => {
      const link = document.getElementById(ID) || Object.assign(document.createElement('link'), { id: ID, rel: 'icon' });
      link.href = href;
      if (!link.isConnected) document.head.appendChild(link);
    };
    if (faviconUrl) setHref(faviconUrl);
    else if (logoUrl) imageAsPng(logoUrl).then((png) => { if (!cancelled) setHref(png || logoUrl); });
    else existing?.remove();
    return () => { cancelled = true; };
  }, [faviconUrl, logoUrl]);
}
