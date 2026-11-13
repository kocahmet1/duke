// Verify the actual Blender export, facade installer, and selective replacement.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const handlers = [];
const ctx = { console, performance, setTimeout, clearTimeout, Float32Array, Uint32Array,
  location: { search: '' }, MW: 256, MH: 256, CELL: 4,
  cellAt: () => 0, regAt: () => ({ sky: true, c: 52 }), inb: () => true };
ctx.window = ctx;
ctx.NZ = { level: 4, flags: {}, on(event, fn) { if (event === 'ready') handlers.push(fn); }, log() {},
  street: { facades: [], day() {}, bake(geo) {
    const colors = new Float32Array(geo.attributes.position.array.length); colors.fill(.85);
    geo.setAttribute('color', new ctx.THREE.BufferAttribute(colors, 3));
  } } };
vm.createContext(ctx);
for (const file of ['vendor/three.r149.min.js','nz-buildings-asset.js','nz-buildings.js','nz-street.js'])
  vm.runInContext(fs.readFileSync(file,'utf8'),ctx,{filename:file});
const asset=ctx.NZ_BUILDINGS_ASSET;
assert.equal(new Set(asset.meshes.filter(m=>m.building!=='heroes').map(m=>m.building)).size,5);
assert(!asset.replacedRuns.includes('S-E2'), 'buildings opposite the park are preserved');
let triangles=0;
for(const mesh of asset.meshes) {
  assert.equal(mesh.positions.length,mesh.normals.length);
  assert(mesh.positions.every(Number.isFinite));
  assert(mesh.indices.every(i=>Number.isInteger(i)&&i>=0&&i<mesh.positions.length/3));
  for(let i=0;i<mesh.normals.length;i+=3)
    assert(Math.abs(Math.hypot(...mesh.normals.slice(i,i+3))-1)<.001,mesh.name+' unit normals');
  triangles+=mesh.indices.length/3;
}
for(const p of asset.panes) {
  assert(p.width>0&&p.height>0);
  assert(Math.abs(Math.hypot(...p.tangent)-1)<.0001);
  assert(Math.abs(Math.hypot(...p.normal)-1)<.0001);
  assert(Math.abs(p.tangent[0]*p.normal[0]+p.tangent[2]*p.normal[2])<.0001);
  assert(p.center.every(Number.isFinite));
  // Every analytic pane must coincide with the Blender-authored glass corners.
  const a=p.corners[0], b=p.corners[1];
  assert(Math.abs(Math.hypot(b[0]-a[0],b[2]-a[2])-p.width)<.0001);
}
const scene=new ctx.THREE.Scene();
handlers[0]({ THREE:ctx.THREE, scene, renderer:{} });
const facade=ctx.NZ.streetFacade;
assert(facade&&ctx.NZ.flags.street,'real facade ready hook installs successfully');
assert.equal(facade.heroGlass.count,asset.panes.length);
assert.equal(facade.heroGlass.mesh.name,'nzstreet-blender-hero-glass');
assert.equal(facade.facades.length,2);
assert.deepEqual(Array.from(facade.facades,f=>f.entrances.length),[3,3]);
assert.equal(scene.children.length,asset.meshes.length,'no old hero meshes are created');
assert(scene.children.every(m=>m.geometry.boundingSphere.radius>0));

const side=fs.readFileSync('nz-street-side.js','utf8').replace(
  "})(typeof window !== 'undefined' ? window : this);",
  `global.__clipBuildingTest = function () {
    P = { sample: new Pile('test',8,0) };
    function fixture() { box6(P.sample,0,2,0,30,0,2,1,[1,1,1]); }
    blenderLowerOnly(fixture);
    return { pile:P.sample, preserved:!blenderReplacesUpper({id:'S-E2'}), replaced:blenderReplacesUpper({id:'N-E2'}) };
  }; })(typeof window !== 'undefined' ? window : this);`);
vm.runInContext(side,ctx,{filename:'nz-street-side.js'});
const cut=ctx.__clipBuildingTest();
assert(cut.preserved&&cut.replaced);
assert(cut.pile.idx.length>0,'lower facade remains');
assert(cut.pile.idx.every(i=>cut.pile.p[i*3+1]<=3.35*3.5+.000001),'old upper facade is clipped away');
assert(cut.pile.idx.some(i=>Math.abs(cut.pile.p[i*3+1]-3.35*3.5)<.000001),'crossing faces end at the cut');
facade.dispose();
assert.equal(scene.children.length,0,'asset resources removed at level teardown');
console.log(`Buildings OK: 5 Blender assemblies, ${triangles} triangles, ${asset.panes.length} registered panes; 6 entries, selective replacement and teardown verified.`);
