import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import provided from '../config/menu.json' with {type:'json'};
import researchedNotes from '../config/menu-notes.json' with {type:'json'};
import {initialCatalog,templateCatalog,PRICE_TIERS,MENU_NOTES_REVISION} from '../lib/catalog.mjs';
import {createStore} from '../lib/store.mjs';
import {createApplication} from '../server.mjs';

function directory(t){const path=mkdtempSync(join(tmpdir(),'teatime-catalog-'));t.after(()=>{assert.ok(resolve(path).startsWith(resolve(tmpdir())+sep+'teatime-catalog-'));rmSync(path,{recursive:true,force:true});});return path;}
test('提供表は30行を保存し、お茶28品・4価格帯・種別・おすすめ・空欄を正確に区別する',()=>{
  const menu=initialCatalog();assert.equal(provided.items.length,30);assert.equal(menu.length,28);assert.equal(new Set(menu.map(p=>p.id)).size,28);
  assert.deepEqual(provided.items.filter(p=>p.kind==='option').map(p=>[p.name,p.price]),[['ミルク',50],['アイス',50]]);
  assert.deepEqual(PRICE_TIERS,[300,400,500,600]);
  assert.deepEqual(Object.fromEntries(PRICE_TIERS.map(price=>[price,menu.filter(p=>p.price===price).length])),{300:20,400:5,500:2,600:1});
  assert.deepEqual(menu.filter(p=>p.category==='日本茶など').map(p=>p.name),['いちごバニラ','多賀一番棒茶','阿里山（青山烏龍茶）','東方美人茶','深蒸し煎茶']);
  assert.equal(menu.filter(p=>p.category==='紅茶').length,23);
  assert.deepEqual(menu.filter(p=>p.recommendation==='ミルク').map(p=>p.name),['クッキー','ゆめ','ローズティー','TWINING_OF_LONDON_LADY_GRAY_TEA','ロイヤルブレンド']);
  assert.equal(menu.filter(p=>p.recommendation==='ストレート').length,20);
  assert.deepEqual(menu.filter(p=>p.recommendation==='').map(p=>p.name),['MOZAMBIQUE_MONTE_METILILE_OP','ダージリンファーストフラッシュ2026','猿島紅茶いずみ2026']);
  assert.equal(menu[3].name,'アールグレイ"ロマンティ－ク"');
});

test('全28品の説明・出典・未確認情報を保持し、ミルク推奨5品だけに指定の先頭文を付ける',()=>{
  const menu=initialCatalog();assert.equal(researchedNotes.items.length,28);
  for(const p of menu){
    const research=researchedNotes.items.find(n=>n.id===p.id&&n.name===p.name);assert.ok(research);
    assert.equal(p.description,research.description);assert.equal(p.allergens,research.allergens);
    assert.ok(p.description.length<=2000&&p.allergens.length<=500);
    assert.ok(research.sources.length>0&&research.sources.every(s=>/^https:\/\//.test(s.url)));
    assert.equal(p.description.startsWith('ミルクがおススメ。'),p.recommendation==='ミルク');
    assert.ok([2,3].includes(p.description.split('。').filter(Boolean).length));
  }
  assert.match(menu[0].allergens,/アーモンド/);assert.match(menu[10].allergens,/アーモンド/);
  assert.match(menu[3].allergens,/りんご/);assert.match(menu[15].allergens,/オレンジ/);
  assert.match(menu[16].allergens,/未確認.*メーカー不明/);assert.match(menu[16].description,/特定できていない/);
});

test('調査メモを既存メニューの空欄だけへ一度補い、手入力・会計・売り切れ・意図的な消去を保持する',t=>{
  const file=join(directory(t),'notes-upgrade.sqlite');
  let s=createStore(file,{catalog:initialCatalog().map(p=>({...p,description:'',allergens:''}))});
  s.db.prepare("DELETE FROM settings WHERE key='menuNotesRevision'").run();
  s.saveMenu({revision:1,products:s.menu().map((p,n)=>n===0?{...p,price:500,active:false,description:'スタッフが保存した説明',allergens:'スタッフ確認済み'}:n===1?{...p,name:'別の茶葉'}:p)});
  const order=s.createOrder({requestId:randomUUID(),sessionId:s.state().currentSessionId,menuRevision:2,items:[{productId:'festival-tea-02',quantity:1}],tendered:300,note:''});s.close();
  s=createStore(file);try{
    assert.equal(s.menu()[0].description,'スタッフが保存した説明');assert.equal(s.menu()[0].allergens,'スタッフ確認済み');assert.equal(s.menu()[0].price,500);assert.equal(s.menu()[0].active,false);
    assert.equal(s.menu()[1].description,'');assert.equal(s.menu()[1].allergens,'');
    assert.equal(s.menu()[2].description,initialCatalog()[2].description);assert.equal(s.state().menuRevision,3);
    assert.equal(s.getSetting('menuNotesRevision'),MENU_NOTES_REVISION);assert.equal(s.order(order.id).total,300);
    s.saveMenu({revision:3,products:s.menu().map(p=>({...p,description:'',allergens:''}))});
  }finally{s.close();}
  s=createStore(file);try{assert.ok(s.menu().every(p=>p.description===''&&p.allergens===''));assert.equal(s.state().menuRevision,4);}finally{s.close();}
});
test('未編集30枠は提供メニューへ移行し、営業履歴・金額・番号・切断中の旧料金を保つ',t=>{
  const file=join(directory(t),'old.sqlite');let s=createStore(file,{catalog:templateCatalog()}),before=s.state();
  const payload={requestId:randomUUID(),sessionId:before.currentSessionId,menuRevision:1,items:[{productId:'black-01',quantity:2,milk:true}],tendered:1000,note:''};
  const original=s.createOrder(payload);s.transition(original.id,'waiting','ready');
  const r=s.reserveNumbers({requestId:randomUUID(),terminalId:randomUUID(),serverId:before.serverId,sessionId:before.currentSessionId,menuRevision:1});s.close();
  s=createStore(file);try{
    assert.equal(s.menu().length,28);assert.equal(s.state().catalogTemplate,false);assert.equal(s.state().menuRevision,2);
    assert.equal(s.order(original.id).total,900);assert.equal(s.order(original.id).status,'ready');assert.equal(s.state().audio.pending,1);assert.equal(s.createOrder(payload).id,original.id);
    const late=s.createOrder({requestId:randomUUID(),reservationId:r.id,terminalId:r.terminalId,serverId:r.serverId,sessionId:r.sessionId,menuRevision:r.menuRevision,number:r.start,acceptedAt:new Date().toISOString(),quotedTotal:400,items:[{productId:'black-01',quantity:1}],tendered:500,note:''});
    assert.equal(late.total,400);assert.equal(s.currentSession().next_number,52);
    const fresh=s.createOrder({requestId:randomUUID(),sessionId:r.sessionId,menuRevision:2,items:[{productId:'festival-tea-01',quantity:1}],tendered:300,note:''});assert.equal(fresh.number,52);assert.equal(fresh.total,300);
  }finally{s.close();}
});
test('説明・アレルギー・価格など編集済みのカタログを自動置換しない',t=>{
  const file=join(directory(t),'custom.sqlite');let s=createStore(file,{catalog:templateCatalog()});
  s.saveMenu({revision:1,products:s.menu().map((p,n)=>n===0?{...p,description:'保存済みの説明',allergens:'確認済み情報',price:500}:p)});const before=s.menu();s.close();
  s=createStore(file);try{assert.deepEqual(s.menu(),before);assert.equal(s.state().menuRevision,2);}finally{s.close();}
});
test('おすすめは再起動・旧クライアント更新でも保持し、空欄と入力上限を扱う',t=>{
  const file=join(directory(t),'recommendation.sqlite');let s=createStore(file);assert.equal(s.menu()[0].recommendation,'ミルク');
  s.saveMenu({revision:1,products:s.menu().map(p=>({...p,recommendation:p.id==='festival-tea-01'?'ストレート':p.recommendation}))});s.close();
  s=createStore(file);try{
    assert.equal(s.menu()[0].recommendation,'ストレート');
    s.saveMenu({revision:2,products:s.menu().map(({recommendation,...p})=>({...p,description:'説明更新'}))});assert.equal(s.menu()[0].recommendation,'ストレート');
    for(const value of ['a'.repeat(101),['ミルク']])assert.throws(()=>s.saveMenu({revision:3,products:s.menu().map(p=>({...p,recommendation:value}))}),/おすすめ/);
    assert.equal(s.state().menuRevision,3);s.saveMenu({revision:3,products:s.menu().map(p=>({...p,recommendation:''}))});assert.equal(s.menu()[0].recommendation,'');
  }finally{s.close();}
});
test('各モードの初期メニューと提供データの取得、300円会計・公開APIの制限を維持する',async t=>{
  for(const mode of ['shared','cashier','kitchen']){
    const app=createApplication({mode,database:':memory:',automaticBackups:false});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());const base='http://127.0.0.1:'+app.server.address().port;
    const state=await(await fetch(base+'/api/state')).json();assert.equal(state.menu.length,28);assert.equal(state.menu[0].price,300);
    const response=await fetch(base+'/api/menu/default');assert.equal(response.status,mode==='kitchen'?409:200);
    if(mode!=='kitchen'){
      assert.equal((await response.json()).length,28);
      const saved=await fetch(base+'/api/orders',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),sessionId:state.currentSessionId,menuRevision:state.menuRevision,items:[{productId:'festival-tea-01',quantity:1,ice:true,milk:true}],tendered:500,note:''})});
      assert.equal(saved.status,201);assert.equal((await saved.json()).total,400);
    }
    const publicState=await(await fetch(base+'/api/public')).json();assert.equal(publicState.menu,undefined);assert.doesNotMatch(JSON.stringify(publicState),/recommendation|クッキー|allergens/);
  }
});
