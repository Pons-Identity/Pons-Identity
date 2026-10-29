// A small user-agent reader for the sign-in log: enough to tell a person's browser and device apart from a script, not a
// full database. Order matters: many browsers also say "Chrome" or "Safari".

const BROWSERS = [
  ['Edge', /\b(?:Edg|EdgA|EdgiOS|Edge)\/([\d.]+)/], ['Opera', /\b(?:OPR|Opera)\/([\d.]+)/], ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/([\d.]+)/], ['Chrome', /\b(?:Chrome|CriOS)\/([\d.]+)/], ['Safari', /Version\/([\d.]+).*Safari/],
  ['curl', /^curl\/([\d.]+)/], ['Python', /python-(?:requests|urllib3|httpx)\/([\d.]+)|^Python-urllib\/([\d.]+)/i], ['Go HTTP client', /^Go-http-client\/([\d.]+)/],
  ['Java', /^Java\/([\d.]+)|Apache-HttpClient\/([\d.]+)/], ['Node', /^node(?:-fetch)?\/?([\d.]*)|^axios\/([\d.]+)|^undici/i], ['Postman', /PostmanRuntime\/([\d.]+)/],
];
const OSES = [
  ['iOS', /\b(?:iPhone|iPad|iPod)\b|CPU (?:iPhone )?OS/], ['Android', /\bAndroid\b/], ['Windows', /\bWindows\b/], ['macOS', /\bMac OS X\b|\bMacintosh\b/],
  ['ChromeOS', /\bCrOS\b/], ['Linux', /\bLinux\b|\bX11\b/],
];
const SCRIPTS = new Set(['curl', 'Python', 'Go HTTP client', 'Java', 'Node', 'Postman']);

function parse(ua) {
  const s = String(ua || '');
  if (!s) return { browser: '', os: '', device_type: 'unknown' };
  let browser = '';
  for (const [name, re] of BROWSERS) {
    const m = re.exec(s);
    if (m) { const v = m.slice(1).find(Boolean) || ''; browser = SCRIPTS.has(name) ? name : `${name}${v ? ` ${v.split('.')[0]}` : ''}`; break; }
  }
  const os = (OSES.find(([, re]) => re.test(s)) || [''])[0];
  const name = browser.replace(/ [\d.]+$/, '');
  let device_type = 'desktop';
  if (SCRIPTS.has(name) || /\b(?:bot|crawler|spider)\b/i.test(s) || !browser) device_type = browser || /bot|crawler|spider/i.test(s) ? 'script' : 'unknown';
  else if (/\biPad\b|\bTablet\b/i.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) device_type = 'tablet';
  else if (/Mobile|iPhone|iPod|Android/.test(s)) device_type = 'mobile';
  return { browser, os, device_type };
}

module.exports = { parse };
