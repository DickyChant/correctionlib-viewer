// correctionlib viewer. It lists the corrections of a repository (from
// manifest.json, written by tools/make_site.py), opens correctionlib
// files from the user's disk, a URL or pasted text, and evaluates and plots any
// correction with correctionlib compiled to WebAssembly. Nothing is uploaded:
// opened files stay in the browser tab.
import { axisEdges, children, defaultInputs, describeCorrection, fmt, logLike, parseJSON, substituted, summary, trace } from './schema.mjs';
import { textFromFile, textFromUrl } from './files.mjs';
import { correctionlib, makeEvaluator } from './wasm.mjs';

const FILES = 'files/'; // where make_site.py copies the repository's files

const state = {
  manifest: null, // null while loading, false when the page has none
  sets: new Map(), // id -> set, see addSet()
  views: new Map(), // `${setId}\n${name}` -> {values, plot}
  loading: new Map(), // set id -> promise, while a repository file is fetched
  nextLocal: 1,
  route: 0, // bumped on every navigation; a view that loads asynchronously
  //           renders only if no navigation happened meanwhile
};

// ---------------------------------------------------------------- DOM helper

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // sanitized markdown only
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const view = () => document.getElementById('view');

function setView(...nodes) {
  view().replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  window.scrollTo(0, 0);
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function correctionLink(setId, name) {
  return `#/c/${encodeURIComponent(setId)}/${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------- sets

// Parses `text` and keeps it as a correction set. A set that fails to parse is
// kept too, with its error, so that the sidebar can show what went wrong.
async function addSet(id, label, origin, text, extra = {}) {
  const old = state.sets.get(id);
  old?.evaluator?.delete();
  const set = { id, label, origin, size: text.length, descriptions: new Map(), ...extra };
  try {
    set.doc = parseJSON(text);
  } catch (e) {
    set.error = `not valid JSON: ${e.message}`;
  }
  if (!set.error) {
    const r = await makeEvaluator(text);
    if (r.error) set.error = `correctionlib rejects it: ${r.error}`;
    else set.evaluator = r.evaluator;
  }
  state.sets.set(id, set);
  renderSidebar();
  return set;
}

function removeSet(id) {
  state.sets.get(id)?.evaluator?.delete();
  state.sets.delete(id);
  renderSidebar();
}

// A repository file is fetched the first time one of its corrections is shown.
async function ensureSet(id) {
  if (state.sets.has(id)) return state.sets.get(id);
  if (!id.startsWith('repo:')) return null;
  if (!state.loading.has(id)) {
    const path = id.slice('repo:'.length);
    state.loading.set(id, textFromUrl(FILES + path)
      .then((text) => addSet(id, exampleLabel(path), 'repo', text, { path }))
      .finally(() => state.loading.delete(id)));
  }
  return state.loading.get(id);
}

// Example files sit under examples/<set id>/; they are shown without that prefix.
function exampleLabel(path) {
  return path.replace(/^examples\/[^/]+\//, '');
}

function targetsOf(set) {
  if (!set?.doc) return [];
  return [
    ...(set.doc.corrections || []).map((c) => ({ kind: 'correction', item: c })),
    ...(set.doc.compound_corrections || []).map((c) => ({ kind: 'compound', item: c })),
  ];
}

// Inputs of a correction with what its tree says about them. A compound
// correction has no tree of its own: its inputs take the keys and ranges of
// the same-named inputs of the corrections it stacks.
function describe(set, target) {
  const key = `${target.kind}:${target.item.name}`;
  if (!set.descriptions.has(key)) {
    let d;
    if (target.kind === 'correction') {
      d = describeCorrection(target.item);
    } else {
      const members = (target.item.stack || [])
        .map((name) => set.doc.corrections.find((c) => c.name === name))
        .filter(Boolean)
        .map((c) => describe(set, { kind: 'correction', item: c }));
      d = {
        inputs: target.item.inputs.map((v) => {
          const found = members.flatMap((m) => m.inputs.filter((x) => x.name === v.name));
          const keys = [...new Set(found.flatMap((x) => x.keys))];
          const mins = found.map((x) => x.min).filter((x) => x !== null);
          const maxs = found.map((x) => x.max).filter((x) => x !== null);
          return {
            ...v,
            keys,
            edges: [...new Set(found.flatMap((x) => x.edges))].sort((a, b) => a - b),
            min: mins.length ? Math.min(...mins) : null,
            max: maxs.length ? Math.max(...maxs) : null,
            roles: [...new Set(found.flatMap((x) => x.roles))],
          };
        }),
      };
    }
    set.descriptions.set(key, d);
  }
  return set.descriptions.get(key);
}

// ---------------------------------------------------------------- sidebar

function renderSidebar() {
  const current = decodeURIComponent(location.hash);
  const block = (set, files) => {
    const list = h('ul', {});
    for (const t of targetsOf(set)) {
      const href = correctionLink(set.id, t.item.name);
      list.append(h('li', {}, h('a', { href, class: current === decodeURIComponent(href) ? 'current' : null }, t.item.name)));
    }
    return h('div', { class: 'set' },
      h('div', { class: 'set-name' },
        h('span', {}, set.label),
        set.origin === 'local' ? h('button', { title: 'Close', 'aria-label': `Close ${set.label}`, onclick: () => { removeSet(set.id); if (current.includes(set.id)) location.hash = '#/open'; } }, '×') : null),
      set.error ? h('div', { class: 'notice error' }, set.error) : list,
      files);
  };

  const side = document.getElementById('sidebar');
  side.replaceChildren();
  side.append(h('h2', {}, 'This repository'));
  if (state.manifest === null) side.append(h('p', { class: 'meta' }, 'Loading…'));
  else if (!state.manifest) side.append(h('p', { class: 'meta' }, 'No manifest.json next to this page, so no repository files to list.'));
  else {
    // A file of the manifest: from its set once loaded, else from the manifest.
    const fileBlock = (f) => {
      const set = state.sets.get(`repo:${f.path}`);
      if (set) return block(set);
      return h('div', { class: 'set' },
        h('div', { class: 'set-name' }, h('span', {}, exampleLabel(f.path))),
        h('ul', {}, f.corrections.map((c) => h('li', {}, h('a', {
          href: correctionLink(`repo:${f.path}`, c.name),
          class: current === decodeURIComponent(correctionLink(`repo:${f.path}`, c.name)) ? 'current' : null,
        }, c.name)))));
    };
    if (!state.manifest.files.length) side.append(h('p', { class: 'meta' }, 'No correction files.'));
    for (const f of state.manifest.files) side.append(fileBlock(f));
    // Example sets can hold hundreds of corrections: one folded entry per file,
    // unfolded for the file being shown.
    for (const ex of state.manifest.examples || []) {
      side.append(h('h2', {}, `Example: ${ex.title}`));
      for (const f of ex.files) {
        const open = current.startsWith(`#/c/repo:${f.path}/`);
        side.append(h('details', { class: 'set-fold', open },
          h('summary', {}, exampleLabel(f.path), h('span', { class: 'meta' }, ` ${f.corrections.length}`)),
          fileBlock(f)));
      }
    }
  }
  const local = [...state.sets.values()].filter((s) => s.origin === 'local');
  side.append(h('h2', {}, 'Opened in this tab'));
  if (!local.length) side.append(h('p', { class: 'meta' }, h('a', { href: '#/open' }, 'Open a file'), ', or drop one anywhere on the page.'));
  for (const s of local) side.append(block(s));
}

// ---------------------------------------------------------------- markdown

async function markdown(path) {
  const text = await (await fetch(FILES + path)).text();
  const html = window.DOMPurify.sanitize(window.marked.parse(text));
  const div = h('div', { class: 'readme', html });
  // Relative links point into the repository; send them to GitHub.
  const base = state.manifest?.repository ? `https://github.com/${state.manifest.repository}/blob/${state.manifest.commit || 'main'}/` : null;
  for (const a of div.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^[a-z]+:|^#/i.test(href)) continue;
    if (base) a.href = new URL(href, base + path).href;
  }
  return div;
}

// ---------------------------------------------------------------- repository view

function showRepository() {
  const m = state.manifest;
  const lib = state.libVersion ? `correctionlib ${state.libVersion}` : 'correctionlib';
  const parts = [
    h('h1', {}, 'Corrections in this repository'),
    h('p', { class: 'lead' },
      'The correctionlib files of ',
      m?.repository ? h('a', { href: `https://github.com/${m.repository}` }, m.repository) : 'this repository',
      m?.commit ? [' at ', h('a', { href: `https://github.com/${m.repository}/commit/${m.commit}` }, h('code', {}, m.commit.slice(0, 7)))] : null,
      '. Open a correction to see its inputs, evaluate it and plot it. Everything runs in your browser, with ',
      lib, ' compiled to WebAssembly.'),
  ];
  if (m === null) parts.push(h('p', {}, 'Loading the list of files…'));
  else if (!m) parts.push(h('div', { class: 'notice' }, 'This copy of the page has no manifest.json, so it lists no repository files. ', h('a', { href: '#/open' }, 'Open a file'), ' instead.'));
  else {
    for (const f of m.files) parts.push(fileCard(f));
    if (m.readme) {
      const det = h('details', { class: 'card' }, h('summary', {}, h('strong', {}, 'Repository README')));
      det.addEventListener('toggle', async () => {
        if (det.open && det.children.length === 1) det.append(await markdown(m.readme));
      });
      parts.push(det);
    }
    for (const ex of m.examples || []) {
      parts.push(
        h('h2', {}, `Example: ${ex.title}`),
        h('p', { class: 'lead' }, ex.description ? `${ex.description} ` : '',
          'From ', h('a', { href: ex.source }, ex.source.replace(/^https?:\/\//, '')),
          ex.license ? ` (${ex.license})` : '', ', checked against a pinned checksum when this page was built.'),
        ex.files.map((f) => fileCard(f, ex)));
    }
  }
  setView(...parts);
}

// A file of the manifest. Files of an example set (`example`) come folded, with
// a link to where they come from instead of GitHub.
function fileCard(f, example = null) {
  const id = `repo:${f.path}`;
  const github = !example && state.manifest.repository
    ? `https://github.com/${state.manifest.repository}/blob/${state.manifest.commit || 'main'}/${f.path}` : null;
  const head = h('div', { class: 'card-head' },
    h('span', { class: 'path mono' }, exampleLabel(f.path)),
    h('span', { class: 'meta' }, bytes(f.size),
      example ? ` · ${f.corrections.length} correction${f.corrections.length === 1 ? '' : 's'}` : '',
      f.updated ? ` · updated ${f.updated.slice(0, 10)}` : '',
      f.commit ? [' in ', h('code', {}, f.commit.slice(0, 7))] : ''),
    github ? h('a', { class: 'meta', href: github }, 'on GitHub') : null,
    example ? h('a', { class: 'meta', href: example.source }, 'source') : null,
    h('a', { class: 'meta', href: FILES + f.path, download: f.path.split('/').pop() }, 'download'));
  const card = example
    ? h('details', { class: 'card fold' }, h('summary', {}, head))
    : h('section', { class: 'card' }, head);
  card.append(
    f.description ? h('p', {}, f.description) : '',
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Correction'), h('th', {}, 'Inputs'), h('th', {}, 'Output'), h('th', {}, 'Description'))),
      h('tbody', {}, f.corrections.map((c) => h('tr', {},
        h('td', {}, h('a', { href: correctionLink(id, c.name) }, c.name), c.version !== undefined ? h('div', { class: 'meta' }, `version ${c.version}`) : null, c.compound ? h('span', { class: 'chip' }, 'compound') : null),
        h('td', {}, c.inputs.map((v) => h('div', { class: 'nowrap' }, h('code', {}, v.name), ' ', h('span', { class: 'chip' }, v.type)))),
        h('td', {}, h('code', {}, c.output.name)),
        h('td', {}, c.description || '')))))));
  if (f.readme) {
    const det = h('details', {}, h('summary', {}, h('code', {}, f.readme)));
    det.addEventListener('toggle', async () => {
      if (det.open && det.children.length === 1) det.append(await markdown(f.readme));
    });
    card.append(det);
  }
  return card;
}

// ---------------------------------------------------------------- open view

let pasteTimer = null;

function showOpen() {
  const fileInput = h('input', { type: 'file', accept: '.json,.gz,application/json,application/gzip', multiple: true, hidden: true,
    onchange: (e) => openFiles([...e.target.files]) });
  const drop = h('div', { class: 'drop', role: 'button', tabindex: '0',
    onclick: () => fileInput.click(),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); } },
  h('p', {}, h('strong', {}, 'Drop correctionlib files here'), ' or click to choose them'),
  h('p', { class: 'meta' }, 'JSON or gzipped JSON (.json.gz). The files are read in your browser and never uploaded.'));
  const url = h('input', { type: 'url', placeholder: 'https://raw.githubusercontent.com/…/corrections.json.gz', 'aria-label': 'URL of a correctionlib file' });
  const urlStatus = h('div', {});
  const paste = h('textarea', { placeholder: '{"schema_version": 2, "corrections": [ … ]}', spellcheck: 'false', 'aria-label': 'correctionlib JSON' });
  const pasteStatus = h('div', {});

  paste.addEventListener('input', () => {
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(async () => {
      if (!paste.value.trim()) {
        removeSet('local:paste');
        pasteStatus.replaceChildren();
        return;
      }
      const set = await addSet('local:paste', 'Pasted JSON', 'local', paste.value);
      pasteStatus.replaceChildren(setStatus(set));
    }, 300);
  });
  const pasted = state.sets.get('local:paste');
  if (pasted) pasteStatus.append(setStatus(pasted));

  setView(
    h('h1', {}, 'Open a correctionlib file'),
    h('p', { class: 'lead' }, 'Inspect, evaluate and plot any correctionlib (schema v2) file. Files opened here stay in this tab: they are listed in the sidebar until you close the tab.'),
    drop, fileInput,
    h('h2', {}, 'From a URL'),
    h('div', { class: 'row' }, url, h('button', { class: 'primary', onclick: async () => {
      urlStatus.replaceChildren(h('p', { class: 'meta' }, 'Loading…'));
      try {
        const text = await textFromUrl(url.value.trim());
        const set = await addSet(`local:${state.nextLocal++}`, url.value.trim().split('/').pop() || url.value, 'local', text);
        urlStatus.replaceChildren(setStatus(set));
      } catch (e) {
        urlStatus.replaceChildren(h('div', { class: 'notice error' }, `${e.message}. The server must allow cross-origin requests (raw.githubusercontent.com does).`));
      }
    } }, 'Load')),
    urlStatus,
    h('h2', {}, 'Paste JSON'),
    h('p', { class: 'meta' }, 'Checked by correctionlib as you type.'),
    paste, pasteStatus,
  );
}

function setStatus(set) {
  if (set.error) return h('div', { class: 'notice error' }, set.error);
  const targets = targetsOf(set);
  return h('div', { class: 'notice' },
    `Valid: ${targets.length} correction${targets.length === 1 ? '' : 's'}. `,
    targets.map((t, i) => [i ? ', ' : '', h('a', { href: correctionLink(set.id, t.item.name) }, t.item.name)]));
}

async function openFiles(files) {
  let first = null;
  for (const file of files) {
    let set;
    try {
      set = await addSet(`local:${state.nextLocal++}`, file.name, 'local', await textFromFile(file));
    } catch (e) {
      set = { error: `${file.name}: ${e.message}` };
    }
    if (!first) first = set;
  }
  const t = targetsOf(first)[0];
  if (t) location.hash = correctionLink(first.id, t.item.name);
  else if (location.hash !== '#/open') location.hash = '#/open';
  else showOpen();
}

// ---------------------------------------------------------------- correction view

async function showCorrection(setId, name) {
  const token = state.route;
  if (!state.sets.has(setId)) setView(h('p', { class: 'meta' }, `Loading ${setId.replace(/^repo:/, '')}…`));
  let set;
  try {
    set = await ensureSet(setId);
  } catch (e) {
    if (token === state.route) setView(h('div', { class: 'notice error' }, `Could not load ${setId}: ${e.message}`));
    return;
  }
  if (token !== state.route) return;
  if (!set) {
    setView(h('h1', {}, name), h('div', { class: 'notice' }, 'Files opened from your disk are not kept when the page reloads. ', h('a', { href: '#/open' }, 'Open it again'), '.'));
    return;
  }
  if (set.error) {
    setView(h('h1', {}, set.label), h('div', { class: 'notice error' }, set.error));
    return;
  }
  const target = targetsOf(set).find((t) => t.item.name === name);
  if (!target) {
    setView(h('div', { class: 'notice error' }, `${set.label} has no correction named ${name}.`));
    return;
  }
  renderSidebar();
  const c = target.item;
  const d = describe(set, target);
  const key = `${setId}\n${name}`;
  if (!state.views.has(key)) state.views.set(key, { values: defaultInputs(d, target.kind === 'correction' ? target.item : null), plot: defaultPlot(d) });
  const vs = state.views.get(key);

  const resultBox = h('div', { class: 'result' });
  const plotBox = h('div', { class: 'plot' });
  const plotControls = h('div', { class: 'plot-controls' });
  const snippetBox = h('div', {});
  let frame = 0;
  const update = () => {
    renderResult(set, target, vs.values, resultBox);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => renderPlot(set, target, d, vs, plotBox));
    renderSnippets(set, target, vs.values, snippetBox);
  };

  setView(
    h('p', { class: 'meta' }, set.origin === 'repo' ? h('a', { href: '#/' }, 'Repository') : 'Opened in this tab', ' / ', h('span', { class: 'mono' }, set.label)),
    h('h1', {}, c.name, ' ', target.kind === 'compound' ? h('span', { class: 'chip' }, 'compound') : null, c.version !== undefined ? h('span', { class: 'chip' }, `version ${c.version}`) : null),
    c.description ? h('p', { class: 'lead' }, c.description) : null,
    h('div', { class: 'panels' },
      h('section', { class: 'card' }, h('h3', {}, 'Evaluate'), inputControls(d, vs, update), resultBox),
      h('section', { class: 'card' }, h('h3', {}, 'Plot'), plotControls, plotBox)),
    h('h2', {}, 'Inputs and output'),
    inputsTable(d, c),
    target.kind === 'compound' ? compoundInfo(c) : structure(c),
    h('h2', {}, 'Use it in an analysis'),
    snippetBox,
  );
  renderPlotControls(d, vs, plotControls, () => renderPlot(set, target, d, vs, plotBox));
  update();
}

function inputControls(d, vs, onChange) {
  return h('div', { class: 'inputs' }, d.inputs.map((v, i) => {
    const set = (x) => { vs.values[i] = x; onChange(); };
    let controls;
    if (v.keys.length) {
      const select = h('select', { 'aria-label': v.name, onchange: (e) => set(v.type === 'string' ? e.target.value : Number(e.target.value)) },
        v.keys.map((k) => h('option', { value: String(k), selected: String(k) === String(vs.values[i]) || null }, String(k))));
      controls = [select];
    } else if (v.type === 'string') {
      controls = [h('input', { type: 'text', value: vs.values[i], 'aria-label': v.name, oninput: (e) => set(e.target.value) })];
    } else {
      const num = h('input', { type: 'number', step: v.type === 'int' ? '1' : 'any', value: String(vs.values[i]), 'aria-label': v.name });
      const parts = [num];
      let range = null;
      if (v.min !== null && v.max > v.min) {
        range = h('input', { type: 'range', min: String(v.min), max: String(v.max), step: v.type === 'int' ? '1' : String((v.max - v.min) / 1000), value: String(vs.values[i]), 'aria-label': `${v.name} slider` });
        range.addEventListener('input', () => { num.value = range.value; set(Number(range.value)); });
        parts.push(range);
      }
      num.addEventListener('input', () => {
        if (num.value === '' || Number.isNaN(Number(num.value))) return;
        if (range) range.value = num.value;
        set(Number(num.value));
      });
      controls = parts;
    }
    return h('div', { class: 'input-row' },
      h('label', {}, h('code', {}, v.name), h('span', { class: 'chip' }, v.type), v.description ? h('span', { class: 'desc' }, v.description) : null),
      h('div', { class: 'controls' }, controls));
  }));
}

function renderResult(set, target, values, box) {
  const c = target.item;
  const r = set.evaluator.evaluate(c.name, values);
  const parts = [];
  if (r.error !== undefined) parts.push(h('div', { class: 'notice error' }, r.error));
  else parts.push(h('div', { class: 'value' }, h('small', {}, `${c.output.name} = `), String(r.value)));
  if (target.kind === 'correction') {
    const t = trace(c, values);
    const steps = t.steps.map((s) => h('li', {}, s.label));
    let leaf = null;
    if (t.leaf !== undefined) {
      steps.push(h('li', {}, summary(t.leaf, c)));
      const sub = substituted(t.leaf, c);
      if (sub) leaf = formulaDetails(sub);
      if (t.leaf?.nodetype === 'hashprng' && t.leaf.distribution === 'stdnormal') {
        leaf = h('div', { class: 'notice warn' }, "A hash PRNG 'stdnormal' draw: correctionlib takes it from std::normal_distribution, whose algorithm differs between C++ standard libraries. This browser build (libc++) gives a different number for these inputs than a Linux build (libstdc++); the distribution is the same.");
      }
    } else if (t.stop) {
      steps.push(h('li', { class: 'meta' }, t.stop));
    }
    parts.push(h('div', { class: 'meta' }, 'Path through the tree:'), h('ol', { class: 'trace' }, steps));
    if (leaf) parts.push(leaf);
  }
  box.replaceChildren(...parts);
}

function inputsTable(d, c) {
  const domain = (v) => {
    if (v.keys.length) {
      const shown = v.keys.slice(0, 30).map(String).join(', ');
      return `${v.keys.length} value${v.keys.length === 1 ? '' : 's'}: ${shown}${v.keys.length > 30 ? ', …' : ''}`;
    }
    if (v.min !== null) return `bin edges span [${fmt(v.min)}, ${fmt(v.max)}]`;
    return v.roles.length ? 'not binned' : 'not used by the tree';
  };
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Description'), h('th', {}, 'In the tree'))),
    h('tbody', {},
      d.inputs.map((v) => h('tr', {}, h('td', {}, h('code', {}, v.name)), h('td', {}, v.type), h('td', {}, v.description || ''),
        h('td', {}, domain(v), v.roles.length ? h('div', {}, v.roles.map((r) => h('span', { class: 'chip' }, r))) : null))),
      h('tr', {}, h('td', {}, h('code', {}, c.output.name), h('div', { class: 'meta' }, 'output')), h('td', {}, c.output.type), h('td', {}, c.output.description || ''), h('td', {})))));
}

function compoundInfo(c) {
  return [
    h('h2', {}, 'Stack'),
    h('p', {}, `Evaluates ${c.stack.length} corrections in turn; outputs combined with `, h('code', {}, c.output_op),
      c.inputs_update?.length ? [', and after each one ', h('code', {}, c.inputs_update.join(', ')), ' updated with ', h('code', {}, c.input_op)] : '', '.'),
    h('ol', {}, c.stack.map((name) => h('li', {}, h('code', {}, name)))),
  ];
}

// ---------------------------------------------------------------- structure

function structure(c) {
  const d = describeCorrection(c);
  const counts = Object.entries(d.counts).map(([k, n]) => `${n} ${k}`).join(', ');
  const parts = [
    h('h2', {}, 'Structure'),
    h('p', { class: 'meta' }, `${counts}; ${d.leaves} leaves, depth ${d.depth}. Expand a node to see its children.`),
  ];
  if (c.generic_formulas?.length) {
    parts.push(h('h3', {}, 'Generic formulas'), h('ol', { start: '0' },
      c.generic_formulas.map((f) => {
        const vars = h('span', { class: 'meta' }, ` in ${(f.variables || []).join(', ')}, parameters [0]…`);
        if (f.expression.length <= 200) return h('li', {}, h('code', {}, f.expression), vars);
        return h('li', {}, h('details', {}, h('summary', {}, h('code', {}, `${f.expression.slice(0, 80)}…`), vars), h('code', { class: 'formula' }, f.expression)));
      })));
  }
  parts.push(h('div', { class: 'tree' }, treeNode(null, c.data, c)));
  return parts;
}

const PAGE = 200;

// A formula with its parameters written in. These can run to pages, so they
// start folded.
function formulaDetails(text) {
  return h('details', { class: 'formula-details' },
    h('summary', { class: 'meta' }, `formula with its parameters (${text.length} characters)`),
    h('code', { class: 'formula' }, text));
}

function treeNode(label, node, c) {
  const line = h('span', {}, label ? h('span', { class: 'node-label' }, `${label} → `) : null, summary(node, c));
  const kids = children(node);
  if (!kids.length) {
    const sub = node?.nodetype === 'formularef' ? substituted(node, c) : null;
    return h('div', { class: 'leaf' }, line, sub ? formulaDetails(sub) : null);
  }
  const det = h('details', {}, h('summary', {}, line));
  let shown = 0;
  const more = h('button', { class: 'more' });
  const showMore = () => {
    for (const k of kids.slice(shown, shown + PAGE)) det.insertBefore(treeNode(k.label, k.node, c), more);
    shown = Math.min(kids.length, shown + PAGE);
    more.textContent = `show ${Math.min(PAGE, kids.length - shown)} more of ${kids.length - shown}`;
    more.hidden = shown >= kids.length;
  };
  more.addEventListener('click', showMore);
  det.append(more);
  det.addEventListener('toggle', () => { if (det.open && shown === 0) showMore(); });
  return det;
}

// ---------------------------------------------------------------- plot

function numericInputs(d) {
  return d.inputs.map((v, i) => ({ v, i })).filter(({ v }) => v.type !== 'string');
}

function defaultPlot(d) {
  const numeric = numericInputs(d);
  // Prefer the real input with the finest binning; then any numeric input.
  const binned = numeric.filter(({ v }) => v.type === 'real' && v.edges.length && !v.keys.length);
  const x = binned.sort((a, b) => b.v.edges.length - a.v.edges.length)[0] || numeric.find(({ v }) => !v.keys.length) || numeric[0];
  if (!x) return null;
  return { x: x.i, split: 'none', edges: x.v.edges.length <= 60, ...rangeOf(x.v) };
}

// Default axis range of an input, and whether to use a log axis: the span of
// its bin edges, else the span of its integer keys, else [-2, 2]. Edges that
// cover many decades go on a log axis, limited to two decades either side of
// the median edge: such binnings usually extend far beyond where the
// correction is meant to be used, only to give every input a bin.
function rangeOf(v) {
  if (logLike(v)) {
    const median = v.edges[Math.floor(v.edges.length / 2)];
    return { lo: Math.max(v.edges.find((e) => e > 0), median / 100), hi: Math.min(v.max, median * 100), log: true };
  }
  if (v.min !== null && v.max > v.min) return { lo: v.min, hi: v.max, log: false };
  if (v.keys.length && typeof v.keys[0] === 'number') return { lo: Math.min(...v.keys), hi: Math.max(...v.keys), log: false };
  return { lo: -2, hi: 2, log: false };
}

function renderPlotControls(d, vs, box, onChange) {
  const p = vs.plot;
  if (!p) {
    box.replaceChildren(h('p', { class: 'meta' }, 'Nothing to plot: every input is a string.'));
    return;
  }
  const numeric = numericInputs(d);
  const lo = h('input', { type: 'number', step: 'any', value: String(p.lo), 'aria-label': 'x from' });
  const hi = h('input', { type: 'number', step: 'any', value: String(p.hi), 'aria-label': 'x to' });
  const xSel = h('select', { 'aria-label': 'x axis', onchange: (e) => {
    p.x = Number(e.target.value);
    Object.assign(p, rangeOf(d.inputs[p.x]), { edges: d.inputs[p.x].edges.length <= 60 });
    if (p.split === `y:${p.x}` || p.split === `lines:${p.x}`) p.split = 'none';
    renderPlotControls(d, vs, box, onChange);
    onChange();
  } }, numeric.map(({ v, i }) => h('option', { value: String(i), selected: i === p.x || null }, v.name)));
  const splitOptions = [h('option', { value: 'none' }, 'one curve')];
  d.inputs.forEach((v, i) => {
    if (i === p.x) return;
    if (v.keys.length) splitOptions.push(h('option', { value: `lines:${i}` }, `one curve per ${v.name}`));
    if (v.type !== 'string') splitOptions.push(h('option', { value: `y:${i}` }, `map against ${v.name}`));
  });
  const split = h('select', { 'aria-label': 'curves', onchange: (e) => {
    p.split = e.target.value;
    if (p.split.startsWith('y:')) {
      const r = rangeOf(d.inputs[Number(p.split.slice(2))]);
      p.ylo = r.lo;
      p.yhi = r.hi;
      p.ylog = r.log;
    }
    renderPlotControls(d, vs, box, onChange);
    onChange();
  } }, splitOptions);
  split.value = p.split;
  const apply = () => {
    const a = Number(lo.value);
    const b = Number(hi.value);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      p.lo = a;
      p.hi = b;
      onChange();
    }
  };
  lo.addEventListener('change', apply);
  hi.addEventListener('change', apply);
  const parts = [
    h('label', {}, 'x', xSel),
    h('label', {}, 'from', lo, 'to', hi),
    h('label', {}, split),
    h('label', {}, h('input', { type: 'checkbox', checked: p.log || null, onchange: (e) => { p.log = e.target.checked; onChange(); } }), 'log x'),
  ];
  if (!p.split.startsWith('y:')) {
    parts.push(h('label', {}, h('input', { type: 'checkbox', checked: p.edges || null, onchange: (e) => { p.edges = e.target.checked; onChange(); } }), 'bin edges'));
  }
  box.replaceChildren(...parts);
}

function grid(lo, hi, n, log) {
  if (log && lo > 0) {
    const a = Math.log(lo);
    const b = Math.log(hi);
    return Array.from({ length: n }, (_, k) => Math.exp(a + ((b - a) * k) / (n - 1)));
  }
  return Array.from({ length: n }, (_, k) => lo + ((hi - lo) * k) / (n - 1));
}

function themeColors() {
  const s = getComputedStyle(document.documentElement);
  return { fg: s.getPropertyValue('--fg').trim(), grid: s.getPropertyValue('--plot-grid').trim(), muted: s.getPropertyValue('--muted').trim(), accent: s.getPropertyValue('--accent').trim() };
}

// Bin edges in x along the path the current inputs take.
function pathEdges(target, values, x) {
  if (target.kind !== 'correction') return [];
  const c = target.item;
  const name = c.inputs[x].name;
  const out = [];
  for (const s of trace(c, values).steps) {
    if (s.node.nodetype === 'binning' && s.node.input === name) out.push(...axisEdges(s.node.edges));
    if (s.node.nodetype === 'multibinning') {
      const k = s.node.inputs.indexOf(name);
      if (k >= 0) out.push(...axisEdges(s.node.edges[k]));
    }
  }
  return out.filter(Number.isFinite);
}

function renderPlot(set, target, d, vs, box) {
  const p = vs.plot;
  if (!p || !window.Plotly) {
    if (!window.Plotly) box.replaceChildren(h('p', { class: 'meta' }, 'Plotly did not load, so there is no plot.'));
    return;
  }
  const c = target.item;
  const colors = themeColors();
  const xv = d.inputs[p.x];
  const log = p.log && p.lo > 0;
  const layout = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: colors.fg, size: 12 },
    margin: { l: 60, r: 20, t: 10, b: 50 },
    xaxis: { title: { text: xv.name }, type: log ? 'log' : 'linear', gridcolor: colors.grid, zerolinecolor: colors.grid },
    yaxis: { title: { text: c.output.name }, gridcolor: colors.grid, zerolinecolor: colors.grid, exponentformat: 'power' },
    legend: { orientation: 'h', y: -0.2 },
    showlegend: false,
  };
  let traces;
  let error = null;
  if (p.split.startsWith('y:')) {
    const iy = Number(p.split.slice(2));
    const yv = d.inputs[iy];
    const ylog = p.ylog && p.ylo > 0;
    const xs = grid(p.lo, p.hi, 160, log);
    const ys = grid(p.ylo, p.yhi, 120, ylog);
    layout.yaxis.type = ylog ? 'log' : 'linear';
    const r = set.evaluator.scan2d(c.name, vs.values, p.x, Float64Array.from(xs), iy, Float64Array.from(ys));
    error = r.error;
    const z = ys.map((_, j) => Array.from(r.values.subarray(j * xs.length, (j + 1) * xs.length), (v) => (Number.isFinite(v) ? v : null)));
    // A few extreme cells (a formula dividing by sin(theta) at theta = 0, say)
    // would make the rest one colour, so the scale spans the 2-98% quantiles.
    const finite = Array.from(r.values).filter(Number.isFinite).sort((a, b) => a - b);
    const zmin = finite[Math.floor(0.02 * (finite.length - 1))];
    const zmax = finite[Math.ceil(0.98 * (finite.length - 1))];
    const clipped = finite.length && (finite[0] < zmin || finite[finite.length - 1] > zmax);
    traces = [{ type: 'heatmap', x: xs, y: ys, z, colorscale: 'Viridis', zmin, zmax, colorbar: { title: { text: c.output.name } } }];
    if (clipped) error = [error, `Colours span the 2–98% range of the values, [${fmt(zmin)}, ${fmt(zmax)}]; the full range is [${fmt(finite[0])}, ${fmt(finite[finite.length - 1])}].`].filter(Boolean).join(' ');
    layout.yaxis.title.text = yv.name;
    traces.push({ type: 'scatter', mode: 'markers', x: [vs.values[p.x]], y: [vs.values[iy]], marker: { color: colors.fg, size: 9, symbol: 'x' }, hoverinfo: 'skip' });
  } else {
    const xs = grid(p.lo, p.hi, 500, log);
    const curves = [];
    if (p.split.startsWith('lines:')) {
      const i = Number(p.split.slice(6));
      for (const k of d.inputs[i].keys) {
        const values = vs.values.slice();
        values[i] = k;
        curves.push({ name: `${d.inputs[i].name} = ${k}`, values });
      }
      layout.showlegend = true;
    } else {
      curves.push({ name: c.output.name, values: vs.values });
    }
    traces = curves.map((cv) => {
      const r = set.evaluator.scan(c.name, cv.values, p.x, Float64Array.from(xs));
      error ??= r.error;
      return { type: 'scatter', mode: 'lines', name: cv.name, x: xs, y: Array.from(r.values, (v) => (Number.isFinite(v) ? v : null)), line: { width: 2, shape: 'linear' } };
    });
    const now = set.evaluator.evaluate(c.name, vs.values);
    if (now.error === undefined) {
      traces.push({ type: 'scatter', mode: 'markers', x: [vs.values[p.x]], y: [now.value], name: 'current inputs', marker: { color: colors.fg, size: 9 }, showlegend: false });
    }
    if (p.edges) {
      const edges = pathEdges(target, vs.values, p.x).filter((e) => e >= p.lo && e <= p.hi);
      if (edges.length <= 400) {
        layout.shapes = edges.map((e) => ({ type: 'line', xref: 'x', yref: 'paper', x0: e, x1: e, y0: 0, y1: 1, line: { color: colors.grid, width: 1, dash: 'dot' } }));
      }
    }
  }
  if (box.dataset.plotted) window.Plotly.react(box, traces, layout, { responsive: true, displaylogo: false });
  else {
    window.Plotly.newPlot(box, traces, layout, { responsive: true, displaylogo: false });
    box.dataset.plotted = '1';
  }
  const note = box.nextElementSibling?.classList?.contains('plot-note') ? box.nextElementSibling : null;
  if (error) {
    const msg = h('p', { class: 'meta plot-note' }, error.startsWith('Colours') ? error : `Gaps are inputs correctionlib refuses, e.g.: ${error}`);
    if (note) note.replaceWith(msg);
    else box.after(msg);
  } else note?.remove();
}

// ---------------------------------------------------------------- snippets

function literal(v, type) {
  if (type === 'string') return JSON.stringify(String(v));
  if (type === 'int') return String(Math.round(Number(v)));
  const s = String(Number(v));
  return /[.eE]|Infinity|NaN/.test(s) ? s : `${s}.0`;
}

function renderSnippets(set, target, values, box) {
  const c = target.item;
  const file = set.path ? set.path.split('/').pop() : set.label;
  const args = c.inputs.map((v, i) => literal(values[i], v.type));
  const r = set.evaluator.evaluate(c.name, values);
  const result = r.error === undefined ? `# ${c.output.name} = ${r.value}` : `# error: ${r.error}`;
  const pyGet = target.kind === 'compound' ? `cset.compound[${JSON.stringify(c.name)}]` : `cset[${JSON.stringify(c.name)}]`;
  const python = `import correctionlib\n\ncset = correctionlib.CorrectionSet.from_file(${JSON.stringify(file)})\n${pyGet}.evaluate(${args.join(', ')})\n${result}`;
  const cppArgs = c.inputs.map((v, i) => (v.type === 'string' ? `std::string(${args[i]})` : v.type === 'int' ? `int64_t(${args[i]})` : args[i]));
  const cppGet = target.kind === 'compound' ? `cset->compound().at(${JSON.stringify(c.name)})` : `cset->at(${JSON.stringify(c.name)})`;
  const cpp = `#include "correction.h"\n\nauto cset = correction::CorrectionSet::from_file(${JSON.stringify(file)});\ndouble value = ${cppGet}->evaluate({${cppArgs.join(', ')}});\n${result.replace(/^#/, '//')}`;
  const block = (title, text) => h('div', {},
    h('h3', {}, title),
    h('div', { class: 'snippet' }, h('pre', {}, h('code', {}, text)),
      h('button', { onclick: (e) => navigator.clipboard?.writeText(text).then(() => { e.target.textContent = 'copied'; setTimeout(() => { e.target.textContent = 'copy'; }, 1200); }) }, 'copy')));
  box.replaceChildren(
    h('p', { class: 'meta' }, 'The same evaluation with the current inputs. correctionlib is on PyPI (', h('code', {}, 'pip install correctionlib'), ').'),
    block('Python', python),
    block('C++', cpp));
}

// ---------------------------------------------------------------- routing and start-up

function route() {
  state.route += 1;
  const hash = location.hash.replace(/^#\/?/, '');
  const [kind, ...rest] = hash.split('/');
  for (const a of document.querySelectorAll('[data-nav]')) {
    a.classList.toggle('active', (a.dataset.nav === 'open' && kind === 'open') || (a.dataset.nav === 'repo' && kind !== 'open' && kind !== 'c'));
  }
  if (kind === 'open') showOpen();
  else if (kind === 'c' && rest.length >= 2) showCorrection(decodeURIComponent(rest[0]), decodeURIComponent(rest.slice(1).join('/')));
  else showRepository();
  renderSidebar();
}

function enableDrop() {
  const overlay = document.getElementById('drop-overlay');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth += 1; overlay.hidden = false; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    openFiles([...e.dataTransfer.files]);
  });
}

async function start() {
  enableDrop();
  window.addEventListener('hashchange', route);
  const engine = document.getElementById('engine');
  correctionlib().then((lib) => {
    state.libVersion = lib.correctionlibVersion;
    engine.textContent = `correctionlib ${lib.correctionlibVersion} · WebAssembly`;
  }).catch((e) => {
    engine.textContent = 'correctionlib failed to load';
    engine.classList.add('error');
    view().prepend(h('div', { class: 'notice error' }, `correctionlib (WebAssembly) failed to load: ${e.message}. This page needs a browser with WebAssembly exception handling (Chrome 95, Firefox 100, Safari 15.2 or newer).`));
  });
  route();
  try {
    const r = await fetch('manifest.json');
    state.manifest = r.ok ? await r.json() : false;
  } catch {
    state.manifest = false;
  }
  if (state.manifest?.title) {
    document.title = state.manifest.title;
    document.querySelector('.brand').textContent = state.manifest.title;
  }
  route();
}

start();
