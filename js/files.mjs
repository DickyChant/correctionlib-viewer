// Turning bytes into correctionlib JSON text. Gzipped files (.json.gz) are
// recognised by their magic number, not their name, and inflated with the
// browser's own DecompressionStream.

function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function textFromBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (!isGzip(bytes)) return new TextDecoder().decode(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export async function textFromFile(file) {
  return textFromBytes(await file.arrayBuffer());
}

export async function textFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return textFromBytes(await response.arrayBuffer());
}
