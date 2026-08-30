// The X server's core-font fallback. Athena/Xt clients (xmessage, xfontsel,
// xclock, xedit) load a SERVER-side font at startup and abort with "Unable
// to load any usable ISO8859 font" if none exists — which is exactly what
// happened on a host with no xfonts-base installed, because GTK/GIMP never
// exercised the path (Xft rasterizes client-side and ships images).
import { XServer } from '../xserver.mjs';
import { builtinFont } from '../font5x7.mjs';

let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log('  ' + name + ' ok');
  else { console.log('  ' + name + ' FAIL ' + detail); fail++; }
};

// 1. A server given no fonts at all must still serve one.
{
  const xs = new XServer({ width: 320, height: 200 });
  check('default server has a font', !!xs.defaultFont, '(defaultFont null)');
  const pats = ['fixed', '9x15', '-misc-fixed-*', '*-iso8859-1',
                '-*-*-*-R-Normal--*-120-*-*-*-*-ISO8859-1'];
  const missed = pats.filter(p => !xs.matchFont(p));
  check('common font patterns all match', missed.length === 0, missed.join(', '));
  check('ListFonts is non-empty', xs.listFonts('*').length > 0, '(no names)');
}

// 2. Every printable ASCII glyph must exist, with metrics the QueryFont reply
//    and the rasterizer can both use.
{
  const f = builtinFont();
  let bad = [];
  for (let c = 32; c <= 126; c++) {
    const g = f.glyph(c);
    if (!g || g.width <= 0 || !Array.isArray(g.rows) || g.rows.length !== f.ascent) bad.push(c);
  }
  check('all printable ASCII glyphs present', bad.length === 0, 'missing/short: ' + bad.join(','));
  check('textWidth is proportional', f.textWidth('AAAA') === 4 * f.glyph(65).width,
        String(f.textWidth('AAAA')));
  // A font whose glyphs are all blank would pass everything above.
  const ink = (ch) => f.glyph(ch.charCodeAt(0)).rows.reduce((a, r) => a + r.reduce((x, v) => x + v, 0), 0);
  check('glyphs have ink', ink('A') > 5 && ink('m') > 5 && ink('0') > 5,
        `A=${ink('A')} m=${ink('m')} 0=${ink('0')}`);
  check('space is blank, M is not', ink(' ') === 0 && ink('M') > 0, `sp=${ink(' ')} M=${ink('M')}`);
  // Distinct characters must not render identically — a table shifted by one
  // entry still has ink everywhere but shows the wrong letters.
  const sig = (ch) => f.glyph(ch.charCodeAt(0)).rows.map(r => r.join('')).join('|');
  const seen = new Map(); let dup = [];
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
    const s = sig(ch); if (seen.has(s)) dup.push(seen.get(s) + '=' + ch); else seen.set(s, ch);
  }
  // 'l'/'I' and 'O'/'0' style collisions are acceptable in a 5x7 cell; a
  // shifted table would collide far more than that.
  check('glyphs are distinct', dup.length <= 2, 'collisions: ' + dup.join(' '));
}

// 3. A real supplied font must still win — the fallback is last-resort only.
{
  const fake = { ...builtinFont(), _mine: true };
  const xs = new XServer({ width: 320, height: 200, fonts: { '6x13': fake } });
  check('supplied font wins over the fallback', xs.matchFont('6x13')._mine === true, '(fallback shadowed a real font)');
  check('supplied font is the default', xs.defaultFont._mine === true, '(defaultFont is the fallback)');
}

if (fail) { console.log(`FONTTEST ${fail} FAILED`); process.exit(1); }
console.log('X core-font fallback: Athena clients can always open a font');
