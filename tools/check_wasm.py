"""Second half of the WebAssembly check: evaluates the points written by
check_wasm.mjs with correctionlib's Python package and compares.

    python3 tools/check_wasm.py points.json

A point passes when both evaluators fail, or both return the same value to a
relative 1e-12 (both NaN counts as the same). The WebAssembly build uses a
different libm, so the last bits of exp/log/pow may differ. Exits 1 on any
failure and prints the first few.

Points that land on a hashprng node with the 'stdnormal' distribution are
marked non-portable by check_wasm.mjs: correctionlib draws them with
std::normal_distribution, whose algorithm differs between libc++ (the
WebAssembly build) and libstdc++. For those only the errors are compared.
"""
import json
import math
import sys

import correctionlib

TOLERANCE = 1e-12


def main(path):
    data = json.load(open(path))
    print(f"WebAssembly correctionlib {data['correctionlib']}, Python correctionlib {correctionlib.__version__}")
    sets, targets = {}, {}
    failures, n_errors, n_stdnormal = [], 0, 0
    for p in data["points"]:
        if p["file"] not in sets:
            sets[p["file"]] = correctionlib.CorrectionSet.from_file(p["file"])
        key = (p["file"], p["correction"])
        if key not in targets:
            cset = sets[p["file"]]
            targets[key] = cset.compound[p["correction"]] if p["correction"] in cset.compound else cset[p["correction"]]
        target = targets[key]
        # JSON does not tell 1.0 from 1, so give each input its declared type.
        inputs = [float(x) if v.type == "real" else x for x, v in zip(p["inputs"], target.inputs)]
        try:
            value, error = target.evaluate(*inputs), None
        except Exception as e:
            value, error = None, str(e)
        if error is not None or p["error"] is not None:
            n_errors += error is not None
            ok = error is not None and p["error"] is not None
        elif not p.get("portable", True):
            n_stdnormal += 1
            ok = True
        else:
            wasm = float(p["value"])        # NaN and infinities arrive as strings
            ok = (math.isnan(value) and math.isnan(wasm)) or math.isclose(
                value, wasm, rel_tol=TOLERANCE, abs_tol=0.0)
        if not ok:
            failures.append((p, value, error))

    print(f"{len(data['points'])} points, {n_errors} of them errors in both, "
          f"{n_stdnormal} hashprng 'stdnormal' draws not compared, {len(failures)} disagree")
    for p, value, error in failures[:10]:
        print(f"  {p['file']} {p['correction']}{tuple(p['inputs'])}: "
              f"WebAssembly {p['value'] if p['error'] is None else 'error: ' + p['error']}, "
              f"Python {value if error is None else 'error: ' + error}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
