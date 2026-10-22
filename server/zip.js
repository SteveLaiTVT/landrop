"use strict";

/**
 * 极简 zip 读写。只依赖 node:zlib，不引第三方库。
 * 用途有两个：预览 Office 文档（docx/xlsx/pptx 本质是 zip）、把 Skill 打包成 zip 导出。
 */

const zlib = require("node:zlib");

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEocd(buf) {
  const min = 22;
  const max = Math.min(buf.length, 0xffff + min);
  for (let i = buf.length - min; i >= buf.length - max && i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 列出 zip 内的条目（不展开数据）。
 * @returns {Array<{name:string, size:number, packedSize:number, method:number, offset:number, isDir:boolean}>}
 */
function listZipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("不是有效的 zip 文件");
  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < total; i += 1) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CEN_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const packedSize = buf.readUInt32LE(ptr + 20);
    const size = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const offset = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    entries.push({ name, size, packedSize, method, offset, isDir: name.endsWith("/") });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 取出单个条目的原始 Buffer。 */
function readZipEntry(buf, entry) {
  if (entry.method === 0) {
    const start = entry.offset + 30;
    return buf.slice(start, start + entry.packedSize);
  }
  if (entry.method !== 8) throw new Error(`不支持的压缩方式：${entry.method}`);
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const packed = buf.slice(start, start + entry.packedSize);
  return zlib.inflateRawSync(packed);
}

/** 按名字读一个条目，找不到返回 null。 */
function readZipFile(buf, name) {
  const entries = listZipEntries(buf);
  const entry = entries.find((e) => e.name === name);
  if (!entry) return null;
  return readZipEntry(buf, entry);
}

/** 按前缀批量读条目（用于 ppt/slides/slideN.xml 这种）。 */
function readZipByPrefix(buf, prefix, suffix = "") {
  const entries = listZipEntries(buf);
  return entries
    .filter((e) => !e.isDir && e.name.startsWith(prefix) && e.name.endsWith(suffix))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))
    .map((e) => ({ name: e.name, data: readZipEntry(buf, e) }));
}

/* ---------------- 写 zip ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

/**
 * 写出 zip。
 * @param {Array<{name:string, data:Buffer|string}>} files
 * @returns {Buffer}
 */
function writeZip(files, date = new Date()) {
  const { time, day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "utf8");
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOC_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CEN_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

module.exports = { listZipEntries, readZipEntry, readZipFile, readZipByPrefix, writeZip, crc32 };
