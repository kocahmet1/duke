/* ===========================================================================
   scripts/tr/apply.mjs -- put the Turkish (Seydişehir Çatışma) text back.

   The game's player-facing text was translated in place. A session that
   rewrites a file from a copy it took before the translation (this happened
   to nz-touch.js once) brings the English back. This re-applies every entry
   of ceviri.txt that has gone missing and leaves everything else alone.

       node scripts/tr/apply.mjs            apply what is missing
       node scripts/tr/apply.mjs --check    only report; exit 1 if anything is

   An entry whose English is gone and whose Turkish is present is done. An
   entry that finds neither is reported: that code changed, translate it by
   hand. New player-facing text should be written in Turkish to begin with.
   ======================================================================== */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CHECK = process.argv.includes('--check');

const lines = (await readFile(path.join(HERE, 'ceviri.txt'), 'utf8')).split('\n');
const plan = new Map();
for (let i = 0, cur = null; i < lines.length;) {
  const ln = lines[i];
  if (ln.startsWith('@@FILE ')) { cur = ln.slice(7).trim(); if (!plan.has(cur)) plan.set(cur, []); i++; continue; }
  if (ln.startsWith('@@OLD')) {
    const cnt = Number(ln.split(/\s+/)[1] || 1);
    const old = [], neu = [];
    for (i++; !lines[i].startsWith('@@NEW'); i++) old.push(lines[i]);
    for (i++; !lines[i].startsWith('@@END'); i++) neu.push(lines[i]);
    i++;
    plan.get(cur).push({ old: old.join('\n'), neu: neu.join('\n'), cnt });
    continue;
  }
  i++;
}
/* the stale public copy gets the page's entries, as far as they still fit */
plan.set('public/game/NUKEM.html', plan.get('NUKEM.html').map(e => ({ ...e, lenient: true })));

const count = (s, sub) => s.split(sub).length - 1;
let todo = 0, stuck = 0;
for (const [rel, entries] of plan) {
  const file = path.join(ROOT, rel);
  let src;
  try { src = await readFile(file, 'utf8'); } catch { console.log(`${rel}: not found, skipped`); continue; }
  const before = src;
  let applied = 0, done = 0;
  for (const e of entries) {
    const n = count(src, e.old);
    if (n === e.cnt || (e.lenient && n > 0)) { src = src.split(e.old).join(e.neu); applied++; }
    else if (n === 0 && src.includes(e.neu)) done++;
    else if (!e.lenient) { stuck++; console.log(`  ${rel}: ${n ? `found ${n}x, expected ${e.cnt}` : 'neither English nor Turkish found'} :: ${JSON.stringify(e.old.slice(0, 90))}`); }
  }
  todo += applied;
  console.log(`${rel}: ${done} done${applied ? `, ${applied} ${CHECK ? 'NEED APPLYING' : 'applied'}` : ''}`);
  if (!CHECK && src !== before) {
    /* refuse to overwrite a file someone changed while we were working */
    if (await readFile(file, 'utf8') !== before) { console.log(`  ${rel}: changed meanwhile, run again`); stuck++; continue; }
    await writeFile(file, src);
  }
}
if (CHECK && todo) console.log(`\n${todo} entries are English again: run  node scripts/tr/apply.mjs`);
process.exit((CHECK && todo) || stuck ? 1 : 0);
