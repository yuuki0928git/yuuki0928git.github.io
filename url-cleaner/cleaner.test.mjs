import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrl } from './cleaner.mjs';
test('known tracking, encoded names, duplicates and count', () => {
 const r = cleanUrl('https://example.com/?utm_source=a&%66bclid=x&utm_source=b&gclid=z&q=test');
 assert.equal(r.url, 'https://example.com/?q=test'); assert.equal(r.removed.length, 4);
 assert.deepEqual(r.removed[0], {name:'utm_source',value:'a'});
});
test('preserve raw encoding, repeated keys, empty values, fragment and functional parameters', () => {
 const url='https://example.com/watch?v=abc&t=120&list=xyz&q=a%20b%2fc&q=a+b&empty=&flag&ref=needed&source=needed#utm_source=keep';
 assert.equal(cleanUrl(url+'&nothing').url,url+'&nothing');
 assert.equal(cleanUrl(url.replace('#','&fbclid=remove#')).url,url);
});
test('Amazon region and subdomain tracking only', () => {
 const url='https://www.amazon.co.jp/dp/B012345678?tag=abc&linkCode=x&ref_=abc&th=1&psc=1&smid=seller';
 assert.equal(cleanUrl(url).url,'https://www.amazon.co.jp/dp/B012345678?th=1&psc=1&smid=seller');
 for(const host of ['example.com','amazon.co.jp.evil.com','fakeamazon.com']) assert.equal(cleanUrl(url.replace('www.amazon.co.jp',host)).removed.length,0);
});
test('reject unsafe schemes and invalid URL', () => {
 for(const url of ['javascript:alert(1)','data:text/html,test','file:///etc/passwd','ftp://example.com','//example.com','example.com','https://','https://exa mple.com','https://example.com/\nfoo']) assert.throws(()=>cleanUrl(url));
});
test('protect common signed URLs', () => {
 for(const key of ['X-Amz-Signature','X-Goog-Credential','sig','token','Signature','Policy']) {
 const url='https://example.com/?utm_source=keep&'+key+'=secret%2fvalue';
 assert.deepEqual(cleanUrl(url),{url,removed:[],protected:true});
 }
});
test('no needless serialization and no empty question mark after removal', () => {
 for(const url of ['HTTP://EXAMPLE.COM','https://example.com/?','https://example.com/path#anchor']) assert.equal(cleanUrl(url).url,url);
 assert.equal(cleanUrl('https://example.com/?utm_medium=x#anchor').url,'https://example.com/#anchor');
 assert.equal(cleanUrl('https://example.com/?UTM_SOURCE=x&MSCLKID=y').removed.length,2);
});
