#!/bin/bash
# Compiles correctionlib's C++ evaluator to WebAssembly for the viewer.
#
#   wasm/build.sh [OUTDIR]        default OUTDIR: dist
#
# Writes OUTDIR/correctionlib.mjs, OUTDIR/correctionlib.wasm and, under
# OUTDIR/licenses, the licenses of the code compiled in. Needs em++ (emsdk) on
# PATH, plus git and curl. Without a local emsdk, run it in the image CI uses:
#
#   docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/src -w /src \
#     emscripten/emsdk:4.0.10 wasm/build.sh
#
# The correctionlib version is the one in CORRECTIONLIB_VERSION. The sources are
# fetched into wasm/.build (git-ignored) and reused on the next run. correctionlib is built whole, including the lwtnn node type, so
# every correction the Python and C++ libraries can evaluate also evaluates
# here. Gzipped files are inflated by the page, so zlib is not needed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CORRECTIONLIB_VERSION="$(cat "${HERE}/../CORRECTIONLIB_VERSION")"
EIGEN_VERSION=3.4.0

OUT="$(mkdir -p "${1:-${HERE}/../dist}" && cd "${1:-${HERE}/../dist}" && pwd)"
WORK="${HERE}/.build"
SRC="${WORK}/correctionlib-${CORRECTIONLIB_VERSION}"
EIGEN="${WORK}/eigen-${EIGEN_VERSION}"
mkdir -p "${WORK}"

if [ ! -f "${SRC}/include/correction.h" ]; then
  rm -rf "${SRC}"
  git -c advice.detachedHead=false clone -q --depth 1 \
    -b "v${CORRECTIONLIB_VERSION}" \
    https://github.com/cms-nanoAOD/correctionlib.git "${SRC}"
  git -C "${SRC}" submodule update -q --init --depth 1 \
    rapidjson cpp-peglib pcg-cpp xxhash lwtnn
fi
if [ ! -f "${EIGEN}/Eigen/Dense" ]; then
  rm -rf "${EIGEN}"
  curl -sSfL "https://gitlab.com/libeigen/eigen/-/archive/${EIGEN_VERSION}/eigen-${EIGEN_VERSION}.tar.gz" \
    | tar -xz -C "${WORK}"
fi

# CMake normally writes this header from include/version.h.in.
mkdir -p "${WORK}/include"
IFS=. read -r MAJOR MINOR _ <<< "${CORRECTIONLIB_VERSION}"
sed -e "s/@CORRECTIONLIB_SKBUILD_PROJECT_VERSION@/${CORRECTIONLIB_VERSION}/" \
    -e "s/@CORRECTIONLIB_VERSION_MAJOR@/${MAJOR}/" \
    -e "s/@CORRECTIONLIB_VERSION_MINOR@/${MINOR}/" \
    "${SRC}/include/version.h.in" > "${WORK}/include/correctionlib_version.h"

LWTNN_SOURCES=()
for f in Exceptions LightweightNeuralNetwork LightweightGraph NanReplacer \
         FastInputPreprocessor FastGraph Stack lightweight_nn_streamers parse_json; do
  LWTNN_SOURCES+=("${SRC}/lwtnn/src/${f}.cxx")
done

# -fwasm-exceptions: correctionlib reports bad input and bad JSON by throwing,
# and the bindings catch those to hand the message to the page.
em++ -std=c++17 -O2 -fwasm-exceptions \
  -sUSE_BOOST_HEADERS=1 \
  -I "${WORK}/include" -I "${SRC}/include" -I "${SRC}/src" \
  -I "${SRC}/rapidjson/include" -I "${SRC}/cpp-peglib" -I "${SRC}/xxhash" \
  -I "${SRC}/pcg-cpp/include" -I "${SRC}/lwtnn/include" -I "${EIGEN}" \
  "${SRC}/src/correction.cc" "${SRC}/src/formula_ast.cc" \
  "${SRC}/src/detail_impl.cc" "${SRC}/src/lwtnn.cc" \
  "${LWTNN_SOURCES[@]}" \
  "${HERE}/bindings.cpp" \
  -lembind \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createCorrectionlib \
  -sENVIRONMENT=web,node -sALLOW_MEMORY_GROWTH=1 \
  -o "${OUT}/correctionlib.mjs"

# The wasm file is correctionlib and these libraries in binary form.
rm -rf "${OUT}/licenses"
mkdir -p "${OUT}/licenses"
cp "${SRC}/LICENSE" "${OUT}/licenses/correctionlib.txt"
cp "${SRC}/rapidjson/license.txt" "${OUT}/licenses/rapidjson.txt"
cp "${SRC}/cpp-peglib/LICENSE" "${OUT}/licenses/cpp-peglib.txt"
cp "${SRC}/pcg-cpp/LICENSE-MIT.txt" "${OUT}/licenses/pcg-cpp.txt"
cp "${SRC}/xxhash/LICENSE" "${OUT}/licenses/xxhash.txt"
cp "${SRC}/lwtnn/LICENSE" "${OUT}/licenses/lwtnn.txt"
cp "${EIGEN}/COPYING.MPL2" "${OUT}/licenses/eigen.txt"

echo "wrote ${OUT}/correctionlib.mjs and correctionlib.wasm (correctionlib ${CORRECTIONLIB_VERSION})"
