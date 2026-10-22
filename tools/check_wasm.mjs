// First half of the WebAssembly check: samples points from every correction in
// the given files, evaluates them with the WebAssembly build and writes them
// out. check_wasm.py then evaluates the same points with correctionlib's
// Python package and compares.
//
//   node tools/check_wasm.mjs points.json FILE.json[.gz] ...
//
// Per correction, most points are drawn inside the domain the tree covers
// (category keys, the span of the bin edges); some sit exactly on bin edges,
// some outside the edges and some on keys that do not exist, so that the flow
// rules and the errors are compared as well as the values.
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import createCorrectionlib from '../dist/correctionlib.mjs';
import { axisEdges, children, describeCorrection, trace } from '../js/schema.mjs';

const POINTS_PER_CORRECTION = 3000;

// mulberry32: a small seeded generator, so that a failure reproduces.
function generator(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// input name -> every finite bin edge on it, anywhere in the tree.
function edgesByInput(correction) {
  const edges = new Map();
  const stack = [correction.data];
  while (stack.length) {
    const node = stack.pop();
    if (node && node.nodetype === 'binning') {
      for (const e of axisEdges(node.edges)) if (Number.isFinite(e)) push(edges, node.input, e);
    } else if (node && node.nodetype === 'multibinning') {
      node.inputs.forEach((name, i) => {
        for (const e of axisEdges(node.edges[i])) if (Number.isFinite(e)) push(edges, name, e);
      });
    }
    for (const c of children(node)) stack.push(c.node);
  }
  return edges;
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function sampler(input, edges, random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  return () => {
    const u = random();
    if (input.keys.length) {
      if (u < 0.05) return input.type === 'string' ? 'no-such-key' : 987654321;
      return pick(input.keys);
    }
    if (input.type === 'string') return 'x';
    let x;
    if (input.min !== null) {
      const width = input.max - input.min || 1;
      if (u < 0.1 && edges?.length) x = pick(edges);
      else x = input.min - 0.1 * width + random() * 1.2 * width;
    } else {
      x = -2 + 4 * random();
    }
    return input.type === 'int' ? Math.round(x) : x;
  };
}

const [out, ...files] = process.argv.slice(2);
if (!out || !files.length) {
  console.error('usage: node check_wasm.mjs points.json FILE.json[.gz] ...');
  process.exit(2);
}

const lib = await createCorrectionlib();
const points = [];
for (const file of files) {
  const raw = await readFile(file);
  const text = (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString('utf8');
  const evaluator = new lib.Evaluator();
  const error = evaluator.load(text);
  if (error) {
    console.error(`${file}: the WebAssembly build cannot load it: ${error}`);
    process.exit(1);
  }
  const doc = JSON.parse(text);
  const domains = new Map();
  const edges = new Map();
  for (const c of doc.corrections) {
    for (const v of describeCorrection(c).inputs) if (!domains.has(v.name)) domains.set(v.name, v);
    for (const [k, list] of edgesByInput(c)) edges.set(k, [...(edges.get(k) || []), ...list]);
  }
  const targets = [...doc.corrections, ...(doc.compound_corrections || [])];
  targets.forEach((target, t) => {
    const random = generator(1000 + t);
    const draw = target.inputs.map((v) =>
      sampler({ ...(domains.get(v.name) || { keys: [], min: null }), type: v.type }, edges.get(v.name), random),
    );
    for (let k = 0; k < POINTS_PER_CORRECTION; ++k) {
      const inputs = draw.map((f) => f());
      const r = evaluator.evaluate(target.name, inputs);
      // JSON has no NaN or infinities; Python's float() reads these strings back.
      const value = r.error !== undefined ? null : Number.isFinite(r.value) ? r.value : String(r.value);
      // A hashprng 'stdnormal' draw comes from std::normal_distribution, whose
      // algorithm differs between libc++ (this build) and libstdc++ (Linux
      // builds of correctionlib), so its value is not expected to agree.
      const leaf = target.data ? trace(target, inputs).leaf : undefined;
      const portable = !(leaf?.nodetype === 'hashprng' && leaf.distribution === 'stdnormal');
      points.push({ file, correction: target.name, inputs, value, error: r.error ?? null, portable });
    }
  });
  evaluator.delete();
}
await writeFile(out, JSON.stringify({ correctionlib: lib.correctionlibVersion, points }));
console.log(`${points.length} points from ${files.length} file(s), correctionlib ${lib.correctionlibVersion} (WebAssembly)`);
