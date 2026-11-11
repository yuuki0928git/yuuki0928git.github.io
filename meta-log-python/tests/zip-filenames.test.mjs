import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zipSync} from '../web/vendor/fflate-0.8.2.js';
import {indexZip,readEntry,crc32} from '../web/zip-reader.js';
const enc=s=>new TextEncoder().encode(s);
function unflag(bytes){const b=bytes.slice(),v=new DataView(b.buffer);for(let p=0;p+10<b.length;p++){const sig=v.getUint32(p,true);if(sig===0x04034b50)v.setUint16(p+6,v.getUint16(p+6,true)&~2048,true);if(sig===0x02014b50)v.setUint16(p+8,v.getUint16(p+8,true)&~2048,true);}return b;}
test('UTF-8フラグなしの日本語・絵文字パスをそのまま読める',async()=>{const body=enc('合成本文');const blob=new Blob([unflag(zipSync({'会話😀/message_1.json':body,'写真/画像.jpg':enc('media')}))]);const entries=await indexZip(blob);assert.equal(entries[0].name,'会話😀/message_1.json');assert.deepEqual(await readEntry(blob,entries[0]),body);});
test('CRCが一致するUnicode Path拡張を使い、ローカル名は元バイト列と照合する',async()=>{const name=enc('会話/合成ver1.0.txt'),extra=new Uint8Array(5+name.length);extra[0]=1;new DataView(extra.buffer).setUint32(1,crc32(enc('legacy')),true);extra.set(name,5);const blob=new Blob([zipSync({legacy:[enc('exact bytes'),{extra:{0x7075:extra}}]})]);const entries=await indexZip(blob);assert.equal(entries[0].name,'会話/合成ver1.0.txt');assert.deepEqual(await readEntry(blob,entries[0]),enc('exact bytes'));});
test('不明な文字コードを推測で変換しない',async()=>{const bytes=unflag(zipSync({'xx':enc('body')}));const v=new DataView(bytes.buffer);for(let p=0;p+46<bytes.length;p++){if(v.getUint32(p,true)===0x04034b50)bytes[p+30]=0xff;if(v.getUint32(p,true)===0x02014b50)bytes[p+46]=0xff;}await assert.rejects(indexZip(new Blob([bytes])),/文字コード/);});
