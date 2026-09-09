/*
 * ZoeWeb — minimal ZIP reader. Parses the central directory and inflates
 * individual entries with the browser's built-in DecompressionStream — no
 * external library. Enough to read the DDT4All ecu.zip database.
 */

const dv = buf => new DataView(buf);
const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;

/** Parse the central directory → [{name, method, compSize, size, offset}]. */
export function listZip(buf) {
  const d = dv(buf);
  // find End Of Central Directory (scan back from the end)
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (d.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no EOCD)');
  const count = d.getUint16(eocd + 10, true);
  let p = d.getUint32(eocd + 16, true); // central directory offset
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (d.getUint32(p, true) !== SIG_CEN) break;
    const method = d.getUint16(p + 10, true);
    const compSize = d.getUint32(p + 20, true);
    const size = d.getUint32(p + 24, true);
    const nameLen = d.getUint16(p + 28, true);
    const extraLen = d.getUint16(p + 30, true);
    const commentLen = d.getUint16(p + 32, true);
    const localOffset = d.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
    entries.push({ name, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflate one entry to text. */
export async function extractText(buf, entry) {
  const d = dv(buf);
  // local header: data starts after name + extra
  const nameLen = d.getUint16(entry.localOffset + 26, true);
  const extraLen = d.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const comp = new Uint8Array(buf, start, entry.compSize);
  if (entry.method === 0) return new TextDecoder().decode(comp);       // stored
  if (entry.method === 8) {                                            // deflate
    const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }
  throw new Error('unsupported zip compression method ' + entry.method);
}
