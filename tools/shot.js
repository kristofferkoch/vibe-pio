// Dev helper (not part of any gate): screenshot a page with webfonts
// settled — headless --screenshot races font loading, so this uses the
// repo's CDP plumbing, awaits document.fonts.ready + a real beat, then
// captures. Usage: node tools/shot.js <url> <out.png> [w] [h] [waitMs]
'use strict';
const browser = require('../web/tests/browser.js');

(async () => {
  const [url, out, w = '1600', h = '900', wait = '1200'] = process.argv.slice(2);
  const b = await browser.launch();
  const p = await b.newPage();
  await p.setViewport(+w, +h);
  await p.goto(url);
  await p.evaluate('document.fonts.ready.then(() => {})');
  await new Promise((r) => setTimeout(r, +wait));
  const { data } = await p.send('Page.captureScreenshot', { format: 'png' });
  require('node:fs').writeFileSync(out, Buffer.from(data, 'base64'));
  await b.close();
  console.log('wrote', out);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
