import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

export const LEVEL_START = "const MW =";
export const LEVEL_END = "/* ================================================== world geometry";
const CLIMB = 1.15;

/* The level slice pins this token immediately after
   `const MW = 64, MH = 48, CELL = 4;`. The LEVEL 2 PASS promotes the slice
   by replacing it, character for character, with `let LEVEL = 2;` and
   re-running the whole slice in a fresh vm. */
export const LEVEL_TOKEN = "let LEVEL = 1;";
export const LEVEL2_TOKEN = "let LEVEL = 2;";
export const LEVEL3_TOKEN = "let LEVEL = 3;";
export const LEVEL4_TOKEN = "let LEVEL = 4;";

export function extractLevel(path) {
  const html = readFileSync(path, "utf8");
  const start = html.indexOf(LEVEL_START);
  const end = html.indexOf(LEVEL_END, start);
  if (start < 0 || end < 0) throw new Error(`${path}: level markers are missing`);
  return html.slice(start, end);
}

/* Run the slice in a bare vm (console only).  Top-level let/const in the
   slice do NOT land on the context object, so the serializer snippet is
   concatenated into the SAME script: it shares the slice's lexical scope and
   copies everything the checks need onto globalThis.level. */
export function runSlice(source, filename) {
  const context = vm.createContext({ console });
  vm.runInContext(
    source + `
    buildMap();
    globalThis.level = {
      MW, MH, CELL, grid: Array.from(grid), regionOf: Array.from(regionOf), REG,
      LIFTS, DOORS, SPAWNS, CRATES,
      S_SOLID, S_DOOR, S_KEY, S_SECRET, S_EXIT, S_BLOCK
    };
  `,
    context,
    { filename },
  );
  return context.level;
}

/* Cell/graph helpers over a serialized level snapshot.  The bodies are the
   level-1 checker's originals, only parameterized on `level` so the LEVEL 2
   PASS can reuse them.  buildGraph keeps the level-1 movement rule (climb at
   most CLIMB, drop any distance - directed); buildArenaGraph is the level-2
   rule (|floor delta| <= CLIMB in both directions; a lift cell has a node at
   BOTH storeys joined by a free vertical edge). */
function makeInspector(level) {
  const index = (x, y) => y * level.MW + x;
  const cellType = (x, y) => level.grid[index(x, y)];
  const nodeKey = (x, y, height) => `${x},${y},${Number(height).toFixed(3)}`;

  const liftByCell = new Map();
  for (const lift of level.LIFTS) {
    for (let y = lift.y0; y <= lift.y1; y++) {
      for (let x = lift.x0; x <= lift.x1; x++) liftByCell.set(`${x},${y}`, lift);
    }
  }

  function passable(x, y, blockKeyDoor = false) {
    if (x < 0 || y < 0 || x >= level.MW || y >= level.MH) return false;
    const type = cellType(x, y);
    if (type === level.S_SOLID || type === level.S_EXIT || type === level.S_BLOCK) return false;
    return !(blockKeyDoor && type === level.S_KEY);
  }

  function cellHeights(x, y, blockKeyDoor = false) {
    if (!passable(x, y, blockKeyDoor)) return [];
    const lift = liftByCell.get(`${x},${y}`);
    if (lift) return [...new Set([lift.lo, lift.hi])];
    return [level.REG[level.regionOf[index(x, y)]].f];
  }

  function buildGraph(blockKeyDoor = false) {
    const nodes = new Map();
    for (let y = 0; y < level.MH; y++) {
      for (let x = 0; x < level.MW; x++) {
        for (const height of cellHeights(x, y, blockKeyDoor)) {
          nodes.set(nodeKey(x, y, height), { x, y, height });
        }
      }
    }

    const edges = new Map([...nodes.keys()].map(key => [key, []]));
    for (const [key, node] of nodes) {
      const lift = liftByCell.get(`${node.x},${node.y}`);
      if (lift) {
        for (const height of cellHeights(node.x, node.y, blockKeyDoor)) {
          if (height !== node.height) edges.get(key).push(nodeKey(node.x, node.y, height));
        }
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const height of cellHeights(node.x + dx, node.y + dy, blockKeyDoor)) {
          if (height <= node.height + CLIMB + 1e-9) {
            edges.get(key).push(nodeKey(node.x + dx, node.y + dy, height));
          }
        }
      }
    }
    return { nodes, edges };
  }

  function buildArenaGraph(blockKeyDoor = false) {
    const nodes = new Map();
    for (let y = 0; y < level.MH; y++) {
      for (let x = 0; x < level.MW; x++) {
        for (const height of cellHeights(x, y, blockKeyDoor)) {
          nodes.set(nodeKey(x, y, height), { x, y, height });
        }
      }
    }

    const edges = new Map([...nodes.keys()].map(key => [key, []]));
    for (const [key, node] of nodes) {
      const lift = liftByCell.get(`${node.x},${node.y}`);
      if (lift) {
        for (const height of cellHeights(node.x, node.y, blockKeyDoor)) {
          if (height !== node.height) edges.get(key).push(nodeKey(node.x, node.y, height));
        }
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const height of cellHeights(node.x + dx, node.y + dy, blockKeyDoor)) {
          if (Math.abs(height - node.height) <= CLIMB + 1e-9) {
            edges.get(key).push(nodeKey(node.x + dx, node.y + dy, height));
          }
        }
      }
    }
    return { nodes, edges };
  }

  function visit(graph, seed, reverse = false) {
    const adjacency = reverse
      ? new Map([...graph.nodes.keys()].map(key => [key, []]))
      : graph.edges;
    if (reverse) {
      for (const [from, destinations] of graph.edges) {
        for (const to of destinations) adjacency.get(to).push(from);
      }
    }
    const seen = new Set([seed]);
    const queue = [seed];
    for (let i = 0; i < queue.length; i++) {
      for (const next of adjacency.get(queue[i]) || []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    return seen;
  }

  return { index, cellType, nodeKey, liftByCell, passable, cellHeights, buildGraph, buildArenaGraph, visit };
}

/* ============================================================ LEVEL 1 PASS
   Byte-compatible with the original checker: same assertions, same messages,
   same success line, run against the slice exactly as it ships. */
export function runLevel1Pass(level) {
  const { index, nodeKey, passable, cellHeights, buildGraph, visit } = makeInspector(level);
  const failures = [];
  const assert = (condition, message) => { if (!condition) failures.push(message); };

  const players = level.SPAWNS.filter(spawn => spawn.kind === "player");
  const keys = level.SPAWNS.filter(spawn => spawn.kind === "keyred");
  assert(players.length === 1, `Expected one player spawn, found ${players.length}`);
  assert(keys.length === 1, `Expected one red keycard, found ${keys.length}`);

  for (const spawn of level.SPAWNS) {
    assert(passable(spawn.x, spawn.y), `${spawn.kind} is placed in a blocked cell at ${spawn.x},${spawn.y}`);
  }

  for (const door of level.DOORS.filter(door => !door.secret)) {
    const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .filter(([dx, dy]) => passable(door.cx + dx, door.cy + dy));
    const opposite = neighbors.length === 2 &&
      neighbors[0][0] + neighbors[1][0] === 0 && neighbors[0][1] + neighbors[1][1] === 0;
    assert(opposite, `Door at ${door.cx},${door.cy} is bypassable or has ambiguous orientation`);

    const region = level.REG[level.regionOf[index(door.cx, door.cy)]];
    const openingHeight = Math.min(region.c, region.f + 8.2) - region.f;
    assert(openingHeight >= 7.5, `Door at ${door.cx},${door.cy} has only ${openingHeight} units of headroom`);
  }

  for (let y = 0; y < level.MH; y++) {
    for (let x = 0; x < level.MW; x++) {
      if (!passable(x, y)) continue;
      const region = level.REG[level.regionOf[index(x, y)]];
      assert(region, `Open cell ${x},${y} has no region`);
      if (!region) continue;
      for (const height of cellHeights(x, y)) {
        assert(region.c - height >= 7.5, `Low headroom at ${x},${y}: ${region.c - height}`);
      }

      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        if (!passable(x + dx, y + dy)) continue;
        const neighbor = level.REG[level.regionOf[index(x + dx, y + dy)]];
        const floorDelta = Math.abs(region.f - neighbor.f);
        const aperture = Math.min(region.c, neighbor.c) - Math.max(region.f, neighbor.f);
        assert(
          floorDelta <= CLIMB || aperture <= 0 || aperture >= 7.5,
          `Cramped one-way drop between ${x},${y} and ${x + dx},${y + dy}: ${aperture} units`,
        );
      }
    }
  }

  if (players.length === 1) {
    const player = players[0];
    const startHeight = cellHeights(player.x, player.y)[0];
    const seed = nodeKey(player.x, player.y, startHeight);
    const graph = buildGraph();
    const reachable = visit(graph, seed);
    const returnable = visit(graph, seed, true);
    assert(reachable.size === graph.nodes.size, `${graph.nodes.size - reachable.size} traversal nodes cannot be reached`);
    assert(returnable.size === graph.nodes.size, `${graph.nodes.size - returnable.size} traversal nodes cannot return to the main level`);

    const landmarks = [
      ["upper key room", 59, 14, 5],
      ["mezzanine bridge", 43, 13, 5],
      ["rooftop", 55, 30, 12],
      ["pump station", 36, 46, -9],
      ["service tunnels", 18, 43, -9],
      ["warehouse pit", 4, 7, -3.3],
      ["exit approach", 47, 4, 0],
    ];
    for (const [name, x, y, height] of landmarks) {
      const landmark = nodeKey(x, y, height);
      assert(graph.nodes.has(landmark), `${name} landmark is not on a traversable floor`);
      assert(reachable.has(landmark), `${name} cannot be reached`);
      assert(returnable.has(landmark), `${name} has no return route`);
    }

    if (keys.length === 1) {
      const graphBeforeKey = buildGraph(true);
      const reachableBeforeKey = visit(graphBeforeKey, seed);
      const keySpawn = keys[0];
      const keyNodes = cellHeights(keySpawn.x, keySpawn.y, true)
        .map(height => nodeKey(keySpawn.x, keySpawn.y, height));
      assert(keyNodes.some(key => reachableBeforeKey.has(key)), "Red keycard requires passing its own locked door");
    }

    const elevations = [...new Set([...graph.nodes.values()].map(node => node.height))].sort((a, b) => a - b);
    if (!failures.length) {
      console.log(
        `Level OK: ${graph.nodes.size} traversable nodes, ${level.DOORS.length} doors, ` +
        `${level.LIFTS.length} lifts, ${level.SPAWNS.length} spawns, elevations ${elevations.join(", ")}`,
      );
    }
  }

  return failures;
}

/* ============================================================ LEVEL 2 PASS
   Re-runs the same slice with `let LEVEL = 1;` promoted to `let LEVEL = 2;`
   and asserts the architecture contract for The Crucible. Runs after (and in
   addition to) the level-1 pass; both must pass. */
export function runLevel2Pass(levelSource, filename = "public/game/NUKEM.html#level2") {
  const failures = [];
  const assert = (condition, message) => { if (!condition) failures.push(message); };

  const tokenCount = levelSource.split(LEVEL_TOKEN).length - 1;
  if (tokenCount === 0) {
    failures.push(
      `level 2: waiting on W1 -- the slice does not contain the exact token \`${LEVEL_TOKEN}\`. ` +
      `The LEVEL 2 PASS promotes the slice by string-replacing the exact text \`let LEVEL = 1;\` ` +
      `with \`let LEVEL = 2;\` (verbatim: single spaces, trailing semicolon), so that ` +
      `declaration must appear in the slice immediately after \`const MW = 64, MH = 48, CELL = 4;\`.`,
    );
    return { failures, level: null };
  }
  if (tokenCount > 1) {
    failures.push(
      `level 2: found ${tokenCount} occurrences of \`${LEVEL_TOKEN}\` in the slice; ` +
      `need exactly one so the promotion to \`${LEVEL2_TOKEN}\` is unambiguous.`,
    );
    return { failures, level: null };
  }

  let level = null;
  try {
    level = runSlice(levelSource.replace(LEVEL_TOKEN, LEVEL2_TOKEN), filename);
  } catch (error) {
    failures.push(`level 2: promoted slice failed to build: ${(error && error.stack) || error}`);
    return { failures, level: null };
  }

  try {
    const { index, cellType, nodeKey, passable, cellHeights, buildArenaGraph, visit } = makeInspector(level);

    const players = level.SPAWNS.filter(spawn => spawn.kind === "player");
    const keys = level.SPAWNS.filter(spawn => spawn.kind === "keyred");
    assert(players.length === 1, `level 2: expected exactly one player spawn, found ${players.length}`);
    assert(keys.length === 1, `level 2: expected exactly one keyred pickup, found ${keys.length}`);

    for (const spawn of level.SPAWNS) {
      assert(passable(spawn.x, spawn.y), `level 2: ${spawn.kind} is placed in a blocked cell at ${spawn.x},${spawn.y}`);
    }

    /* Doors are encounter partitions, not decorative wall panels. Enforce a
       single unambiguous axis and a climbable floor on both sides so a gate
       cannot silently strand a route after a stair or bulkhead moves. */
    for (const door of level.DOORS.filter(door => !door.secret)) {
      const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .filter(([dx, dy]) => passable(door.cx + dx, door.cy + dy));
      const opposite = neighbors.length === 2 &&
        neighbors[0][0] + neighbors[1][0] === 0 && neighbors[0][1] + neighbors[1][1] === 0;
      assert(opposite, `level 2: door at ${door.cx},${door.cy} is dead, bypassable, or ambiguously oriented`);
      if (opposite) {
        const doorFloor = level.REG[level.regionOf[index(door.cx, door.cy)]].f;
        for (const [dx, dy] of neighbors) {
          const climbable = cellHeights(door.cx + dx, door.cy + dy)
            .some(height => Math.abs(height - doorFloor) <= CLIMB + 1e-9);
          assert(climbable,
            `level 2: door at ${door.cx},${door.cy} meets an unwalkable floor on its ${dx},${dy} side`);
        }
      }
    }

    /* grid census: secrets, exits, carve bounds, storey band sizes */
    const secretCells = [];
    const exitCells = [];
    const outOfBounds = [];
    const regionless = [];
    const bandCounts = new Map([[0, 0], [8, 0], [16, 0], [24, 0]]);
    for (let y = 0; y < level.MH; y++) {
      for (let x = 0; x < level.MW; x++) {
        const type = cellType(x, y);
        if (type === level.S_SOLID) continue;
        if (type === level.S_SECRET) secretCells.push([x, y]);
        if (type === level.S_EXIT) exitCells.push([x, y]);
        if (x < 4 || x > 56 || y < 2 || y > 46) outOfBounds.push(`${x},${y}`);
        const region = level.REG[level.regionOf[index(x, y)]];
        if (!region) regionless.push(`${x},${y}`);
        else if (bandCounts.has(region.f)) bandCounts.set(region.f, bandCounts.get(region.f) + 1);
      }
    }

    assert(secretCells.length === 8,
      `level 2: expected exactly 8 S_SECRET pushwalls (the secret tally is hardcoded /8), found ${secretCells.length}` +
      (secretCells.length ? ` at ${secretCells.map(cell => cell.join(",")).join("  ")}` : ""));
    assert(exitCells.length >= 1, `level 2: expected at least one S_EXIT cell, found none`);
    assert(outOfBounds.length === 0,
      `level 2: ${outOfBounds.length} non-solid cell(s) outside the allowed carve window x 4..56, y 2..46: ` +
      `${outOfBounds.slice(0, 8).join("  ")}${outOfBounds.length > 8 ? " ..." : ""}`);
    assert(regionless.length === 0,
      `level 2: ${regionless.length} carved cell(s) have no region: ` +
      `${regionless.slice(0, 8).join("  ")}${regionless.length > 8 ? " ..." : ""}`);
    for (const [floor, count] of bandCounts) {
      assert(count >= 80, `level 2: storey at floor ${floor} has only ${count} carved cells (need >= 80; combat tier mis-carved?)`);
    }

    const lowTunnelCells = [];
    for (let y = 0; y < level.MH; y++) for (let x = 0; x < level.MW; x++) {
      if (!passable(x, y)) continue;
      const region = level.REG[level.regionOf[index(x, y)]];
      if (region && region.f === 0 && region.c - region.f <= 9) lowTunnelCells.push([x, y]);
    }
    assert(lowTunnelCells.length >= 80,
      `level 2: only ${lowTunnelCells.length} low service-tunnel cells remain (need >= 80)`);

    const nonSecretDoors = level.DOORS.filter(door => !door.secret);
    assert(nonSecretDoors.length >= 4,
      `level 2: expected at least 4 encounter gates, found ${nonSecretDoors.length}`);

    /* Main regression for the redesign: even with ordinary doors treated as
       transparent (their eventual open state), the arrival position must not
       expose a single hostile. This is deliberately stricter than testing the
       opening screenshot with its airlock closed. */
    const enemyKinds = new Set(["trooper", "pig", "enforcer", "octa", "spider"]);
    const blocksSight = (x, y) => {
      const type = (x < 0 || y < 0 || x >= level.MW || y >= level.MH) ? level.S_SOLID : cellType(x, y);
      return type === level.S_SOLID || type === level.S_SECRET || type === level.S_EXIT;
    };
    const gridLos = (a, b) => {
      const x0 = (a.x + .5) * level.CELL, y0 = (a.y + .5) * level.CELL;
      const x1 = (b.x + .5) * level.CELL, y1 = (b.y + .5) * level.CELL;
      const dx = x1 - x0, dy = y1 - y0;
      const steps = Math.max(2, Math.ceil(Math.hypot(dx, dy) / 1.6));
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        if (blocksSight(Math.floor((x0 + dx * t) / level.CELL), Math.floor((y0 + dy * t) / level.CELL))) return false;
      }
      return true;
    };
    if (players.length === 1) {
      const exposed = level.SPAWNS.filter(spawn => enemyKinds.has(spawn.kind) && gridLos(players[0], spawn));
      assert(exposed.length === 0,
        `level 2: player spawn has direct grid LOS to ${exposed.length} hostile(s): ` +
        exposed.map(spawn => `${spawn.kind}@${spawn.x},${spawn.y}`).join(" "));
    }

    /* The lower crosswalk must remain a route, not a one-ended balcony. Its
       east switchback descends one unit per column and joins the f0 trench. */
    for (let x = 36; x <= 43; x++) {
      const expected = 43 - x;
      const stepHeights = [23, 24]
        .filter(y => passable(x, y))
        .flatMap(y => cellHeights(x, y));
      assert(stepHeights.some(height => Math.abs(height - expected) < 1e-9),
        `level 2: bridge descent column ${x} is missing its floor-${expected} step`);
    }

    const expressLifts = level.LIFTS.filter(lift => Math.abs(lift.hi - lift.lo) >= 16);
    assert(expressLifts.length >= 1,
      `level 2: no lift with |hi - lo| >= 16 (need the service-to-upper shortcut); lifts: ` +
      (level.LIFTS.map(l => `[${l.x0},${l.y0}..${l.x1},${l.y1} lo=${l.lo} hi=${l.hi}]`).join(" ") || "none"));

    /* traversal: |floor delta| <= CLIMB, S_DOOR passable, S_KEY only after the
       key, lift cells present at both storeys. */
    if (players.length === 1 && regionless.length === 0) {
      const player = players[0];
      const cellReachable = (reached, x, y, blockKeyDoor) =>
        cellHeights(x, y, blockKeyDoor).some(height => reached.has(nodeKey(x, y, height)));
      const adjacentReachable = (reached, x, y, blockKeyDoor) =>
        [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => cellReachable(reached, x + dx, y + dy, blockKeyDoor));

      const startHeights = cellHeights(player.x, player.y, true);
      if (!startHeights.length) {
        assert(false, `level 2: player spawn cell ${player.x},${player.y} is not passable`);
      } else {
        const seed = nodeKey(player.x, player.y, startHeights[0]);

        /* phase 1 -- before the red key: locked S_KEY doors block */
        const beforeKey = buildArenaGraph(true);
        const reachedBeforeKey = beforeKey.nodes.has(seed) ? visit(beforeKey, seed) : new Set();
        if (keys.length === 1) {
          assert(cellReachable(reachedBeforeKey, keys[0].x, keys[0].y, true),
            `level 2: keyred at ${keys[0].x},${keys[0].y} cannot be reached before its own locked door opens ` +
            `(climb <= ${CLIMB}, S_KEY blocked)`);
        }

        /* phase 2 -- key collected: S_KEY doors open */
        const withKey = buildArenaGraph(false);
        const reached = withKey.nodes.has(seed) ? visit(withKey, seed) : new Set();

        if (exitCells.length) {
          assert(exitCells.some(([x, y]) => adjacentReachable(reached, x, y, false)),
            `level 2: no cell adjacent to an S_EXIT switch is reachable ` +
            `(exit cells: ${exitCells.map(cell => cell.join(",")).join("  ")})`);
        }

        for (const spawn of level.SPAWNS) {
          assert(cellReachable(reached, spawn.x, spawn.y, false),
            `level 2: ${spawn.kind} at ${spawn.x},${spawn.y} is unreachable from the player spawn (climb <= ${CLIMB})`);
        }

        for (const [x, y] of secretCells) {
          assert(adjacentReachable(reached, x, y, false),
            `level 2: secret pushwall at ${x},${y} has no reachable adjacent cell`);
        }

        for (const lift of expressLifts) {
          let atLo = false, atHi = false;
          for (let y = lift.y0; y <= lift.y1; y++) {
            for (let x = lift.x0; x <= lift.x1; x++) {
              if (reached.has(nodeKey(x, y, lift.lo))) atLo = true;
              if (reached.has(nodeKey(x, y, lift.hi))) atHi = true;
            }
          }
          assert(atLo && atHi,
            `level 2: lift [${lift.x0},${lift.y0}..${lift.x1},${lift.y1}] must link both storeys; ` +
            `reachable at lo=${lift.lo}: ${atLo}, at hi=${lift.hi}: ${atHi}`);
        }

        if (!failures.length) {
          console.log(
            `Level 2 OK: ${withKey.nodes.size} traversable nodes, ${level.DOORS.length} doors, ` +
            `${level.LIFTS.length} lifts, ${level.SPAWNS.length} spawns, ${secretCells.length} secrets, ` +
            `storey cells ${[...bandCounts].map(([floor, count]) => `f${floor}:${count}`).join(" ")}`,
          );
        }
      }
    }
  } catch (error) {
    failures.push(`level 2: validator crashed while checking the arena: ${(error && error.stack) || error}`);
  }

  return { failures, level };
}

/* ============================================================ LEVEL 3 PASS
   BLACKSTAR uses the same bidirectional stair/lift movement contract as the
   Crucible, but its authored invariants are campaign-finale specific: three
   readable storeys, one optional f0->f8 core lift, eight secrets, a protected
   breach, and a key that is reachable before the shutdown-vault door. */
export function runLevel3Pass(levelSource, filename = "public/game/NUKEM.html#level3") {
  const failures = [];
  const assert = (condition, message) => { if (!condition) failures.push(message); };
  let level = null;

  try {
    level = runSlice(levelSource.replace(LEVEL_TOKEN, LEVEL3_TOKEN), filename);
    const { index, cellType, nodeKey, passable, cellHeights, buildArenaGraph, visit } = makeInspector(level);
    const players = level.SPAWNS.filter(spawn => spawn.kind === "player");
    const keys = level.SPAWNS.filter(spawn => spawn.kind === "keyred");
    const enemyKinds = new Set(["trooper", "pig", "enforcer", "octa", "spider"]);
    const secrets = [], exits = [], bands = new Map([[0, 0], [8, 0], [16, 0]]);

    assert(players.length === 1, `level 3: expected one player spawn, found ${players.length}`);
    assert(keys.length === 1, `level 3: expected one red keycard, found ${keys.length}`);
    for (const spawn of level.SPAWNS)
      assert(passable(spawn.x, spawn.y), `level 3: ${spawn.kind} is placed in a blocked cell at ${spawn.x},${spawn.y}`);

    for (let y = 0; y < level.MH; y++) for (let x = 0; x < level.MW; x++) {
      const type = cellType(x, y);
      if (type === level.S_SOLID) continue;
      if (type === level.S_SECRET) secrets.push([x, y]);
      if (type === level.S_EXIT) exits.push([x, y]);
      const region = level.REG[level.regionOf[index(x, y)]];
      assert(!!region, `level 3: open cell ${x},${y} has no region`);
      if (region && bands.has(region.f)) bands.set(region.f, bands.get(region.f) + 1);
      if (region && passable(x, y)) for (const h of cellHeights(x, y))
        assert(region.c - h >= 7.5, `level 3: low headroom at ${x},${y}: ${region.c - h}`);
    }

    assert(secrets.length === 8, `level 3: expected 8 secrets, found ${secrets.length}`);
    assert(exits.length === 1, `level 3: expected one exit switch, found ${exits.length}`);
    for (const [floor, count] of bands)
      assert(count >= 100, `level 3: floor ${floor} has only ${count} cells; combat tier appears truncated`);

    for (const door of level.DOORS.filter(door => !door.secret)) {
      const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .filter(([dx, dy]) => passable(door.cx + dx, door.cy + dy));
      const opposite = neighbors.length === 2 &&
        neighbors[0][0] + neighbors[1][0] === 0 && neighbors[0][1] + neighbors[1][1] === 0;
      assert(opposite, `level 3: door at ${door.cx},${door.cy} is bypassable or ambiguously oriented`);
    }

    if (players.length === 1) {
      const p = players[0];
      const seed = nodeKey(p.x, p.y, cellHeights(p.x, p.y, true)[0]);
      const before = buildArenaGraph(true);
      const reachedBefore = before.nodes.has(seed) ? visit(before, seed) : new Set();
      const after = buildArenaGraph(false);
      const reached = after.nodes.has(seed) ? visit(after, seed) : new Set();
      const cellReached = (set, x, y, blocked) => cellHeights(x, y, blocked)
        .some(h => set.has(nodeKey(x, y, h)));
      const adjacentReached = (set, x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .some(([dx, dy]) => cellReached(set, x + dx, y + dy, false));

      if (keys.length === 1)
        assert(cellReached(reachedBefore, keys[0].x, keys[0].y, true),
          `level 3: keyred at ${keys[0].x},${keys[0].y} requires passing its own lock`);
      assert(exits.some(([x, y]) => adjacentReached(reached, x, y)),
        "level 3: shutdown switch is unreachable after collecting the key");
      for (const spawn of level.SPAWNS)
        assert(cellReached(reached, spawn.x, spawn.y, false),
          `level 3: ${spawn.kind} at ${spawn.x},${spawn.y} is unreachable`);
      for (const [x, y] of secrets)
        assert(adjacentReached(reached, x, y), `level 3: secret at ${x},${y} has no reachable face`);

      /* Doors are considered transparent here: the dog-leg itself must hide
         the opening roster, so a future door timing change cannot create an
         unavoidable first-frame firing squad. */
      const blocksSight = (x, y) => {
        if (x < 0 || y < 0 || x >= level.MW || y >= level.MH) return true;
        const t = cellType(x, y);
        return t === level.S_SOLID || t === level.S_SECRET || t === level.S_EXIT;
      };
      const gridLos = target => {
        const x0 = (p.x + .5) * level.CELL, y0 = (p.y + .5) * level.CELL;
        const x1 = (target.x + .5) * level.CELL, y1 = (target.y + .5) * level.CELL;
        const dx = x1 - x0, dy = y1 - y0;
        const steps = Math.max(2, Math.ceil(Math.hypot(dx, dy) / 1.6));
        for (let i = 1; i < steps; i++) {
          const t = i / steps;
          if (blocksSight(Math.floor((x0 + dx * t) / level.CELL), Math.floor((y0 + dy * t) / level.CELL))) return false;
        }
        return true;
      };
      const exposed = level.SPAWNS.filter(spawn => enemyKinds.has(spawn.kind) && gridLos(spawn));
      assert(exposed.length === 0, `level 3: breach spawn sees ${exposed.length} hostile(s) through open doors`);
    }

    const coreLift = level.LIFTS.find(lift => lift.lo === 0 && lift.hi === 8);
    assert(!!coreLift, "level 3: the optional reactor lift no longer links f0 to f8");
    const viewRegions = level.REG.filter(region => Array.isArray(region.openEdges));
    assert(viewRegions.length >= 4, "level 3: reactor viewing aperture regions are missing");

    if (!failures.length) console.log(
      `Level 3 OK: ${level.SPAWNS.length} spawns, ${level.DOORS.length} doors, ` +
      `${level.LIFTS.length} lift, ${secrets.length} secrets, ` +
      `storey cells ${[...bands].map(([f, n]) => `f${f}:${n}`).join(" ")}`,
    );
  } catch (error) {
    failures.push(`level 3: validator crashed: ${(error && error.stack) || error}`);
  }
  return { failures, level };
}

/* ASCII minimap for iterating on the arena: one row per grid row, '#' for
   solid rock, otherwise the cell's region floor height as one hex digit on a
   half-unit scale -- digit = round(f / 2), so f=0 -> 0, f=8 -> 4, f=16 -> 8,
   f=24 -> c, and stair steps land in between.  '?' marks a carved cell whose
   region is missing. */
/* ============================================================ LEVEL 4 PASS
   MISSION 4 - THE CORDON. The outdoor street, decoupled from mission 1 and
   extended with the two 232 Sk arms.

   It uses the LEVEL 1 movement rule (buildGraph: climb at most CLIMB, drop
   any distance) rather than the arena rule, because that is what the mission
   is - an open street you can step off a kerb or a balcony into. The two
   lifts are the only way up to the first-floor flats, so both storeys have to
   come back reachable AND returnable, or the red card is in a room with no
   stairs.

   The closure check is the one that matters most. Every street here ends on a
   barricade the player can walk up to and see past: a closure cell that turns
   walkable is a hole in the map, and one with no open street in front of it
   has quietly become the wall this mission is not allowed to use. */
export function runLevel4Pass(levelSource, filename = "public/game/NUKEM.html#level4") {
  const failures = [];
  const assert = (condition, message) => { if (!condition) failures.push(message); };

  if (levelSource.split(LEVEL_TOKEN).length - 1 !== 1) {
    failures.push(`level 4: need exactly one \`${LEVEL_TOKEN}\` in the slice to promote`);
    return { failures, level: null };
  }
  let level = null;
  try {
    level = runSlice(levelSource.replace(LEVEL_TOKEN, LEVEL4_TOKEN), filename);
  } catch (error) {
    failures.push(`level 4: promoted slice failed to build: ${(error && error.stack) || error}`);
    return { failures, level: null };
  }

  try {
    const { index, cellType, nodeKey, passable, cellHeights, buildGraph, visit } = makeInspector(level);

    const players = level.SPAWNS.filter(spawn => spawn.kind === "player");
    const keys = level.SPAWNS.filter(spawn => spawn.kind === "keyred");
    const secrets = level.DOORS.filter(door => door.secret);
    assert(players.length === 1, `level 4: expected one player spawn, found ${players.length}`);
    assert(keys.length === 1, `level 4: expected one keyred pickup, found ${keys.length}`);
    assert(secrets.length === 8, `level 4: the campaign tally is /8; found ${secrets.length} secrets`);

    for (const spawn of level.SPAWNS) {
      assert(passable(spawn.x, spawn.y),
        `level 4: ${spawn.kind} is placed in a blocked cell at ${spawn.x},${spawn.y}`);
    }

    for (const door of level.DOORS.filter(door => !door.secret)) {
      const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .filter(([dx, dy]) => passable(door.cx + dx, door.cy + dy));
      const opposite = neighbors.length === 2 &&
        neighbors[0][0] + neighbors[1][0] === 0 && neighbors[0][1] + neighbors[1][1] === 0;
      assert(opposite, `level 4: door at ${door.cx},${door.cy} is bypassable or has ambiguous orientation`);
      const region = level.REG[level.regionOf[index(door.cx, door.cy)]];
      const openingHeight = Math.min(region.c, region.f + 8.2) - region.f;
      assert(openingHeight >= 7.5,
        `level 4: door at ${door.cx},${door.cy} has only ${openingHeight} units of headroom`);
    }

    for (let y = 0; y < level.MH; y++) {
      for (let x = 0; x < level.MW; x++) {
        if (!passable(x, y)) continue;
        const region = level.REG[level.regionOf[index(x, y)]];
        assert(region, `level 4: open cell ${x},${y} has no region`);
        if (!region) continue;
        for (const height of cellHeights(x, y)) {
          assert(region.c - height >= 7.5, `level 4: low headroom at ${x},${y}: ${region.c - height}`);
        }
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          if (!passable(x + dx, y + dy)) continue;
          const neighbor = level.REG[level.regionOf[index(x + dx, y + dy)]];
          const floorDelta = Math.abs(region.f - neighbor.f);
          const aperture = Math.min(region.c, neighbor.c) - Math.max(region.f, neighbor.f);
          assert(floorDelta <= CLIMB || aperture <= 0 || aperture >= 7.5,
            `level 4: cramped one-way drop between ${x},${y} and ${x + dx},${y + dy}: ${aperture} units`);
        }
      }
    }

    const closures = [
      ["232 Sk north", 140, 0, 140, 1],
      ["232 Sk south", 140, 126, 140, 125],
      ["230 Sk north", 193, 28, 193, 29],
      /* 230 Sk south is the walled garden pocket: the wall on row 49 is the
         closure and 233 Sk on row 48 is the street in front of it */
      ["233 Sk garden wall", 193, 49, 193, 48],
      ["233 Sk east", 208, 40, 207, 40],
      /* the park-crest line the checkpoint now stands on: row 38 is still a
         plain occupied cell either side of the lane on row 40 */
      ["233 Sk park crest", 66, 38, 67, 38]
    ];
    for (const [name, bx, by, ax, ay] of closures) {
      assert(cellType(bx, by) === level.S_BLOCK,
        `level 4: the ${name} closure at ${bx},${by} is not an occupied cell`);
      assert(passable(ax, ay), `level 4: the ${name} closure has no street in front of it`);
    }

    if (players.length === 1) {
      const player = players[0];
      const startHeight = cellHeights(player.x, player.y)[0];
      const seed = nodeKey(player.x, player.y, startHeight);
      const graph = buildGraph();
      const reachable = visit(graph, seed);
      const returnable = visit(graph, seed, true);
      assert(reachable.size === graph.nodes.size,
        `level 4: ${graph.nodes.size - reachable.size} traversal nodes cannot be reached`);
      assert(returnable.size === graph.nodes.size,
        `level 4: ${graph.nodes.size - returnable.size} traversal nodes cannot return to the street`);

      const landmarks = [
        ["Yildiz Tepesi hall", 83, 30, 18.48],
        ["KIZILCALAR loggia", 145, 17, 11.2],
        ["KIZILCALAR flat", 150, 16, 11.2],
        ["DEGERLI loggia", 145, 72, 11.2],
        ["A-BLOK ground floor", 158, 30, 0.5],
        ["B-BLOK west apartment", 148, 58, 0.5],
        ["DOYUM EKMEK bake hall", 130, 18, 0.5],
        ["232 Sk north extension", 140, 1, 0],
        ["232 Sk south barricade", 140, 125, 0],
        /* The checkpoint moved from the east police line to the park crest in
           the uphill pass, so the lane moved with it: cells 62..65 of row 40,
           on the park's own 7 % grade rather than on flat ground.
           parkFloorAtCell(63) = ((137.5 - 63) * 4) * 0.07 = 20.86. */
        ["the checkpoint lane", 63, 40, 20.86]
      ];
      for (const [name, x, y, height] of landmarks) {
        const landmark = nodeKey(x, y, height);
        assert(graph.nodes.has(landmark), `level 4: ${name} is not on a traversable floor`);
        assert(reachable.has(landmark), `level 4: ${name} cannot be reached`);
        assert(returnable.has(landmark), `level 4: ${name} has no return route`);
      }

      if (keys.length === 1) {
        const graphBeforeKey = buildGraph(true);
        const reachableBeforeKey = visit(graphBeforeKey, seed);
        const keyNodes = cellHeights(keys[0].x, keys[0].y, true)
          .map(height => nodeKey(keys[0].x, keys[0].y, height));
        assert(keyNodes.some(key => reachableBeforeKey.has(key)),
          "level 4: the red keycard is behind its own locked checkpoint");
      }

      if (!failures.length) {
        console.log(
          `Level 4 OK: ${graph.nodes.size} traversable nodes, ${level.DOORS.length} doors, ` +
          `${level.LIFTS.length} lifts, ${level.SPAWNS.length} spawns, ${secrets.length} secrets, ` +
          `${closures.length} closures`,
        );
      }
    }
  } catch (error) {
    failures.push(`level 4: checker threw: ${(error && error.stack) || error}`);
  }
  return { failures, level };
}

export function printMinimap(level, log = (line) => console.error(line)) {
  const index = (x, y) => y * level.MW + x;
  log(`level 2 minimap -- '#' solid; digit = round(region floor / 2) in hex (0=f0 4=f8 8=f16 c=f24):`);
  for (let y = 0; y < level.MH; y++) {
    let row = "";
    for (let x = 0; x < level.MW; x++) {
      if (level.grid[index(x, y)] === level.S_SOLID) { row += "#"; continue; }
      const region = level.REG[level.regionOf[index(x, y)]];
      row += region ? Math.max(0, Math.min(15, Math.round(region.f / 2))).toString(16) : "?";
    }
    log(row);
  }
}

function main() {
  const fileArg = process.argv.slice(2).find(arg => arg.startsWith("--file="));
  let levelSource, level1Filename, level2Filename, level3Filename;
  if (fileArg) {
    const override = fileArg.slice("--file=".length);
    levelSource = extractLevel(override);
    level1Filename = `${override}#level`;
    level2Filename = `${override}#level2`;
    level3Filename = `${override}#level3`;
  } else {
    const publicLevel = extractLevel("public/game/NUKEM.html");
    const rootLevel = extractLevel("NUKEM.html");
    if (publicLevel !== rootLevel) throw new Error("Root and deployed level engines are out of sync");
    levelSource = publicLevel;
    level1Filename = "public/game/NUKEM.html#level";
    level2Filename = "public/game/NUKEM.html#level2";
    level3Filename = "public/game/NUKEM.html#level3";
  }

  const level1Failures = runLevel1Pass(runSlice(levelSource, level1Filename));
  const { failures: level2Failures, level: level2 } = runLevel2Pass(levelSource, level2Filename);
  const { failures: level3Failures } = runLevel3Pass(levelSource, level3Filename);
  const { failures: level4Failures } = runLevel4Pass(levelSource, level3Filename.replace("#level3", "#level4"));

  const failures = [...level1Failures, ...level2Failures, ...level3Failures, ...level4Failures];
  if (failures.length) {
    for (const failure of failures) console.error(`- ${failure}`);
    if (level2Failures.length && level2) printMinimap(level2);
    process.exitCode = 1;
  }
}

/* Run when invoked as a script (`node scripts/validate-level.mjs
   [--file=page.html]`); importing the module (test drivers) runs nothing. */
if (process.argv[1] && path.basename(process.argv[1]).toLowerCase() === "validate-level.mjs") main();
