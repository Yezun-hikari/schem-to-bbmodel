// Minimal big-endian NBT reader (Java Edition). Returns the root compound as plain JS values.
// Compounds -> objects, lists -> arrays, byte/int/long arrays -> typed arrays, longs -> BigInt.

export async function readNbt(buffer) {
  let bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  let p = 0;

  const str = () => {
    const len = view.getUint16(p); p += 2;
    const s = dec.decode(bytes.subarray(p, p + len)); p += len;
    return s;
  };

  function payload(type) {
    switch (type) {
      case 1: return view.getInt8(p++);
      case 2: { const v = view.getInt16(p); p += 2; return v; }
      case 3: { const v = view.getInt32(p); p += 4; return v; }
      case 4: { const v = view.getBigInt64(p); p += 8; return v; }
      case 5: { const v = view.getFloat32(p); p += 4; return v; }
      case 6: { const v = view.getFloat64(p); p += 8; return v; }
      case 7: { const n = view.getInt32(p); p += 4; const a = new Int8Array(bytes.buffer.slice(bytes.byteOffset + p, bytes.byteOffset + p + n)); p += n; return a; }
      case 8: return str();
      case 9: {
        const t = view.getInt8(p++); const n = view.getInt32(p); p += 4;
        const a = new Array(Math.max(n, 0));
        for (let i = 0; i < n; i++) a[i] = payload(t);
        return a;
      }
      case 10: {
        const o = {};
        for (;;) {
          const t = view.getInt8(p++);
          if (t === 0) return o;
          const name = str();
          o[name] = payload(t);
        }
      }
      case 11: { const n = view.getInt32(p); p += 4; const a = new Int32Array(n); for (let i = 0; i < n; i++, p += 4) a[i] = view.getInt32(p); return a; }
      case 12: { const n = view.getInt32(p); p += 4; const a = new BigInt64Array(n); for (let i = 0; i < n; i++, p += 8) a[i] = view.getBigInt64(p); return a; }
      default: throw new Error('Unbekannter NBT-Tag-Typ ' + type + ' bei Byte ' + p);
    }
  }

  const rootType = view.getInt8(p++);
  if (rootType !== 10) throw new Error('Keine gültige NBT-Datei (Root ist kein Compound).');
  const rootName = str();
  return { name: rootName, value: payload(10) };
}
