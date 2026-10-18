import {templateCatalog} from '../lib/catalog.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStore} from '../lib/store.mjs';
import {createOfflineRegister} from '../public/offline.js';
import {csvText,detailCsvRows,salesSummary} from '../lib/reports.mjs';
function memoryStorage(){
  const values=new Map();let serial=Promise.resolve();
  return {get:async key=>structuredClone(values.get(key)),cache:async value=>values.set('snapshot',structuredClone(value)),update(fn){const operation=serial.then(()=>{const b=fn(structuredClone(values.get('book')));values.set('book',structuredClone(b));return structuredClone(b);});serial=operation.catch(()=>{});return operation;}};
}
async function fixture(t){
  const server=createStore(':memory:', {catalog:templateCatalog()});t.after(()=>server.close());let online=true,loseReply=false;
  const storage=memoryStorage();
  const api=async(path,body)=>{
    if(!online)throw Object.assign(Error('通信切断'),{network:true});
    try{
      let result;
      if(path==='/api/offline/reserve')result=server.reserveNumbers(body);
      if(path==='/api/orders'){result=server.createOrder(body);if(loseReply){loseReply=false;throw Object.assign(Error('保存後に応答消失'),{network:true});}}
      if(path==='/api/offline/cancel')result=server.cancelReserved(body);
      if(path==='/api/offline/close')result=server.closeReservation(body);
      return result;
    }catch(error){if(!error.network)error.status??=400;throw error;}
  };
  const state={...server.state(),mode:'shared'},controller=createOfflineRegister({api,id:randomUUID,storage});
  await controller.init();await controller.attach(state);await controller.prepare(state);
  const input=()=>({requestId:randomUUID(),sessionId:state.currentSessionId,menuRevision:state.menuRevision,items:[{productId:'black-01',quantity:2,ice:true,milk:true}],tendered:1500,note:'offline'});
  return {server,storage,state,controller,api,input,connect:v=>online=v,loseReply:()=>loseReply=true};
}
test('切断中に複数の会計を採番・保存し、端末再読込後の復旧同期も二重登録しない',async t=>{
  const f=await fixture(t);f.connect(false);
  const payload=f.input(),a=await f.controller.accept(payload),b=await f.controller.accept(f.input());
  assert.deepEqual([a.number,b.number],[1,2]);assert.equal(a.total,1000);assert.equal(f.server.state().totals.revenue,0);
  assert.equal((await f.controller.accept(payload)).number,1);assert.equal(f.controller.info(1,f.state.currentSessionId).remaining,48);
  await assert.rejects(f.controller.accept({...payload,note:'変更'}),/内容を変更/);
  const cached=f.controller.overlay(f.state);assert.equal(salesSummary(cached.orders).cups,4);assert.match(csvText(detailCsvRows(cached)),/未同期/);
  const restored=createOfflineRegister({api:f.api,id:randomUUID,storage:f.storage});await restored.init();assert.equal(restored.info(1,f.state.currentSessionId).pending,2);
  f.connect(true);f.loseReply();await assert.rejects(restored.sync(),/保存後に応答消失/);assert.equal(f.server.state().totals.orders,1);
  await restored.sync();await restored.sync();assert.equal(restored.info(1,f.state.currentSessionId).pending,0);assert.equal(f.server.state().totals.orders,2);assert.equal(f.server.state().totals.revenue,2000);
});
test('端末への保存失敗・番号使い切りでは受付を完了せず、紙で先に提供した番号を会計・返金同期する',async t=>{
  const f=await fixture(t);f.connect(false);const sale=await f.controller.accept(f.input());
  const paper=f.server.createPaperOrder({requestId:randomUUID(),sessionId:f.state.currentSessionId,number:sale.number,note:'紙で先に処理'});
  f.server.transition(paper.id,'waiting','ready');f.server.transition(paper.id,'ready','served');
  await f.controller.cancelLocal(f.controller.entries()[0].payload.requestId,'返金済み');
  assert.equal(salesSummary(f.controller.overlay(f.state).orders).cups,0);
  await assert.rejects(f.controller.close(),/未同期/);
  f.connect(true);await f.controller.sync();assert.equal(f.server.order(paper.id).status,'cancelled');assert.equal(f.server.state().totals.revenue,0);
  await f.controller.close();assert.equal(f.controller.info(1,f.state.currentSessionId).remaining,0);
  await assert.rejects(f.controller.accept(f.input()),/利用終了/);
  const ended=createOfflineRegister({api:f.api,id:randomUUID,storage:f.storage});await ended.init();await ended.prepare(f.state);
  assert.equal(f.server.state().offlineReservations.length,0);assert.equal(ended.info(1,f.state.currentSessionId).remaining,0);
  await ended.prepare(f.state,true);assert.equal((await ended.accept(f.input())).number,51);
  const exhausted=await fixture(t);exhausted.connect(false);
  for(let n=0;n<50;n++)await exhausted.controller.accept(exhausted.input());
  await assert.rejects(exhausted.controller.accept(exhausted.input()),/番号がありません/);
  assert.equal(exhausted.controller.entries().length,50);
  const broken=createOfflineRegister({api:f.api,id:randomUUID,storage:{get:async()=>undefined,update:async()=>{throw Error('保存失敗');}}});
  await assert.rejects(broken.init(),/保存失敗/);
});
test('親機変更・不正な同期は明示的なエラーで保留し、端末記録を削除しない',async t=>{
  const f=await fixture(t);await f.controller.accept(f.input());
  await assert.rejects(f.controller.attach({...f.state,serverId:'different-server'}),/親機/);
  f.server.closeReservation({id:f.controller.backup().reservations[0].id,terminalId:f.controller.backup().terminalId,serverId:f.state.serverId});
  await f.controller.sync();assert.equal(f.controller.info(1,f.state.currentSessionId).errors,1);assert.equal(f.controller.entries().length,1);assert.equal(f.server.state().totals.orders,0);
});
test('同じ端末の別画面で並行受付しても、共有保存への確定は一意の番号になる',async t=>{
  const f=await fixture(t),other=createOfflineRegister({api:f.api,id:randomUUID,storage:f.storage});await other.init();
  const sales=await Promise.all([f.controller.accept(f.input()),other.accept(f.input()),f.controller.accept(f.input())]);
  assert.equal(new Set(sales.map(s=>s.number)).size,3);
  const saved=await f.storage.get('book');assert.equal(saved.entries.length,3);
});
test('IP・端末変更時のバックアップ復旧は新規番号を再利用せず、保存済みも照合して重複しない',async t=>{
  const f=await fixture(t);await f.controller.accept(f.input());
  const backup=structuredClone(f.controller.backup());
  const restored=createOfflineRegister({api:f.api,id:randomUUID,storage:memoryStorage()});await restored.init();await restored.attach(f.state);
  assert.equal(await restored.importBackup(backup),1);assert.equal(restored.info(1,f.state.currentSessionId).remaining,0);
  await restored.sync();await restored.importBackup(backup);await restored.sync();assert.equal(f.server.state().totals.orders,1);
  await f.controller.cancelLocal(backup.entries[0].payload.requestId,'切断中の返金');
  await restored.importBackup(structuredClone(f.controller.backup()));await restored.sync();assert.equal(f.server.state().totals.revenue,0);
  await assert.rejects(restored.importBackup({...backup,serverId:'bad-server'}),/親機/);
  await assert.rejects(restored.importBackup({...backup,entries:backup.entries.map(e=>({...e,payload:{...e.payload,quotedTotal:1}}))}),/会計金額/);
  assert.equal(restored.entries().length,1);await restored.close();assert.equal(f.server.state().offlineReservations.length,0);
});
