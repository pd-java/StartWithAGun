// wxapkg 解包工具：把解密后的 .bin 拆成文件树
// 支持经典格式: 0xBE + info1(u32) + indexLen(u32) + bodyLen(u32) + 0xED + fileCount(u32)
//   每项: nameLen(u32) + name + offset(u32) + size(u32)
// offset 若小于头部大小则视为相对数据区偏移，否则为绝对偏移
const fs = require('fs');
const path = require('path');

const [, , inFile, outDir] = process.argv;
if (!inFile || !outDir) {
  console.error('用法: node unpack-wxapkg.js <decrypted.bin> <outdir>');
  process.exit(1);
}
const buf = fs.readFileSync(inFile);
if (buf[0] !== 0xBE) {
  console.error('不是解密后的 wxapkg（缺 0xBE 头）');
  process.exit(1);
}

let p = 1;
const info1 = buf.readUInt32BE(p); p += 4;
const indexLen = buf.readUInt32BE(p); p += 4;
const bodyLen = buf.readUInt32BE(p); p += 4;
const lastMark = buf[p]; p += 1;
const fileCount = buf.readUInt32BE(p); p += 4;

console.log(`info1=${info1} indexLen=${indexLen} bodyLen=${bodyLen} lastMark=0x${lastMark.toString(16)} fileCount=${fileCount}`);
const dataStart = p + indexLen; // V1 中 offset 相对此处

let ok = 0, fail = 0;
for (let i = 0; i < fileCount; i++) {
  const nameLen = buf.readUInt32BE(p); p += 4;
  const name = buf.subarray(p, p + nameLen).toString('utf8'); p += nameLen;
  let offset = buf.readUInt32BE(p); p += 4;
  const size = buf.readUInt32BE(p); p += 4;
  // 判断绝对/相对偏移
  let abs = offset >= p ? offset : dataStart + offset;
  // 有些实现：offset 总是相对 index 结束
  if (abs + size > buf.length) abs = dataStart + offset;
  const content = buf.subarray(abs, abs + size);
  const target = path.join(outDir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(target, content);
    ok++;
  } catch (e) {
    console.error('写出失败:', name, e.message);
    fail++;
  }
}
console.log(`完成: ${ok} 个文件写出, ${fail} 失败`);
