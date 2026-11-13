import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile("NUKEM.html", "utf8");

function slice(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`NUKEM.html: AI harness marker missing: ${start}`);
  return html.slice(a, b);
}

function expect(ok, message) {
  if (!ok) throw new Error(`NUKEM.html: ${message}`);
}

/* These checks keep the two real firearm call sites on the tested helper.
   `kind === 'shot'` is also used by grenade impacts and detonations, so a
   blanket clamp inside aiNoise would silently make explosions easy-only quiet. */
expect(/aiNoise\(player\.x, player\.z, aiGunshotRadius\(reportRadius\), 'shot'\)/.test(html),
  "player muzzle reports do not use the skill hearing cap");
expect(/aiNoise\(e\.x, e\.z, aiGunshotRadius\(96\), 'friendly'\)/.test(html),
  "enemy muzzle reports do not use the skill hearing cap");
expect(/if \(D\.coordinate\) aiNoise\(e\.x, e\.z, 34, 'mech'\)/.test(html),
  "easy AI can still learn from another enemy's reload");
expect(/function startGame\(\)[\s\S]*?if \(NAV\.ready\) buildSquads\(\);[\s\S]*?hideScreens\(\);/.test(html),
  "squads are not rebuilt after the title-screen skill choice");

const source = [
  slice("const SKILLS = [", "const ECFG ="),
  slice("const AI_CAP =", "/* ---------------------------------------------------------------- nav ---- */"),
  slice("function aiNoise(", "/* the single write path for \"where the enemy thinks you are\" */"),
  slice("const SQUADS = [];", "/* Radio traffic."),
  slice("function squadRadio(", "function squadThink("),
  slice("function enemyRepulsion(", "/* ============================================================ enemy brain =="),
  slice("function alarmChamber(", "function damageEnemy("),
  `
  function check(ok, message) { if (!ok) throw new Error(message); }
  function hearingEnemy(x) {
    return {
      x, y: 0, z: 0, dead: false,
      cfg: { alert: 'alert' },
      ai: { known: false, kAge: 99, alert: 0, see: false, seeT: 0, barkT: 0 }
    };
  }
  function slotEnemy(uid, sq) {
    const e = {
      uid, x: uid, y: 0, z: 0, dead: false, squad: sq,
      ai: { see: true, reloadT: 0, react: 0, alert: 1, free: false, wasFree: false }
    };
    sq.mem.push(e);
    return e;
  }

  /* Skill controls and the muzzle-report boundary. */
  check(SKILLS[0].coordinate === false, 'easy must disable coordination');
  check(SKILLS[0].shotHear === 24, 'easy gunshot hearing must be 24 world units');
  check(SKILLS.slice(1).every(s => s.coordinate && s.shotHear === Infinity),
    'skills 2-4 must retain coordinated AI and authored hearing radii');
  D = SKILLS[0];
  check(aiGunshotRadius(140) === 24 && aiGunshotRadius(40) === 24 && aiGunshotRadius(20) === 20,
    'easy muzzle-report cap is incorrect');
  D = SKILLS[1];
  check(aiGunshotRadius(140) === 140 && aiGunshotRadius(40) === 40,
    'standard skill muzzle-report radii changed');

  /* Clear LOS: just inside easy range hears; just outside remains dormant. */
  D = SKILLS[0];
  let near = hearingEnemy(23.9), far = hearingEnemy(24.1);
  enemies.splice(0, enemies.length, near, far);
  losFast = () => true;
  aiNoise(0, 0, aiGunshotRadius(140), 'shot');
  check(near.ai.known && near.ai.alert === .85, 'near easy listener did not hear a gunshot');
  check(!far.ai.known && far.ai.alert === 0, 'distant easy listener heard a gunshot');

  /* Existing wall attenuation still applies to the shortened radius. */
  near = hearingEnemy(14.3); far = hearingEnemy(14.5);
  enemies.splice(0, enemies.length, near, far);
  losFast = () => false;
  aiNoise(0, 0, aiGunshotRadius(140), 'shot');
  check(near.ai.known, 'near occluded easy listener did not hear a gunshot');
  check(!far.ai.known, 'occluded easy listener heard beyond 60% of the radius');

  /* The cap is firearm-specific; footsteps keep their authored range. */
  far = hearingEnemy(50);
  enemies.splice(0, enemies.length, far);
  losFast = () => true;
  aiNoise(0, 0, 58, 'step');
  check(far.ai.known, 'easy accidentally shortened non-gunshot hearing');

  /* Building easy squads must erase the boot-time standard partition. */
  const deployed = [0, 1, 2].map((x, uid) => ({ uid, x, y: 0, z: 0, dead: false,
    squad: null, ai: { alert: 0, known: false, kAge: 99 } }));
  enemies.splice(0, enemies.length, ...deployed);
  losFast = () => true;
  D = SKILLS[1];
  buildSquads();
  check(SQUADS.length === 1 && deployed.every(e => e.squad === SQUADS[0]),
    'standard squad construction regression');
  D = SKILLS[0];
  buildSquads();
  check(SQUADS.length === 0 && deployed.every(e => e.squad === null),
    'easy retained a squad link');

  /* Radio cannot queue on easy, but remains unchanged on standard. */
  const radioSq = { radio: null };
  D = SKILLS[0];
  squadRadio(radioSq, deployed[0], 1, 0, 1, 1, 'contact');
  check(radioSq.radio === null, 'easy queued squad radio traffic');
  D = SKILLS[1];
  squadRadio(radioSq, deployed[0], 1, 0, 1, 1, 'contact');
  check(radioSq.radio && radioSq.radio.label === 'contact', 'standard squad radio regression');

  /* No per-team or global firing arbitration on easy. */
  let sq = { mem: [], _slotSeen: -1, _slotN: 0, _slotMax: 0 };
  let ready = [0, 1, 2, 3].map(uid => slotEnemy(uid, sq));
  enemies.splice(0, enemies.length, ...ready);
  D = SKILLS[0];
  aiFireSlots(.016);
  check(ready.every(e => e.ai.free), 'easy still schedules shared firing slots');
  sq = { mem: [], _slotSeen: -1, _slotN: 0, _slotMax: 0 };
  ready = [0, 1, 2, 3].map(uid => slotEnemy(uid, sq));
  enemies.splice(0, enemies.length, ...ready);
  D = SKILLS[1];
  aiFireSlots(.016);
  check(ready.filter(e => e.ai.free).length === 2, 'standard per-squad fire cap changed');

  /* Easy keeps collision spacing but drops coordinated angle splitting. */
  const actor = { x: 0, z: 0, dead: false, cfg: { rad: 1 }, ai: { alert: 1, known: true, kx: 20, kz: 0 } };
  const peer = { x: 6, z: 0, dead: false, cfg: { rad: 1 }, ai: { alert: 1 } };
  enemies.splice(0, enemies.length, actor, peer);
  D = SKILLS[0];
  const soloPush = enemyRepulsion(actor);
  check(Math.hypot(soloPush[0], soloPush[1]) === 0, 'easy still performs tactical angle splitting');
  D = SKILLS[1];
  const teamPush = enemyRepulsion(actor);
  check(Math.hypot(teamPush[0], teamPush[1]) > 0, 'standard tactical spacing regression');

  D = SKILLS[0];
  check(alarmChamber(actor, .6, .35) === 0, 'easy still propagates wound/death callouts');
  globalThis.__aiValidation = true;
  `
].join("\n");

const context = vm.createContext({
  console,
  enemies: [],
  player: { x: 0, z: 0 },
  CELL: 3.5,
  NAV: { ready: true },
  rr: (lo, hi) => (lo + hi) * .5,
  losFast: () => true,
  floorAt: () => 0,
  aiKnow: (enemy, x, y, z) => {
    enemy.ai.known = true;
    enemy.ai.kx = x; enemy.ai.ky = y; enemy.ai.kz = z; enemy.ai.kAge = 0;
  },
  sfx: () => {}
});

vm.runInContext(source, context);
expect(context.__aiValidation === true, "AI behavior harness did not complete");
console.log("NUKEM.html: easiest-skill solo AI and near-only gunshot hearing verified");
