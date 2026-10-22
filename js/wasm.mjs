// correctionlib compiled to WebAssembly (wasm/build.sh). The module is
// loaded once; each correction set gets its own Evaluator.

let module = null;

export function correctionlib() {
  module ??= import(new URL('../dist/correctionlib.mjs', import.meta.url).href).then((m) => m.default());
  return module;
}

// Parses `text` into a new Evaluator. Returns {evaluator} or {error}.
export async function makeEvaluator(text) {
  const lib = await correctionlib();
  const evaluator = new lib.Evaluator();
  const error = evaluator.load(text);
  if (error) {
    evaluator.delete();
    return { error };
  }
  return { evaluator };
}
