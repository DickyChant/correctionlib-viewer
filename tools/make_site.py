"""Stages the viewer and a repository's correction files into one directory,
for GitHub Pages or a local preview.

    python3 tools/make_site.py --repo PATH/TO/REPO [--title TITLE] _site
    python3 -m http.server -d _site        # then open http://localhost:8000

    python3 tools/make_site.py --repo PATH/TO/REPO --list-only   # just print the correction files

Copies the viewer (index.html, css/, js/, dist/) and every correctionlib file
of the repository under files/, together with the README.md of its directory
and of the repository root. Writes manifest.json, which lists each file with
its corrections and their inputs, so that the page can list them without
downloading every file.

Correction files are the *.json and *.json.gz files tracked by git, outside
.github/, whose top level has a "corrections" list.

--examples adds a set of example files from outside the repository, described
by a JSON file (see examples/): an archive to download, its sha256, and where
it comes from. A name without a path means examples/NAME.json of the viewer.
They are listed after the repository's own files.
"""
import argparse
import datetime
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path, PurePosixPath

VIEWER = Path(__file__).resolve().parents[1]
ROOT = Path(".")  # the repository with the corrections, set by --repo


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True,
                          check=True).stdout.strip()


def load(path):
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def repository():
    """owner/name on GitHub: from the Actions environment, else the origin remote."""
    if os.environ.get("GITHUB_REPOSITORY"):
        return os.environ["GITHUB_REPOSITORY"]
    try:
        url = git("remote", "get-url", "origin")
    except subprocess.CalledProcessError:
        return None
    m = re.search(r"github\.com[:/](.+?)(\.git)?$", url)
    return m.group(1) if m else None


def variables(items):
    return [{k: v[k] for k in ("name", "type", "description") if k in v} for v in items]


def describe(path, doc, size, commit=None, updated=None):
    corrections = [{"name": c["name"], "description": c.get("description"), "version": c.get("version"),
                    "inputs": variables(c["inputs"]), "output": variables([c["output"]])[0]}
                   for c in doc["corrections"]]
    corrections += [{"name": c["name"], "description": c.get("description"), "compound": True,
                     "inputs": variables(c["inputs"]), "output": variables([c["output"]])[0]}
                    for c in doc.get("compound_corrections") or []]
    return {
        "path": path,
        "size": size,
        "commit": commit,
        "updated": updated,
        "description": doc.get("description"),
        "corrections": corrections,
    }


def copy(rel, out):
    target = out / "files" / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / rel, target)


def correction_files(tracked):
    """(path, document) of every correction file among the tracked paths."""
    for rel in sorted(tracked):
        if not rel.endswith((".json", ".json.gz")) or rel.startswith(".github/"):
            continue
        try:
            doc = load(ROOT / rel)
        except (OSError, ValueError) as e:
            print(f"skipping {rel}: {e}", file=sys.stderr)
            continue
        if is_correction_set(doc):
            yield rel, doc


def is_correction_set(doc):
    return isinstance(doc, dict) and isinstance(doc.get("corrections"), list)


def examples(name, out):
    """Downloads one example set, checks its sha256, copies its correction files
    to out/files/examples/<id>/ and returns its manifest entry."""
    spec_path = Path(name) if name.endswith(".json") else VIEWER / "examples" / f"{name}.json"
    spec = json.loads(spec_path.read_text())
    ident = spec_path.stem
    with tempfile.TemporaryFile() as archive:
        digest = hashlib.sha256()
        with urllib.request.urlopen(spec["archive"], timeout=120) as r:
            while chunk := r.read(1 << 20):
                digest.update(chunk)
                archive.write(chunk)
        if digest.hexdigest() != spec["sha256"]:
            sys.exit(f"{spec['archive']}: sha256 {digest.hexdigest()}, expected {spec['sha256']}")
        archive.seek(0)
        files = []
        with tarfile.open(fileobj=archive) as tar:
            for member in tar:
                rel = PurePosixPath(member.name.removeprefix("./"))
                if (not member.isfile() or rel.is_absolute() or ".." in rel.parts
                        or not rel.name.endswith((".json", ".json.gz"))):
                    continue
                data = tar.extractfile(member).read()
                try:
                    doc = json.loads(gzip.decompress(data) if rel.name.endswith(".gz") else data)
                except ValueError as e:
                    print(f"skipping {ident}/{rel}: {e}", file=sys.stderr)
                    continue
                if not is_correction_set(doc):
                    continue
                path = f"examples/{ident}/{rel}"
                target = out / "files" / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                files.append(describe(path, doc, len(data)))
    files.sort(key=lambda f: f["path"])
    print(f"{ident}: {len(files)} correction file(s) from {spec['archive']}")
    return {k: spec.get(k) for k in ("title", "description", "source", "license")} | {"id": ident, "files": files}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("out", type=Path, nargs="?", help="directory to write (replaced)")
    ap.add_argument("--repo", type=Path, default=Path("."), help="git repository with the corrections (default: .)")
    ap.add_argument("--title", help="title of the page (default: correctionlib viewer)")
    ap.add_argument("--examples", action="append", default=[], metavar="NAME",
                    help="add an example set: a file like examples/*.json, or the name of one there")
    ap.add_argument("--dist", type=Path, default=VIEWER / "dist", help="WebAssembly build (wasm/build.sh)")
    ap.add_argument("--list-only", action="store_true", help="print the correction files and stop")
    args = ap.parse_args()
    global ROOT
    ROOT = args.repo.resolve()

    tracked = git("ls-files").splitlines()
    if args.list_only:
        for rel, _ in correction_files(tracked):
            print(rel)
        return
    if args.out is None:
        ap.error("give the output directory, or --list-only")

    missing = [f for f in ("correctionlib.mjs", "correctionlib.wasm") if not (args.dist / f).exists()]
    if missing:
        sys.exit(f"{args.dist} has no {', '.join(missing)}: run wasm/build.sh first")

    out = args.out
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    shutil.copy2(VIEWER / "index.html", out)
    shutil.copytree(VIEWER / "css", out / "css")
    shutil.copytree(VIEWER / "js", out / "js")
    shutil.copytree(args.dist, out / "dist")
    (out / ".nojekyll").touch()

    files = []
    for rel, doc in correction_files(tracked):
        entry = describe(rel, doc, (ROOT / rel).stat().st_size,
                         git("log", "-1", "--format=%H", "--", rel) or None,
                         git("log", "-1", "--format=%cI", "--", rel) or None)
        readme = str(Path(rel).parent / "README.md")
        if readme in tracked:
            entry["readme"] = readme
            copy(readme, out)
        copy(rel, out)
        files.append(entry)

    manifest = {
        "title": args.title or None,
        "repository": repository(),
        "commit": git("rev-parse", "HEAD"),
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "files": files,
        "examples": [examples(name, out) for name in args.examples],
    }
    if "README.md" in tracked:
        manifest["readme"] = "README.md"
        copy("README.md", out)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"wrote {out}: {len(files)} correction file(s), "
          f"{sum(len(f['corrections']) for f in files)} correction(s)")


if __name__ == "__main__":
    main()
