import {test} from 'node:test';import assert from 'node:assert/strict';import {findSetupEntries} from '../web/zip-setup.js';
const entries=(prefix='')=>[{name:prefix+'mapping.json'},{name:prefix+'__converter/reference_converter.py'},{name:prefix+'samplever1.0.txt'}];
test('直下・1階層・複数階層の設定を同じフォルダから読む',()=>{for(const prefix of ['', 'logs/', 'download/logs/']){const e=entries(prefix),r=findSetupEntries(e);assert.equal(r.mapping,e[0]);assert.equal(r.reference,e[1]);}});
test('複数設定または異なるフォルダの設定を混ぜない',()=>{assert.throws(()=>findSetupEntries([...entries(),...entries('other/')]),/複数/);assert.throws(()=>findSetupEntries([{name:'mapping.json'},{name:'other/__converter/reference_converter.py'}]),/一致/);});
