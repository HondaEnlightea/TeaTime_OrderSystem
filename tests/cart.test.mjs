import {templateCatalog} from '../lib/catalog.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {separateCups,groupCups,appendCup,toggleCup} from '../public/cart.js';
import {createStore} from '../lib/store.mjs';
import {buildLocalSale} from '../public/offline.js';

test('同じ茶葉を押すたびに1杯を追加し、後の1杯のオプション変更が先の1杯を変えない',()=>{
  const first=appendCup([],'black-01'),two=appendCup(first,'black-01'),mixed=toggleCup(two,1,'milk');
  assert.equal(first.length,1);assert.equal(mixed.length,2);
  assert.deepEqual(mixed.map(i=>[i.quantity,i.milk]),[[1,false],[1,true]]);
  assert.deepEqual(two.map(i=>i.milk),[false,false]);
  const same=toggleCup(mixed,0,'milk');assert.equal(same.length,2);
  assert.deepEqual(groupCups(same),[{productId:'black-01',quantity:2,ice:false,milk:true}]);
});
test('1杯ずつの画面入力を登録時に集約し、従来のキッチン明細・料金・売上集計を維持する',t=>{
  let rows=[];for(let n=0;n<4;n++)rows=appendCup(rows,'black-01');
  rows=toggleCup(toggleCup(toggleCup(rows,1,'milk'),2,'milk'),3,'ice');
  const items=groupCups(rows),store=createStore(':memory:', {catalog:templateCatalog()});t.after(()=>store.close());const s=store.state();
  const input={requestId:randomUUID(),sessionId:s.currentSessionId,menuRevision:s.menuRevision,items,tendered:2000,note:''};
  const local=buildLocalSale(input,{catalog:s.menu,optionPrice:50});
  const order=store.createOrder(input),state=store.state();
  assert.equal(rows.length,4);assert.deepEqual(items.map(i=>i.quantity),[1,2,1]);
  assert.equal(order.items.length,3);assert.deepEqual(order.items.map(i=>i.quantity),[1,2,1]);
  assert.equal(local.total,1750);assert.equal(order.total,1750);assert.equal(order.change,250);
  assert.equal(state.totals.cups,4);assert.equal(state.totals.revenue,1750);
  assert.deepEqual(state.totals.byCupCount,[{cups:4,orders:1,revenue:1750}]);
});
test('旧下書きの数量を1杯ずつ復元し、元の記録と99杯制限を維持する',()=>{
  const legacy=[{productId:'black-01',quantity:2,ice:false,milk:false},{productId:'black-01',quantity:1,ice:false,milk:true}],saved=structuredClone(legacy);
  const rows=separateCups(legacy);assert.equal(rows.length,3);assert.deepEqual(groupCups(rows),legacy);assert.deepEqual(legacy,saved);
  assert.deepEqual(separateCups(rows),rows);
  const many=separateCups([{productId:'black-01',quantity:99,ice:false,milk:true},{productId:'black-01',quantity:1,ice:false,milk:false}]);
  assert.throws(()=>toggleCup(many,99,'milk'),/99杯/);assert.equal(many[99].milk,false);
  assert.throws(()=>separateCups([{productId:'black-01',quantity:0}]),/杯数/);
});
