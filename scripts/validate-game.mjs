import { readFile } from "node:fs/promises";
import vm from "node:vm";

const files = ["NUKEM.html", "public/game/NUKEM.html"];

for (const file of files) {
  const html = await readFile(file, "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);

  if (!scripts.length) throw new Error(`${file}: no inline game script found`);

  for (const [index, source] of scripts.entries()) {
    try {
      Function(source);
    } catch (error) {
      throw new Error(`${file}: inline script ${index + 1} failed to parse: ${error.message}`);
    }
  }

  console.log(`${file}: ${scripts.length} inline script${scripts.length === 1 ? "" : "s"} parsed`);
}

/* The campaign crosses missions with a reload, so syntax alone cannot catch a
   regression that forgets the earned loadout. Execute the self-contained
   player/WPN/loadout block with a tiny sessionStorage stand-in and prove a
   mission-1 arsenal round-trips into a fresh player object. */
const canonical = await readFile("NUKEM.html", "utf8");
const finaleModule = await readFile("nz-finale.js", "utf8");
try { Function(finaleModule); }
catch (error) { throw new Error(`nz-finale.js failed to parse: ${error.message}`); }
for (const [needle, description] of [
  ['level=(1|2|3|4)', 'router accepts mission 4'],
  ["Math.min(MISSIONS.length, LEVEL + 1)", 'NEXT MISSION advances along the MISSIONS table'],
  ["LEVEL === MISSIONS.length ? 'none'", 'the last mission closes the campaign'],
  ['<script src="nz-finale.js"></script>', 'finale presentation module is wired'],
  ['function buildStreetMap()', 'mission 4 map builder is present'],
  ['<script src="nz-street-side.js"></script>', 'mission 4 side-street module is wired'],
  ['buildMissionPicker()', 'the title screen can reach every mission']
]) {
  if (!canonical.includes(needle)) throw new Error(`NUKEM.html: ${description} contract is missing`);
}
console.log("NUKEM.html: four-mission campaign routing, finale and cordon modules parsed");
const loadoutStart = canonical.indexOf("const AMMOMAX =");
const loadoutEnd = canonical.indexOf("/* ---------------------------------------------------------------- optic --", loadoutStart);
if (loadoutStart < 0 || loadoutEnd < 0) throw new Error("NUKEM.html: campaign loadout block not found");

const storage = new Map();
const durableStorage = new Map();
const uiNodes = new Map();
const uiNode = id => {
  if (!uiNodes.has(id)) uiNodes.set(id, {
    id, style: {}, textContent: "", className: "", disabled: false,
    setAttribute(name, value) { this[name] = String(value); }
  });
  return uiNodes.get(id);
};
const context = vm.createContext({
  EYE: 5.985,
  clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
  console,
  document: { getElementById: uiNode },
  localStorage: {
    getItem: key => durableStorage.has(key) ? durableStorage.get(key) : null,
    setItem: (key, value) => durableStorage.set(key, String(value)),
    removeItem: key => durableStorage.delete(key)
  },
  sessionStorage: {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  }
});
vm.runInContext(canonical.slice(loadoutStart, loadoutEnd) + `
  player.has = WPN.map(() => true);
  Object.assign(player.ammo, { clip: 37, shell: 19, chain: 88, rocket: 7,
    rifle: 73, grenade: 4, ak: 51, dmr: 9, nullcore: 5 });
  player.weapon = WPN.length - 1;
  player.suppressed = true;
  const savedOK = saveCampaignLoadout();
  player.has.fill(false);
  Object.keys(player.ammo).forEach(k => player.ammo[k] = 0);
  player.weapon = 0;
  player.suppressed = false;
  const restoredOK = restoreCampaignLoadout();
  globalThis.__loadoutResult = {
    savedOK, restoredOK,
    has: player.has.slice(), ammo: { ...player.ammo },
    weapon: player.weapon, suppressed: player.suppressed
  };
`, context);

const result = context.__loadoutResult;
const expectedAmmo = { clip: 37, shell: 19, chain: 88, rocket: 7, rifle: 73, grenade: 4, ak: 51, dmr: 9, nullcore: 5 };
if (!result.savedOK || !result.restoredOK || !result.has.every(Boolean) ||
    result.weapon !== 9 || !result.suppressed ||
    Object.keys(expectedAmmo).some(k => result.ammo[k] !== expectedAmmo[k])) {
  throw new Error(`NUKEM.html: campaign loadout did not round-trip: ${JSON.stringify(result)}`);
}
console.log("NUKEM.html: mission loadout persisted across a simulated reload");

/* Exercise the durable slot separately from the campaign hand-off. The game
   globals below are the smallest fresh-world stand-in needed to prove that a
   manual save survives storage, resets transient state, and restores the
   requested player progress after entity placement would have overwritten it. */
context.window = context;
context.NZ = { call() {}, destruct: null };
Object.assign(context, {
  LEVEL: 3, SKILL_I: 2, SKILLS: [{}, {}, {}, {}],
  seen: new Uint8Array(16), state: { paused: true, ended: false, graceT: 1.75 },
  DOORS: [], LIFTS: [], enemies: [], pickups: [], PICKDEF: {},
  PRAD: 1.15, EYE_CRAWL: 1.925, totalKills: 50,
  canStand: () => true, makePickup() {}, setSprite() {}, presentEnemyDeath() {}, SLOT_DEAD: 0,
  keysDown: { KeyW: true }, mouseDown: true, fireQueued: true, adsDown: true, altQueued: true,
  showMap: true, weaponEvents: [{ t: 1 }], vmSmoke: [{}], vmCases: [{}],
  camera: { position: { set() {} }, rotation: { set() {}, order: "YXZ" } }, skyMesh: null,
  drawInvIcon() {}, updateHUD() {}, hudT: 1
});

vm.runInContext(`
  player.x = 321.25; player.y = 8.5; player.z = 177.75;
  player.yaw = 1.125; player.pitch = -.33; player.vy = -3.5; player.onGround = false;
  player.hp = 73; player.armor = 41; player.medpack = 62; player.crawling = true;
  player.has = WPN.map((_, i) => i === 0 || i === 4 || i === 8);
  Object.assign(player.ammo, { clip: 31, shell: 7, chain: 22, rocket: 3,
    rifle: 91, grenade: 4, ak: 13, dmr: 8, nullcore: 2 });
  player.weapon = 8; player.keys.red = true; player.suppressed = true;
  player.kills = 12; player.secrets = 3; player.time = 754.5;
  seen[2] = seen[11] = 1;

  const manualSavedOK = saveManualGame();
  const rawManual = JSON.parse(localStorage.getItem(MANUAL_SAVE_KEY));

  player.x = player.y = player.z = 0; player.hp = 100; player.armor = player.medpack = 0;
  player.has = WPN.map((_, i) => i === 0); Object.keys(player.ammo).forEach(k => player.ammo[k] = 0);
  player.weapon = 0; player.keys.red = false; player.suppressed = false;
  player.kills = player.secrets = player.time = 0; player.crawling = false; seen.fill(0);

  const manualRead = readManualSave();
  const manualRestoredOK = restoreManualGame(manualRead);
  const malformedWorld = JSON.parse(JSON.stringify(manualRead));
  malformedWorld.world.pickups = [{ kind: 'constructor', x: 0, y: 0, z: 0 }];
  const malformedWorldIgnored = restoreManualGame(malformedWorld) === true && lastRestoreWasCompatible;
  globalThis.__manualResult = {
    manualSavedOK, manualRestoredOK, rawManual,
    x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch,
    hp: player.hp, armor: player.armor, medpack: player.medpack, crawling: player.crawling,
    has: player.has.slice(), ammo: { ...player.ammo }, weapon: player.weapon,
    red: player.keys.red, suppressed: player.suppressed, kills: player.kills,
    secrets: player.secrets, time: player.time, seen: Array.from(seen),
    malformedWorldIgnored,
    transient: { keys: Object.keys(keysDown).length, mouseDown, fireQueued, adsDown, altQueued,
      showMap, weaponEvents: weaponEvents.length, vmSmoke: vmSmoke.length, vmCases: vmCases.length }
  };
  localStorage.setItem(MANUAL_SAVE_KEY, '{broken json');
  globalThis.__corruptRejected = readManualSave() === null && localStorage.getItem(MANUAL_SAVE_KEY) === null;
`, context);

const manual = context.__manualResult;
if (!manual.manualSavedOK || !manual.manualRestoredOK || manual.rawManual.v !== 1 ||
    manual.rawManual.level !== 3 || manual.rawManual.skill !== 2 ||
    manual.x !== 321.25 || manual.y !== 8.5 || manual.z !== 177.75 || manual.yaw !== 1.125 || manual.pitch !== -.33 ||
    manual.hp !== 73 || manual.armor !== 41 || manual.medpack !== 62 || !manual.crawling ||
    manual.weapon !== 8 || !manual.red || !manual.suppressed || manual.kills !== 12 || manual.secrets !== 3 || manual.time !== 754.5 ||
    !manual.has[0] || !manual.has[4] || !manual.has[8] || manual.has.filter(Boolean).length !== 3 ||
    manual.ammo.rifle !== 91 || manual.ammo.dmr !== 8 || manual.seen[2] !== 1 || manual.seen[11] !== 1 ||
    !manual.malformedWorldIgnored || Object.values(manual.transient).some(value => value !== 0 && value !== false) || !context.__corruptRejected) {
  throw new Error(`NUKEM.html: durable save did not round-trip safely: ${JSON.stringify(manual)}`);
}
console.log("NUKEM.html: durable save restored player progress and ignored incompatible world data");
