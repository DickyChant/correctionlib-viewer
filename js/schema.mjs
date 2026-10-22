// Reading a correctionlib (schema v2) document in JavaScript: what each input
// can take, how big the tree is, and which leaf a given set of inputs lands on.
// Evaluation itself is left to the WebAssembly build of correctionlib; this
// module only describes the JSON.

// Bin edges may be written as the strings "inf", "+inf" and "-inf".
export function edgeValue(e) {
  if (typeof e === 'number') return e;
  if (e === 'inf' || e === '+inf') return Infinity;
  if (e === '-inf') return -Infinity;
  return Number(e);
}

// Edges of a binning axis: an explicit list, or {n, low, high} for uniform bins.
export function axisEdges(edges) {
  if (Array.isArray(edges)) return edges.map(edgeValue);
  const { n, low, high } = edges;
  return Array.from({ length: n + 1 }, (_, i) => low + ((high - low) * i) / n);
}

function isNode(x) {
  return x !== null && typeof x === 'object' && typeof x.nodetype === 'string';
}

// The child nodes of a node, each with a label saying how it is reached.
export function children(node) {
  if (!isNode(node)) return [];
  switch (node.nodetype) {
    case 'category': {
      const out = node.content.map((item) => ({ label: `${node.input} = ${item.key}`, node: item.value }));
      if (node.default !== undefined && node.default !== null) {
        out.push({ label: `${node.input}: any other value`, node: node.default });
      }
      return out;
    }
    case 'binning': {
      const e = axisEdges(node.edges);
      const out = node.content.map((c, i) => ({ label: `${node.input} ∈ ${interval(e[i], e[i + 1])}`, node: c }));
      if (isNode(node.flow) || typeof node.flow === 'number') {
        out.push({ label: `${node.input} outside ${interval(e[0], e[e.length - 1])}`, node: node.flow });
      }
      return out;
    }
    case 'multibinning': {
      const axes = node.edges.map(axisEdges);
      const out = node.content.map((c, flat) => {
        const idx = unflatten(flat, axes.map((a) => a.length - 1));
        const parts = idx.map((k, d) => `${node.inputs[d]} ∈ ${interval(axes[d][k], axes[d][k + 1])}`);
        return { label: parts.join(', '), node: c };
      });
      if (isNode(node.flow) || typeof node.flow === 'number') {
        out.push({ label: 'outside the grid', node: node.flow });
      }
      return out;
    }
    case 'transform':
      return [
        { label: `rule: new value of ${node.input}`, node: node.rule },
        { label: `content, with ${node.input} replaced`, node: node.content },
      ];
    default:
      return [];
  }
}

function unflatten(flat, sizes) {
  // Row-major, the last axis fastest, as correctionlib stores MultiBinning content.
  const idx = new Array(sizes.length);
  for (let d = sizes.length - 1; d >= 0; --d) {
    idx[d] = flat % sizes[d];
    flat = Math.floor(flat / sizes[d]);
  }
  return idx;
}

export function fmt(x) {
  if (x === Infinity) return '∞';
  if (x === -Infinity) return '−∞';
  if (typeof x !== 'number') return String(x);
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 1e-3 && a < 1e5) return String(Number(x.toPrecision(6)));
  return x.toExponential(4);
}

export function interval(lo, hi) {
  return `[${fmt(lo)}, ${fmt(hi)})`;
}

// What the tree says about each input: the keys it is matched against (in the
// order they first appear), its distinct finite bin edges and their range, and
// where it appears. Also counts the nodes.
export function describeCorrection(correction) {
  const domains = new Map(
    correction.inputs.map((v) => [v.name, { keys: new Set(), edges: new Set(), min: Infinity, max: -Infinity, roles: new Set() }]),
  );
  const counts = {};
  let leaves = 0;
  let depth = 0;
  const generic = correction.generic_formulas || [];
  for (const f of generic) {
    for (const v of f.variables || []) domains.get(v)?.roles.add('formula');
  }

  const stack = [[correction.data, 1]];
  while (stack.length) {
    const [node, d] = stack.pop();
    depth = Math.max(depth, d);
    if (!isNode(node)) {
      leaves += 1;
      counts.value = (counts.value || 0) + 1;
      continue;
    }
    counts[node.nodetype] = (counts[node.nodetype] || 0) + 1;
    switch (node.nodetype) {
      case 'category': {
        const dom = domains.get(node.input);
        if (dom) {
          dom.roles.add('category');
          for (const item of node.content) dom.keys.add(item.key);
        }
        break;
      }
      case 'binning':
        addEdges(domains.get(node.input), axisEdges(node.edges));
        break;
      case 'multibinning':
        node.inputs.forEach((name, i) => addEdges(domains.get(name), axisEdges(node.edges[i])));
        break;
      case 'formula':
        leaves += 1;
        for (const v of node.variables || []) domains.get(v)?.roles.add('formula');
        break;
      case 'formularef':
        leaves += 1;
        break;
      case 'transform':
        domains.get(node.input)?.roles.add('transform');
        break;
      case 'hashprng':
        leaves += 1;
        for (const v of node.inputs || []) domains.get(v)?.roles.add('hashprng');
        break;
      default:
        leaves += 1;
        break;
    }
    for (const c of children(node)) stack.push([c.node, d + 1]);
  }

  const inputs = correction.inputs.map((v) => {
    const dom = domains.get(v.name);
    const finite = Number.isFinite(dom.min) && Number.isFinite(dom.max);
    return {
      ...v,
      keys: [...dom.keys],
      edges: [...dom.edges].sort((a, b) => a - b),
      min: finite ? dom.min : null,
      max: finite ? dom.max : null,
      roles: [...dom.roles],
    };
  });
  return { inputs, counts, leaves, depth };
}

function addEdges(dom, edges) {
  if (!dom) return;
  dom.roles.add('binning');
  for (const e of edges) {
    if (Number.isFinite(e)) {
      dom.edges.add(e);
      dom.min = Math.min(dom.min, e);
      dom.max = Math.max(dom.max, e);
    }
  }
}

// A starting value for each input: the first key for string inputs and keyed
// integers; for binned numbers the median of the distinct bin edges, which sits
// where the binning is densest (for log-spaced edges, the geometric middle);
// else 1.
export function defaultInputs(description) {
  return description.inputs.map((v) => {
    if (v.keys.length) return v.keys[0];
    if (v.type === 'string') return '';
    if (v.edges?.length) {
      const e = v.edges;
      const mid = e.length % 2 ? e[(e.length - 1) / 2] : (e[e.length / 2 - 1] + e[e.length / 2]) / 2;
      return v.type === 'int' ? Math.round(mid) : mid;
    }
    return 1;
  });
}

// Whether a binned input is better plotted on a log axis: non-negative, with
// positive edges spanning more than three decades.
export function logLike(v) {
  const positive = (v.edges || []).filter((e) => e > 0);
  return v.min !== null && v.min >= 0 && positive.length > 2 && v.max / positive[0] > 1e3;
}

// The path from the root to the leaf the inputs select, as a list of
// {label, node} steps; the last step holds the leaf. Follows categories and
// binnings with their flow rules. Stops at a transform, whose effect on the
// inputs is only known to the evaluator, and reports why.
export function trace(correction, values) {
  const index = new Map(correction.inputs.map((v, i) => [v.name, i]));
  const steps = [];
  let node = correction.data;
  for (let guard = 0; guard < 1000; ++guard) {
    if (!isNode(node)) return { steps, leaf: node };
    switch (node.nodetype) {
      case 'category': {
        const x = values[index.get(node.input)];
        const item = node.content.find((it) => it.key === x || (typeof it.key === 'number' && Number(x) === it.key));
        if (item) {
          steps.push({ label: `${node.input} = ${item.key}`, node });
          node = item.value;
        } else if (node.default !== undefined && node.default !== null) {
          steps.push({ label: `${node.input} = ${x} (default)`, node });
          node = node.default;
        } else {
          return { steps, stop: `no category for ${node.input} = ${x}` };
        }
        break;
      }
      case 'binning': {
        const e = axisEdges(node.edges);
        const r = locate(e, Number(values[index.get(node.input)]), node.flow);
        if (r.error) return { steps, stop: `${node.input} ${r.error}` };
        if (r.flowNode) {
          steps.push({ label: `${node.input} outside ${interval(e[0], e[e.length - 1])}`, node });
          node = node.flow;
        } else {
          steps.push({ label: `${node.input} ∈ ${interval(e[r.bin], e[r.bin + 1])}${r.note}`, node });
          node = node.content[r.bin];
        }
        break;
      }
      case 'multibinning': {
        const axes = node.edges.map(axisEdges);
        let flat = 0;
        const parts = [];
        for (let d = 0; d < axes.length; ++d) {
          const r = locate(axes[d], Number(values[index.get(node.inputs[d])]), node.flow);
          if (r.error) return { steps, stop: `${node.inputs[d]} ${r.error}` };
          if (r.flowNode) {
            steps.push({ label: `${node.inputs[d]} outside the grid`, node });
            node = node.flow;
            flat = -1;
            break;
          }
          flat = flat * (axes[d].length - 1) + r.bin;
          parts.push(`${node.inputs[d]} ∈ ${interval(axes[d][r.bin], axes[d][r.bin + 1])}${r.note}`);
        }
        if (flat >= 0) {
          steps.push({ label: parts.join(', '), node });
          node = node.content[flat];
        }
        break;
      }
      case 'transform':
        return { steps, stop: `transform of ${node.input}: the path depends on the evaluated rule` };
      default:
        return { steps, leaf: node };
    }
  }
  return { steps, stop: 'tree too deep' };
}

function locate(edges, x, flow) {
  const n = edges.length - 1;
  if (x >= edges[0] && x < edges[n]) {
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (x >= edges[mid]) lo = mid;
      else hi = mid;
    }
    return { bin: lo, note: '' };
  }
  if (Number.isNaN(x)) return { error: 'is NaN' };
  if (flow === 'clamp') return { bin: x < edges[0] ? 0 : n - 1, note: ' (clamped)' };
  if (flow === 'wrap') {
    const w = edges[n] - edges[0];
    const y = edges[0] + ((((x - edges[0]) % w) + w) % w);
    return { ...locate(edges, y, 'error'), note: ' (wrapped)' };
  }
  if (isNode(flow) || typeof flow === 'number') return { flowNode: true };
  return { error: `= ${fmt(x)} is outside ${interval(edges[0], edges[n])}` };
}

// A one-line description of a node, for the structure view and the trace.
export function summary(node, correction) {
  if (!isNode(node)) return `value ${fmt(node)}`;
  switch (node.nodetype) {
    case 'category':
      return `category on ${node.input}: ${node.content.length} key${node.content.length === 1 ? '' : 's'}${node.default !== undefined && node.default !== null ? ' and a default' : ''}`;
    case 'binning': {
      const e = axisEdges(node.edges);
      return `binning in ${node.input}: ${e.length - 1} bins over ${interval(e[0], e[e.length - 1])}, flow ${flowName(node.flow)}`;
    }
    case 'multibinning':
      return `multibinning in ${node.inputs.join(' × ')}: ${node.edges.map((x) => axisEdges(x).length - 1).join(' × ')} bins, flow ${flowName(node.flow)}`;
    case 'formula':
      return `formula ${node.expression}`;
    case 'formularef':
      return `generic formula ${node.index} with ${node.parameters.length} parameters`;
    case 'transform':
      return `transform of ${node.input}`;
    case 'hashprng':
      return `hash PRNG of ${node.inputs.join(', ')}, ${node.distribution}`;
    default:
      return node.nodetype;
  }
}

function flowName(flow) {
  if (typeof flow === 'string') return flow;
  if (typeof flow === 'number') return `value ${fmt(flow)}`;
  return 'to a subtree';
}

// The expression of a formula or formula reference with its parameters
// written in, for display.
export function substituted(node, correction) {
  if (!isNode(node)) return null;
  let expr;
  let params;
  if (node.nodetype === 'formula') {
    expr = node.expression;
    params = node.parameters || [];
  } else if (node.nodetype === 'formularef') {
    expr = correction?.generic_formulas?.[node.index]?.expression;
    params = node.parameters;
  } else {
    return null;
  }
  if (!expr) return null;
  return expr.replace(/\[(\d+)\]/g, (m, i) => (params[Number(i)] === undefined ? m : `(${fmt(params[Number(i)])})`));
}
