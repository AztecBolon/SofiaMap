import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
const src=fs.readFileSync(new URL('../lib/metro-data.ts',import.meta.url),'utf8');
test('без московских данных',()=>assert.ok(!/Арбат|Москва|Сокольник/i.test(src)));
test('4 цвета линий',()=>['#e4252c','#1677b8','#168f62','#e8ad18'].forEach(c=>assert.ok(src.includes(c))));
test('устойчивые segment ids',()=>assert.ok(src.includes('ride-${line}-${from}-${ids[i+1]}')));
test('время явно оценочное',()=>assert.ok(src.includes('estimated:true')));
