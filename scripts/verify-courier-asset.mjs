// Exercise the real importer with Three.js in Node; no browser is required.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const context = { console, setTimeout, clearTimeout, performance, Float32Array,
  Uint16Array, Uint32Array, Math, location: { search: '' } };
context.window = context;
context.NZ = { on() {}, flags: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync('vendor/three.r149.min.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('nz-courier-asset.js', 'utf8'), context);
const asset = context.NZ_COURIER_ASSET;
assert.equal(asset.meshes.filter(m => m.window).length, 8);
for (const mesh of asset.meshes) {
  assert.equal(mesh.positions.length, mesh.normals.length);
  assert.equal(mesh.indices.length % 3, 0);
  assert(mesh.positions.every(Number.isFinite), `${mesh.name}: finite coordinates`);
  assert(mesh.indices.every(i => Number.isInteger(i) && i >= 0 && i < mesh.positions.length / 3));
  for (let i = 0; i < mesh.normals.length; i += 3)
    assert(Math.abs(Math.hypot(...mesh.normals.slice(i, i + 3)) - 1) < .001, `${mesh.name}: unit normal`);
}
const source = fs.readFileSync('nz-street-props.js', 'utf8').replace(
  "})(typeof window !== 'undefined' ? window : this);",
  `global.__verifyCourier = function () {
    THREE = global.THREE; scene = new THREE.Scene(); RAYS = 8;
    var spec = FLEET.courier;
    buildCar({}, spec, 600, .3, 160, Math.PI, .04, 71);
    MESHES = { windows: [] }; meshBlenderCourier({});
    return { stats: STATS, panes: CAR_WINDOWS, meshes: MESHES, scene: scene, own: OWN };
  }; })(typeof window !== 'undefined' ? window : this);`);
vm.runInContext(source, context);
const result = context.__verifyCourier();
assert.equal(result.stats.cars, 1, 'exactly one replacement car');
assert.equal(result.panes.length, 8, 'all eight panes registered');
assert(result.meshes.body && result.meshes.cabin, 'exterior and cabin published');
assert.equal(new Set(result.panes.map(p => p.id)).size, 8);
const left = result.panes.find(p => p.kind === 'side' && p.side === 'left' && p.pane === 2);
const right = result.panes.find(p => p.kind === 'side' && p.side === 'right' && p.pane === 2);
assert(left && right && left.mesh.material !== right.mesh.material);
for (const pane of result.panes) {
  assert(pane.mesh.geometry.boundingSphere.radius > 0);
  assert.equal(pane.mesh.material.side, context.THREE.DoubleSide);
  assert.equal(pane.mesh.material.depthWrite, false);
  assert(pane.center.every(Number.isFinite));
}
left.mesh.material.opacity = 0;
assert(right.mesh.material.opacity > .7, 'opposite pane stays intact');
for (const mesh of result.scene.children) {
  const bounds = new context.THREE.Box3().setFromObject(mesh);
  assert(bounds.min.x > 583 && bounds.max.x < 603, 'vehicle stays at the original placement');
  assert(bounds.min.y > -.5 && bounds.max.y < 8, 'metres are converted to game units once');
}
assert(result.own.geo.length >= asset.meshes.length, 'all geometry registered for disposal');
console.log(`Courier OK: ${result.stats.cars} car, ${result.stats.tris} triangles, 8 independent panes, cabin and disposal registered.`);
