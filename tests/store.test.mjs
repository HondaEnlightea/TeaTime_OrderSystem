import {templateCatalog} from '../lib/catalog.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from '../lib/store.mjs';
import { DatabaseSync } from 'node:sqlite';

function fixture(t) { const s=createStore(':memory:', {catalog:templateCatalog()});t.after(()=>s.close());return s; }
function input(s,override={}) { return {requestId:randomUUID(),sessionId:s.currentSession().id,menuRevision:Number(s.getSetting('menuRevision')),items:[{productId:'black-01',quantity:2},{productId:'green-01',quantity:1}],tendered:1500,note:'ミルクは別添え',...override}; }

test('登録→完成→提供済み。正確な金額・状態・履歴・公開情報',t=>{
  const s=fixture(t),o=s.createOrder(input(s));
  assert.equal(o.label,'001');assert.equal(o.total,1200);assert.equal(o.change,300);
  assert.equal(s.publicState().orders[0].status,'waiting');
  assert.deepEqual(Object.keys(s.publicState().orders[0]).sort(),['label','number','status']);
  s.transition(o.id,'waiting','ready');assert.equal(s.publicState().orders[0].status,'ready');
  s.transition(o.id,'ready','served');assert.equal(s.publicState().orders.length,0);
  const state=s.state();assert.equal(state.totals.served,1);assert.equal(state.totals.revenue,1200);
  assert.deepEqual(s.history(o.id).map(h=>h.action),['registered','ready','served']);
});
test('同じ注文の再送は同じ番号。内容の変更は拒否',t=>{
  const s=fixture(t),payload=input(s),a=s.createOrder(payload),b=s.createOrder(payload);
  assert.equal(a.id,b.id);assert.equal(s.currentSession().next_number,2);
  assert.throws(()=>s.createOrder({...payload,note:'変更'}),/内容を変更/);
  const second=s.createOrder(input(s));assert.equal(second.number,2);
});
test('価格は親機で計算。メニュー更新後も注文価格は保持される',t=>{
  const s=fixture(t),o=s.createOrder(input(s,{total:1,price:1})),oldInput=input(s);
  s.saveMenu({revision:1,products:s.menu().map(p=>({...p,price:p.price+100}))});
  assert.equal(o.total,1200);assert.equal(s.order(o.id).total,1200);
  assert.throws(()=>s.createOrder(oldInput),/メニューが変更/);
  assert.equal(s.createOrder(input(s,{tendered:2000})).total,1500);
});
test('不正な注文では採番・明細・売上を一切更新しない',t=>{
  const s=fixture(t);
  for(const override of [{items:[]},{items:[{productId:'black-01',quantity:0}]},{items:[{productId:'black-01',quantity:1.5}]},{items:[{productId:'black-01',quantity:100}]},{items:[{productId:'missing',quantity:1}]},{items:[{productId:'black-01',quantity:1},{productId:'black-01',quantity:1}]},{tendered:1199},{tendered:1500.5},{note:'あ'.repeat(201)},{sessionId:'unknown'},{requestId:'x'}]){
    assert.throws(()=>s.createOrder(input(s,override)));
  }
  assert.equal(s.currentSession().next_number,1);assert.equal(s.state().totals.revenue,0);
  const products=s.menu().map(p=>({...p,active:false}));s.saveMenu({revision:1,products});
  assert.throws(()=>s.createOrder(input(s)),/販売停止/);
});
test('競合した完成登録で音声イベントが増えない。不正な遷移を拒否',t=>{
  const s=fixture(t),o=s.createOrder(input(s));
  assert.throws(()=>s.transition(o.id,'waiting','served'),/状態変更/);
  s.transition(o.id,'waiting','ready');
  assert.throws(()=>s.transition(o.id,'waiting','ready'),/別のスタッフ/);
  assert.equal(s.state().audio.pending,1);
  s.transition(o.id,'ready','served');assert.throws(()=>s.transition(o.id,'served','ready'));
});
test('取消理由・返金の履歴、売上の除外、番号を再利用しない',t=>{
  const s=fixture(t),o=s.createOrder(input(s));
  assert.throws(()=>s.transition(o.id,'waiting','cancelled',''),/取消理由/);
  s.transition(o.id,'waiting','cancelled','入力間違い・返金済み');
  assert.equal(s.state().totals.revenue,0);assert.equal(s.state().totals.cancelled,1);
  assert.equal(s.history(o.id).at(-1).reason,'入力間違い・返金済み');
  assert.equal(s.createOrder(input(s)).number,2);
});
test('営業回切替は未提供注文がある間は禁止。過去の履歴と番号を保持',t=>{
  const s=fixture(t),o=s.createOrder(input(s)),old=s.currentSession().id,payload=input(s);
  assert.throws(()=>s.newSession({previousId:old,name:'2日目'}),/未提供/);
  s.transition(o.id,'waiting','ready');s.transition(o.id,'ready','served');
  s.newSession({previousId:old,name:'2日目'});
  assert.equal(s.createOrder(input(s)).label,'001');assert.equal(s.state(old).totals.revenue,1200);
  assert.throws(()=>s.createOrder(payload),/営業回が変わりました/);
  assert.throws(()=>s.newSession({previousId:old,name:'重複'}),/すでに変わりました/);
  assert.throws(()=>s.transition(o.id,'served','ready'),/過去の営業回/);
});
test('複数表示画面の音声担当は1つ。再起動相当でも取得済みイベントを再生しない',t=>{
  const s=fixture(t),o=s.createOrder(input(s)),a=randomUUID(),b=randomUUID();s.transition(o.id,'waiting','ready');
  s.acquireAudio(a);assert.throws(()=>s.acquireAudio(b),/別の画面/);
  const call=s.claimCall(a);assert.equal(call.label,o.label);assert.equal(s.claimCall(a),null);
  assert.equal(s.state().audio.failed.length,0); // An actively playing announcement is not a failure.
  s.setting('audioExpires','0');s.acquireAudio(b);assert.equal(s.claimCall(b),null);
  assert.throws(()=>s.finishCall(call.id,b,true),/担当画面/);
  s.finishCall(call.id,a,false);assert.equal(s.state().audio.failed[0].status,'failed');
  const request=randomUUID();s.recall(o.id,request);s.recall(o.id,request);
  const recalled=s.claimCall(b);assert.equal(recalled.number,o.number);assert.equal(s.claimCall(b),null);
  s.finishCall(recalled.id,b,true);assert.throws(()=>s.finishCall(recalled.id,b,true),/登録済み/);
});
test('提供済みや取消の音声は呼び出さない',t=>{
  const s=fixture(t),o=s.createOrder(input(s)),consumer=randomUUID();
  s.transition(o.id,'waiting','ready');s.transition(o.id,'ready','served');s.acquireAudio(consumer);
  assert.equal(s.claimCall(consumer),null);assert.throws(()=>s.recall(o.id,randomUUID()),/提供可能/);
});
test('同時メニュー編集は競合を通知。既存の商品明細は削除されない',t=>{
  const s=fixture(t),o=s.createOrder(input(s)),products=s.menu().filter(p=>p.id!=='black-01');
  s.saveMenu({revision:1,products});assert.throws(()=>s.saveMenu({revision:1,products}),/別のスタッフ/);
  assert.equal(s.order(o.id).items.length,2);assert.equal(s.order(o.id).total,1200);
});
test('再起動・オンラインバックアップからの復元で注文・履歴・音声取得を保持',t=>{
  const directory=mkdtempSync(join(tmpdir(),'teatime-test-'));
  t.after(()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'teatime-test-'));rmSync(directory,{recursive:true,force:true});});
  const file=join(directory,'main.sqlite'),backup=join(directory,'backup.sqlite');
  let s=createStore(file, {catalog:templateCatalog()});const payload=input(s),o=s.createOrder(payload),consumer=randomUUID();
  s.transition(o.id,'waiting','ready');s.acquireAudio(consumer);const call=s.claimCall(consumer);s.backup(backup);s.close();
  s=createStore(file, {catalog:templateCatalog()});assert.equal(s.createOrder(payload).id,o.id);assert.equal(s.order(o.id).status,'ready');assert.equal(s.claimCall(consumer),null);assert.equal(s.history(o.id).length,2);s.close();
  s=createStore(backup, {catalog:templateCatalog()});assert.equal(s.order(o.id).total,1200);assert.equal(s.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');s.setting('audioExpires','0');assert.equal(s.state().audio.failed[0].id,call.id);s.close();
});
test('30枠を3茶種に分け、基本料金と有料オプションを明細ごとに保存する',t=>{
  const s=fixture(t);assert.equal(s.menu().length,30);
  for(const category of ['紅茶','ウーロン茶','緑茶'])assert.equal(s.menu().filter(p=>p.category===category).length,10);
  const o=s.createOrder(input(s,{items:[{productId:'black-01',quantity:2,ice:true,milk:true,icePrice:1},{productId:'black-01',quantity:1,ice:false,milk:false}],tendered:2000}));
  assert.equal(o.total,1400);assert.equal(o.change,600);assert.equal(o.items.length,2);
  assert.deepEqual(o.items.map(i=>i.unit_price),[500,400]);assert.equal(o.items[0].ice_price,50);assert.equal(o.items[0].milk_price,50);
  assert.equal(s.state().totals.products.reduce((n,p)=>n+p.total,0),1400);
  s.saveMenu({revision:1,products:s.menu().map(p=>({...p,price:600}))});assert.equal(s.order(o.id).total,1400);
  assert.throws(()=>s.createOrder(input(s,{items:[{productId:'black-01',quantity:1,ice:'true'}]})),/オプション/);
});
test('独立キッチンは紙の番号を保持し、再送と既存番号の衝突を防ぎ、売上に含めない',t=>{
  const s=fixture(t),payload={requestId:randomUUID(),sessionId:s.currentSession().id,number:42,note:'紅茶 茶葉01 ×2 氷あり'},o=s.createPaperOrder(payload);
  assert.equal(o.label,'042');assert.equal(o.source,'paper');assert.equal(s.createPaperOrder(payload).id,o.id);
  assert.equal(s.state().totals.revenue,0);assert.equal(s.state().totals.orders,0);assert.equal(s.state().totals.paper,1);assert.equal(s.state().totals.waiting,1);
  assert.throws(()=>s.createPaperOrder({...payload,requestId:randomUUID()}),/登録済み/);
  s.transition(o.id,'waiting','ready');assert.equal(s.state().audio.pending,1);s.transition(o.id,'ready','served');
  assert.throws(()=>s.createPaperOrder({...payload,requestId:randomUUID()}),/登録済み/);
  for(const number of [0,1.5,10000])assert.throws(()=>s.createPaperOrder({...payload,requestId:randomUUID(),number}));
  assert.equal(s.createOrder(input(s)).number,43);
  s.transition(s.state().orders[0].id,'waiting','cancelled','試験終了');
  s.newSession({name:'再開',previousId:payload.sessionId,startNumber:70});assert.equal(s.createOrder(input(s)).number,70);
});
test('旧DBを移行しても既存明細・金額・状態・履歴・番号を保つ',t=>{
  const directory=mkdtempSync(join(tmpdir(),'teatime-test-')),file=join(directory,'legacy.sqlite');
  t.after(()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'teatime-test-'));rmSync(directory,{recursive:true,force:true});});
  let s=createStore(file, {catalog:templateCatalog()});
  s.saveMenu({revision:1,products:[['tea','紅茶',300,'ドリンク'],['milk-tea','ミルクティー',350,'ドリンク'],['coffee','コーヒー',300,'ドリンク'],['scone','スコーン',250,'フード'],['cake','ケーキ',400,'フード']].map(([id,name,price,category])=>({id,name,price,category,active:true}))});
  const payload=input(s,{items:[{productId:'tea',quantity:2},{productId:'scone',quantity:1}],tendered:1000}),o=s.createOrder(payload);s.transition(o.id,'waiting','ready');s.close();
  const db=new DatabaseSync(file);db.exec(`ALTER TABLE order_items RENAME TO items_new;
    CREATE TABLE order_items(order_id TEXT NOT NULL REFERENCES orders(id),product_id TEXT NOT NULL,name TEXT NOT NULL,price INTEGER NOT NULL,quantity INTEGER NOT NULL,PRIMARY KEY(order_id,product_id));
    INSERT INTO order_items SELECT order_id,product_id,name,price,quantity FROM items_new;DROP TABLE items_new;
    ALTER TABLE orders DROP COLUMN source;ALTER TABLE orders DROP COLUMN fulfillment;`);db.close();
  s=createStore(file, {catalog:templateCatalog()});try{const saved=s.order(o.id);assert.equal(saved.total,850);assert.equal(saved.status,'ready');assert.equal(saved.items[0].ice,null);assert.equal(saved.items[0].unit_price,300);assert.equal(s.menu().length,30);assert.equal(s.createOrder(payload).id,o.id);assert.equal(s.currentSession().next_number,2);assert.equal(s.history(o.id).length,2);assert.equal(s.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{s.close();}
});

test('茶葉説明・新規メニュー・売り切れを保存し、旧クライアント更新でも説明と過去の会計を保つ',t=>{
  const s=fixture(t),o=s.createOrder(input(s));
  const products=s.menu().map(p=>({...p,description:'香りの説明\nミルクがおすすめ。',...(p.id==='black-01'?{active:false,price:600}:{})}));
  products.push({id:'new-tea',name:'新しい紅茶',category:'紅茶',price:500,active:true,description:'すっきりした味。'});
  s.saveMenu({revision:1,products});
  assert.equal(s.menu().length,31);assert.equal(s.menu().find(p=>p.id==='new-tea').description,'すっきりした味。');
  assert.throws(()=>s.createOrder(input(s)),/販売/);
  assert.equal(s.order(o.id).total,1200);
  const withoutDescription=s.menu().map(({description,...p})=>p);s.saveMenu({revision:2,products:withoutDescription});
  assert.equal(s.menu().find(p=>p.id==='black-01').description,'香りの説明\nミルクがおすすめ。');
  assert.throws(()=>s.saveMenu({revision:3,products:s.menu().map(p=>({...p,description:'あ'.repeat(2001)}))}),/2000/);
  assert.equal(Number(s.getSetting('menuRevision')),3);
  assert.throws(()=>s.saveMenu({revision:2,products:s.menu()}),/別のスタッフ/);
});
function reservation(s,terminalId='terminal-test-0001'){
  const state=s.state();return s.reserveNumbers({requestId:randomUUID(),terminalId,serverId:state.serverId,sessionId:state.currentSessionId,menuRevision:state.menuRevision});
}
function offlineOrder(r,number=r.start){return {requestId:randomUUID(),reservationId:r.id,terminalId:r.terminalId,serverId:r.serverId,sessionId:r.sessionId,menuRevision:r.menuRevision,number,acceptedAt:new Date().toISOString(),quotedTotal:500,items:[{productId:'black-01',quantity:1,ice:true,milk:true}],tendered:1000,note:'切断中の受付'};}
test('予備番号は再送可能・複数端末と通常採番で重複しない。保存時の料金で切断後の会計を検証',t=>{
  const s=fixture(t),state=s.state(),request={requestId:randomUUID(),terminalId:'terminal-test-0001',serverId:state.serverId,sessionId:state.currentSessionId,menuRevision:state.menuRevision};
  const a=s.reserveNumbers(request),retry=s.reserveNumbers(request),b=reservation(s,'terminal-test-0002');
  assert.equal(a.id,retry.id);assert.deepEqual([a.start,a.end,b.start,b.end],[1,50,51,100]);
  assert.equal(s.state().totals.orders,0);assert.equal(s.createOrder(input(s)).number,101);
  s.saveMenu({revision:1,products:s.menu().map(p=>({...p,price:600,active:false}))});
  const payload=offlineOrder(a),sale=s.createOrder(payload);assert.equal(sale.total,500);assert.equal(sale.number,1);assert.equal(s.createOrder(payload).id,sale.id);
  assert.throws(()=>s.createOrder({...offlineOrder(a,2),quotedTotal:1}),/会計金額/);
  assert.throws(()=>s.createOrder({...offlineOrder(a,2),terminalId:b.terminalId}),/予備番号/);
  assert.throws(()=>s.createOrder(offlineOrder(a,51)),/範囲/);
  assert.throws(()=>s.createOrder({...payload,note:'別内容'}),/内容を変更/);
  assert.equal(s.currentSession().next_number,102);
});
test('LANの紙番号を先に完成・提供しても会計同期で同じ注文・状態・音声履歴を維持する',t=>{
  const s=fixture(t),r=reservation(s),paperInput={requestId:randomUUID(),sessionId:r.sessionId,number:r.start,note:'紙の内容'},paper=s.createPaperOrder(paperInput);
  s.transition(paper.id,'waiting','ready');s.transition(paper.id,'ready','served');
  const beforeCalls=s.db.prepare('SELECT COUNT(*) AS n FROM calls').get().n;
  const payload=offlineOrder(r),sale=s.createOrder(payload);
  assert.equal(sale.id,paper.id);assert.equal(sale.status,'served');assert.equal(sale.source,'cashier');assert.equal(sale.total,500);
  assert.equal(s.createOrder(payload).id,paper.id);assert.equal(s.createPaperOrder(paperInput).id,paper.id);
  assert.equal(s.state().totals.orders,1);assert.equal(s.state().totals.revenue,500);assert.equal(s.state().totals.cups,1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM calls').get().n,beforeCalls);
  assert.deepEqual(s.history(paper.id).map(h=>h.action),['registered','ready','served','accounted']);
  const refund={requestId:randomUUID(),id:paper.id,terminalId:r.terminalId,serverId:r.serverId,reason:'切断中に返金済み'};
  s.cancelReserved(refund);s.cancelReserved(refund);assert.equal(s.state().totals.revenue,0);assert.equal(s.history(paper.id).filter(h=>h.action==='cancelled').length,1);
});
test('予備番号は明示終了まで営業回切り替えを防ぎ、終了後の再利用を拒否する',t=>{
  const s=fixture(t),r=reservation(s);
  assert.throws(()=>s.newSession({previousId:r.sessionId,name:'翌日'}),/予備番号/);
  s.closeReservation({id:r.id,terminalId:r.terminalId,serverId:r.serverId});
  assert.throws(()=>s.createOrder(offlineOrder(r)),/予備番号/);
  const next=s.newSession({previousId:r.sessionId,name:'翌日'});assert.notEqual(next.id,r.sessionId);
});
