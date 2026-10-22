# correctionlib-viewer

A web page that lists the [correctionlib](https://github.com/cms-nanoAOD/correctionlib)
files of a repository and evaluates and plots any correction in the browser,
with correctionlib's own C++ evaluator compiled to WebAssembly. It is also a
GitHub Action that publishes that page for a repository.

- **Repository view.** Every correction file in the repository, with its
  corrections, their inputs and the README of its directory.
- **Open a file.** Drop a `.json` or `.json.gz` file on the page, choose one,
  load one from a URL, or paste JSON (checked as you type). Files are read in the
  browser and never uploaded.
- **Correction view.** Inputs with the keys and bin-edge ranges found in the
  tree; live evaluation with the path the inputs take through the tree; plots
  against one input, as one curve, one curve per key of another input
  (e.g. per systematic variation), or a map against a second input; the
  structure of the tree; Python and C++ code for the same evaluation.

## Publishing a repository's corrections

```yaml
# .github/workflows/pages.yml
name: Pages
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0              # each file shows its last commit
      - uses: DickyChant/correctionlib-viewer@v1.0.0
        with:
          title: My corrections
      - uses: actions/upload-pages-artifact@v5
        with:
          path: _site
  deploy:
    needs: build
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-24.04
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```

Then set Pages to "GitHub Actions" in the repository settings. The action
needs `python3` and `node`, which GitHub's Ubuntu runners have.

| Input | Default | |
|---|---|---|
| `path` | `.` | the repository with the corrections |
| `output` | `_site` | directory to write the site to |
| `title` | `correctionlib viewer` | title of the page |
| `check` | `true` | compare the WebAssembly build with correctionlib's Python package on every correction (below) |

A correction file is any `*.json` or `*.json.gz` tracked by git outside
`.github/` whose top level has a `corrections` list. The README.md of its
directory is shown with it.

## How it evaluates

The page does not reimplement correctionlib. `wasm/build.sh` compiles
correctionlib's C++ evaluator (the version in `CORRECTIONLIB_VERSION`, every
node type including lwtnn) to WebAssembly with Emscripten, and
`wasm/bindings.cpp` exposes `load`, `evaluate` and scans over a grid to the
page. JavaScript (`js/schema.mjs`) only reads the JSON to describe it: input
domains, the tree, the path for given inputs.

The build is committed in `dist/`, so the action needs no compiler. CI rebuilds
it from source and fails unless the result is byte for byte the committed one.

With `check: true`, the action evaluates every correction of the repository
with the WebAssembly build and with correctionlib's Python package at the same
version. `tools/check_wasm.mjs` samples 3000 points per correction in each
input's domain, on bin edges, outside them and on missing keys, and
`tools/check_wasm.py` requires the same value (to 1e-12) or an error from both.
CI does the same on `tools/node_types.json`, a test file with every node type
except lwtnn.

One known difference: a `hashprng` node with the `stdnormal` distribution.
correctionlib draws it with `std::normal_distribution`, whose algorithm the C++
standard leaves to the library, so the WebAssembly build (libc++) returns
different numbers from a Linux build (libstdc++) for the same inputs. The page
says so when the inputs land on such a node, and the check compares only
errors there. `stdflat` and `normal` agree.

The page needs a browser with WebAssembly exception handling: Chrome 95,
Firefox 100, Safari 15.2 or newer. Plotly, marked and DOMPurify come from
cdnjs, at pinned versions.

## Local use

```sh
# The site for a repository, into _site
python3 tools/make_site.py --repo ../my-corrections --title "My corrections" _site
python3 -m http.server -d _site      # http://localhost:8000

# The check (needs node and `pip install correctionlib==$(cat CORRECTIONLIB_VERSION)`)
cd ../my-corrections
node ../correctionlib-viewer/tools/check_wasm.mjs /tmp/points.json \
  $(python3 ../correctionlib-viewer/tools/make_site.py --list-only)
python3 ../correctionlib-viewer/tools/check_wasm.py /tmp/points.json

# Rebuilding dist/; without a local emsdk, in its Docker image
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/src -w /src \
  emscripten/emsdk:4.0.10 wasm/build.sh
```

## Files

| Path | What |
|---|---|
| `index.html`, `css/`, `js/` | the page: `app.mjs` (views), `schema.mjs` (reading the JSON), `files.mjs` (gzip), `wasm.mjs` (loading the evaluator) |
| `dist/` | correctionlib in WebAssembly, and the licenses of the code compiled into it |
| `wasm/build.sh`, `wasm/bindings.cpp` | the WebAssembly build |
| `action.yml` | the GitHub Action |
| `tools/make_site.py` | stages the site and writes `manifest.json`, the list of correction files the page shows |
| `tools/check_wasm.mjs`, `tools/check_wasm.py` | the check against correctionlib's Python package |
| `tools/node_types.json` | test file with every node type except lwtnn; not a correction |

## License

BSD 3-Clause, see `LICENSE`. `dist/correctionlib.wasm` contains correctionlib
and the libraries it bundles; their licenses are in `dist/licenses/`.
