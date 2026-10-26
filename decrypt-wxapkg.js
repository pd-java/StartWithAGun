// wxapkg 解密工具（V1MMWX 格式，PC 微信小游戏/小程序包）
// 算法:
//   [0..5]   magic "V1MMWX"
//   [6..1029] AES-256-CBC 加密（解密后取前 1023 字节）
//             key = PBKDF2(password=appid, salt="saltiest", iter=1000, keylen=32, sha1)
//             iv  = "the iv: 16 bytes"
//   [1030..] XOR，密钥 = ord(appid[-2])
// 解密后为标准 wxapkg（0xBE 开头）
const fs = require('fs');
const crypto = require('crypto');

const [, , appid, inFile, outFile] = process.argv;
if (!appid || !inFile || !outFile) {
  console.error('用法: node decrypt-wxapkg.js <appid> <in.wxapkg> <out.bin>');
  process.exit(1);
}

const raw = fs.readFileSync(inFile);
if (!raw.subarray(0, 6).equals(Buffer.from('V1MMWX'))) {
  console.error('非 V1MMWX 格式，按明文复制');
  fs.writeFileSync(outFile, raw);
  process.exit(0);
}

const key = crypto.pbkdf2Sync(appid, 'saltiest', 1000, 32, 'sha1');
const iv = Buffer.from('the iv: 16 bytes');

const encHead = raw.subarray(6, 6 + 1024);
const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
d.setAutoPadding(false);
const head = Buffer.concat([d.update(encHead), d.final()]).subarray(0, 1023);

const xorKey = appid.length >= 2 ? appid.charCodeAt(appid.length - 2) : 0x66;
const tail = Buffer.from(raw.subarray(6 + 1024));
for (let i = 0; i < tail.length; i++) tail[i] ^= xorKey;

const out = Buffer.concat([head, tail]);
fs.writeFileSync(outFile, out);
console.log(`解密完成: ${outFile} (${out.length} bytes), 头: ${out.subarray(0, 4).toString('hex')}, xor=0x${xorKey.toString(16)}`);
