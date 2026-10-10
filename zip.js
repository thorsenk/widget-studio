/** Small UTF-8 ZIP writer using stored entries; no network or package runtime. */
export function zipFiles(files) {
  const encoder = new TextEncoder(), entries = [], central = [];
  let offset = 0;
  const header = size => new Uint8Array(size);
  const number = (bytes, position, value, width = 4) => {
    const view = new DataView(bytes.buffer);
    if (width === 2) view.setUint16(position, value, true);
    else view.setUint32(position, value >>> 0, true);
  };
  for (const [path, text] of Object.entries(files)) {
    if (path.startsWith('/') || path.split('/').includes('..') || typeof text !== 'string') throw Error('Invalid bundle file');
    const name = encoder.encode(path), data = encoder.encode(text);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = header(30 + name.length);
    number(local, 0, 0x04034b50); number(local, 4, 20, 2); number(local, 6, 0x800, 2); number(local, 12, 0x21, 2);
    number(local, 14, crc); number(local, 18, data.length); number(local, 22, data.length); number(local, 26, name.length, 2); local.set(name, 30);
    const directory = header(46 + name.length);
    number(directory, 0, 0x02014b50); number(directory, 4, 20, 2); number(directory, 6, 20, 2); number(directory, 8, 0x800, 2); number(directory, 14, 0x21, 2);
    number(directory, 16, crc); number(directory, 20, data.length); number(directory, 24, data.length); number(directory, 28, name.length, 2); number(directory, 42, offset); directory.set(name, 46);
    entries.push(local, data); central.push(directory); offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, bytes) => sum + bytes.length, 0), end = header(22);
  number(end, 0, 0x06054b50); number(end, 8, central.length, 2); number(end, 10, central.length, 2); number(end, 12, centralSize); number(end, 16, offset);
  const result = new Uint8Array(offset + centralSize + end.length);
  let position = 0;
  for (const bytes of [...entries, ...central, end]) { result.set(bytes, position); position += bytes.length; }
  return result;
}
