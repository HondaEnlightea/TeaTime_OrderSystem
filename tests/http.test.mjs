import {templateCatalog} from '../lib/catalog.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApplication } from '../server.mjs';
import http from 'node:http';
import { createStore } from '../lib/store.mjs';

async function fixture(t,mode='shared',legacyPin=false) {
  const directory=mkdtempSync(join(tmpdir(),'teatime-http-'));
  if(legacyPin){const old=createStore(join(directory,'db.sqlite'), {catalog:templateCatalog()});old.setting('pinHash','legacy-hash');old.setting('pinSalt','legacy-salt');old.close();}
  const application=createApplication({database:join(directory,'db.sqlite'),backupDir:join(directory,'backups'),automaticBackups:false,mode,catalog:templateCatalog()});
  await new Promise(r=>application.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${application.server.address().port}`;
  t.after(async()=>{await application.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'teatime-http-'));rmSync(directory,{recursive:true,force:true});});
  const request=(path,body,opts={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{Origin:base,'Content-Type':'application/json'}),...opts.headers},body:body===undefined?undefined:JSON.stringify(body)});
  const staff=(path,body)=>request(path,body);
  const state=await (await staff('/api/state')).json();
  const order=(override={})=>({requestId:randomUUID(),sessionId:state.currentSessionId,menuRevision:state.menuRevision,items:[{productId:'black-01',quantity:1}],tendered:500,note:'',...override});
  return {application,base,request,staff,state,order,database:join(directory,'db.sqlite')};
}
test('50件を同時登録しても採番は一意。15件の再送も重複しない',async t=>{
  const {staff,order}=await fixture(t);
  const payloads=Array.from({length:50},()=>order());
  const responses=await Promise.all(payloads.map(p=>staff('/api/orders',p)));
  assert.ok(responses.every(r=>r.status===201));
  const orders=await Promise.all(responses.map(r=>r.json()));
  assert.equal(new Set(orders.map(o=>o.number)).size,50);assert.deepEqual(orders.map(o=>o.number).sort((a,b)=>a-b),Array.from({length:50},(_,i)=>i+1));
  const resends=await Promise.all(Array.from({length:15},()=>staff('/api/orders',payloads[0]).then(r=>r.json())));
  assert.ok(resends.every(o=>o.id===orders[0].id));
  const state=await (await staff('/api/state')).json();assert.equal(state.totals.orders,50);assert.equal(state.totals.revenue,20000);
});
test('HTTP業務フローと公開画面：会計→完成→音声→提供済み→CSV',async t=>{
  const {staff,request,order}=await fixture(t);
  const o=await (await staff('/api/orders',order())).json();
  const publicState=await (await request('/api/public')).json();assert.equal(publicState.orders[0].label,o.label);assert.equal(publicState.totals,undefined);
  const completed=await staff(`/api/orders/${o.id}/status`,{expected:'waiting',status:'ready'});assert.equal(completed.status,200);
  const duplicate=await staff(`/api/orders/${o.id}/status`,{expected:'waiting',status:'ready'});assert.equal(duplicate.status,409);
  const consumer=randomUUID();await staff('/api/audio/lease',{consumer});
  const {call}=await (await staff('/api/audio/claim',{consumer})).json();assert.equal(call.number,o.number);
  assert.equal((await staff('/api/audio/finish',{id:call.id,consumer,success:true})).status,200);
  await staff(`/api/orders/${o.id}/status`,{expected:'ready',status:'served'});
  assert.equal((await (await request('/api/public')).json()).orders.length,0);
  const csv=await staff('/api/export');assert.equal(csv.status,200);assert.match(await csv.text(),/提供済み/);
  const backup=await staff('/api/backup',{});assert.equal(backup.status,200);assert.equal(Buffer.from(await backup.arrayBuffer()).subarray(0,15).toString(),'SQLite format 3');
});
test('PINなしでもOrigin・Host・JSON・送信サイズ・限定ファイル配信を検証する',async t=>{
  const {request,staff,order,base}=await fixture(t);
  assert.equal((await request('/api/state')).status,200);
  const registered=await request('/api/orders',order());assert.equal(registered.status,201);assert.equal(registered.headers.get('set-cookie'),null);
  assert.equal((await request('/api/backup',{})).status,200);
  assert.equal((await request('/api/audio/lease',{consumer:randomUUID()})).status,200);
  assert.equal((await request('/api/orders',order(),{headers:{Origin:'https://example.com'}})).status,403);
  const forgedHostStatus=await new Promise((r,reject)=>{
    http.get(base+'/api/health',{headers:{Host:'evil.example'}},res=>{res.resume();r(res.statusCode);}).on('error',reject);
  });
  assert.equal(forgedHostStatus,403);assert.equal((await request('/data/teatime.sqlite')).status,404);
  const malformed=await fetch(base+'/api/orders',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{bad'});assert.equal(malformed.status,400);
  const tooLarge=await staff('/api/orders',order({note:'a'.repeat(70000)}));assert.equal(tooLarge.status,413);
  assert.equal((await request('/api/auth')).status,404);assert.equal((await request('/api/login',{})).status,404);
});
test('全3モードで旧PIN設定のあるDBもログイン・Cookieなしで使える',async t=>{
  for(const mode of ['shared','cashier','kitchen']){
    const f=await fixture(t,mode,true);assert.equal(f.state.mode,mode);
    assert.equal((await f.request('/api/state')).status,200);
    const response=mode==='kitchen'?await f.request('/api/paper-orders',{requestId:randomUUID(),sessionId:f.state.currentSessionId,number:42}):await f.request('/api/orders',f.order());
    assert.equal(response.status,201);assert.equal(response.headers.get('set-cookie'),null);
    assert.equal(f.application.store.getSetting('pinHash'),'legacy-hash');
  }
});
test('日本語の全画面が配信され、外部依存・ファイル公開がない',async t=>{
  const {request}=await fixture(t);
  for(const path of ['/cashier','/kitchen','/sales','/settings','/display','/history','/menu','/staff-menu']){
    const res=await request(path);assert.equal(res.status,200);assert.match(res.headers.get('content-security-policy'),/default-src 'self'/);assert.match(await res.text(),/lang="ja"/);
  }
  const js=await request('/app.js');assert.equal(js.status,200);
  assert.equal((await request('/api/public')).headers.get('cache-control'),'no-store');
});
test('CSVのユーザー文字列はExcel数式として解釈させない',async t=>{
  const {staff,order,state}=await fixture(t);
  const products=state.menu.map(p=>p.id==='black-01'?{...p,name:'=1+2'}:p);
  await staff('/api/menu',{products,revision:state.menuRevision});
  await staff('/api/orders',order({menuRevision:state.menuRevision+1,note:'@evil'}));
  const csv=await (await staff('/api/export')).text();assert.ok(csv.includes("\"'=1+2\""));assert.ok(csv.includes("\"'@evil\""));
});
test('独立会計と独立キッチンは別の記録。紙の番号で完成から提供まで運用できる',async t=>{
  const cashier=await fixture(t,'cashier'),kitchen=await fixture(t,'kitchen');
  const o=await (await cashier.staff('/api/orders',cashier.order({items:[{productId:'black-01',quantity:1,ice:true,milk:true}]}))).json();assert.equal(o.total,500);
  assert.equal((await (await kitchen.request('/api/public')).json()).orders.length,0);
  assert.equal((await cashier.staff('/api/paper-orders',{requestId:randomUUID(),sessionId:cashier.state.currentSessionId,number:o.number})).status,409);
  assert.equal((await kitchen.staff('/api/orders',kitchen.order())).status,409);
  const payload={requestId:randomUUID(),sessionId:kitchen.state.currentSessionId,number:o.number,note:'注文票を参照'},paper=await (await kitchen.staff('/api/paper-orders',payload)).json();
  assert.equal(paper.label,o.label);assert.equal((await (await kitchen.staff('/api/paper-orders',payload)).json()).id,paper.id);
  assert.equal((await kitchen.staff('/api/paper-orders',{...payload,requestId:randomUUID()})).status,409);
  await kitchen.staff(`/api/orders/${paper.id}/status`,{expected:'waiting',status:'ready'});
  assert.equal((await (await kitchen.request('/api/public')).json()).orders[0].status,'ready');
  assert.equal((await (await cashier.staff('/api/state')).json()).orders[0].status,'waiting');
  await kitchen.staff(`/api/orders/${paper.id}/status`,{expected:'ready',status:'served'});
  assert.equal((await (await kitchen.staff('/api/state')).json()).totals.revenue,0);
  assert.equal((await (await cashier.staff('/api/state')).json()).totals.revenue,500);
  assert.equal((await (await cashier.staff('/api/state')).json()).totals.waiting,0);
  assert.equal((await (await cashier.request('/api/public')).json()).orders.length,0);
  assert.equal((await cashier.staff('/api/sessions',{previousId:cashier.state.currentSessionId,name:'翌日'})).status,201);
});
test('ログイン不要の連携クライアントにオプション付き注文と状態更新を共有する',async t=>{
  const f=await fixture(t);
  const kitchen=(path,body)=>f.request(path,body);
  const o=await (await f.staff('/api/orders',f.order({items:[{productId:'oolong-01',quantity:2,milk:true}],tendered:1000}))).json();assert.equal(o.total,900);
  const state=await (await kitchen('/api/state')).json();assert.equal(state.orders[0].items[0].milk,true);
  await kitchen(`/api/orders/${o.id}/status`,{expected:'waiting',status:'ready'});
  assert.equal((await (await f.staff('/api/state')).json()).orders[0].status,'ready');
  const csv=await (await f.staff('/api/export')).text();assert.match(csv,/ミルク料金/);assert.match(csv,/"450","2","900"/);
});
test('独立ローカルの各端末は自分の画面へ誘導し、会計とキッチンを混在させない',async t=>{
  const cashier=await fixture(t,'cashier'),kitchen=await fixture(t,'kitchen');
  for(const path of ['/','/kitchen','/display'])assert.equal((await cashier.request(path)).url,cashier.base+'/cashier');
  for(const path of ['/','/cashier'])assert.equal((await kitchen.request(path)).url,kitchen.base+'/kitchen');
  assert.equal((await kitchen.request('/display')).url,kitchen.base+'/display');
  const payload={requestId:randomUUID(),sessionId:kitchen.state.currentSessionId,number:71,note:'紙の注文票'};
  assert.equal((await kitchen.request('/api/paper-orders',payload)).status,201);
  assert.equal((await (await kitchen.request('/api/public')).json()).orders[0].label,'071');
  assert.equal((await (await cashier.request('/api/state')).json()).orders.length,0);
});


test('販売杯数とCSVは取消を除き、価格変更後も注文時の氷・ミルク料金で集計する',async t=>{
  const f=await fixture(t,'cashier');
  await f.staff('/api/orders',f.order({items:[{productId:'black-01',quantity:2,ice:true,milk:true},{productId:'green-01',quantity:1}],tendered:1500}));
  await f.staff('/api/orders',f.order({items:[{productId:'black-01',quantity:1}],tendered:500}));
  const cancelled=await (await f.staff('/api/orders',f.order({items:[{productId:'black-01',quantity:1,ice:true}],tendered:500}))).json();
  await f.staff(`/api/orders/${cancelled.id}/status`,{expected:'waiting',status:'cancelled',reason:'返金'});
  await f.staff('/api/menu',{revision:f.state.menuRevision,products:f.state.menu.map(p=>({...p,price:600}))});
  const current=await (await f.staff('/api/state')).json();
  assert.equal(current.totals.revenue,1800);assert.equal(current.totals.cups,4);assert.equal(current.totals.cancelled,1);
  assert.deepEqual(current.totals.byCupCount,[{cups:1,orders:1,revenue:400},{cups:3,orders:1,revenue:1400}]);
  const tea=current.totals.byMenu.find(p=>p.id==='black-01');
  assert.deepEqual([tea.cups,tea.baseRevenue,tea.iceCups,tea.iceRevenue,tea.milkCups,tea.milkRevenue,tea.revenue],[3,1200,2,100,2,100,1400]);
  const menu=await f.staff('/api/export?kind=menu-sales');assert.match(menu.headers.get('content-disposition'),/teatime-menu-sales/);
  const raw=Buffer.from(await menu.arrayBuffer());assert.deepEqual([...raw.subarray(0,3)],[239,187,191]);
  assert.match(raw.toString(),/"3","1200","2","100","2","100","1400"/);
  const cups=await (await f.staff('/api/export?kind=cup-sales')).text();assert.match(cups,/1注文の杯数/);assert.match(cups,/"3","1","3","1400"/);assert.match(cups,/"1","1","1","400"/);
  assert.equal((await f.staff('/api/export?kind=unknown')).status,400);
  await f.staff('/api/sessions',{previousId:current.currentSessionId,name:'翌日'});
  const empty=await (await f.staff('/api/state')).json();assert.equal(empty.totals.cups,0);
  assert.match(await (await f.staff('/api/export?kind=cup-sales&session='+current.currentSessionId)).text(),/"3","1","3","1400"/);
  const kitchen=await fixture(t,'kitchen');await kitchen.staff('/api/paper-orders',{requestId:randomUUID(),sessionId:kitchen.state.currentSessionId,number:42});
  const paper=await (await kitchen.staff('/api/state')).json();assert.equal(paper.totals.cups,0);assert.deepEqual(paper.totals.byMenu,[]);
});
test('端末用入口は担当3画面へ案内し、旧URLを廃止し、商品・売上・備考を公開しない',async t=>{
  const f=await fixture(t);await f.staff('/api/orders',f.order({note:'非公開の備考'}));
  const before=await (await f.staff('/api/state')).json();
  const legacy=await fetch(f.base+'/connection-check',{redirect:'manual'});assert.equal(legacy.status,404);assert.equal(legacy.headers.get('location'),null);assert.doesNotMatch(await legacy.text(),/\/portal|href=/);
  const res=await f.request('/portal'),html=await res.text();assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');
  assert.match(html,/<h1>端末用入口<\/h1>/);assert.match(html,/<a[^>]+href="\/kitchen">キッチン・お渡しへ<\/a>/);
  assert.match(html,/接続できました/);assert.doesNotMatch(html,/非公開の備考|紅茶 茶葉01/);
  assert.match(html,/<a[^>]+href="\/cashier">注文・会計へ<\/a>/);
  assert.match(html,/<a[^>]+href="\/display\?setup=1">番号表示・音声準備へ<\/a>/);
  assert.doesNotMatch(html,/href="http|127\.0\.0\.1|TEATIME \/ CONNECTION CHECK/);
  for(const path of ['/cashier','/kitchen','/display?setup=1']){const destination=await f.request(path);assert.equal(destination.status,200);assert.equal(new URL(destination.url).origin,f.base);}
  assert.deepEqual((await (await f.staff('/api/state')).json()).orders,before.orders);
  const publicState=await (await f.request('/api/public')).json();assert.equal(publicState.totals,undefined);assert.equal(publicState.menu,undefined);
  for(const mode of ['cashier','kitchen']){
    const local=await fixture(t,mode),page=await(await local.request('/portal')).text();
    assert.equal(page.includes('href="/cashier"'),mode==='cashier');assert.equal(page.includes('href="/kitchen"'),mode==='kitchen');assert.equal(page.includes('href="/display?setup=1"'),mode==='kitchen');
  }
});
test('30種類の長い日本語説明は保存・再起動後も保持され、不正な説明は拒否する',async t=>{
  const f=await fixture(t,'cashier');
  const products=f.state.menu.map(p=>({...p,description:'香り'.repeat(1000)}));
  assert.equal((await f.staff('/api/menu',{products,revision:f.state.menuRevision})).status,200);
  const saved=await (await f.staff('/api/state')).json();assert.equal(saved.menu[0].description.length,2000);
  assert.equal((await f.staff('/api/menu',{products:products.map(p=>({...p,description:100})),revision:saved.menuRevision})).status,400);
  const fresh=createStore(f.database, {catalog:templateCatalog()});try{assert.equal(fresh.menu()[0].description,'香り'.repeat(1000));}finally{fresh.close();}
});
test('アレルギー情報は保存・再起動・旧クライアントの説明更新でも保持し、明示的な空欄で解除できる',async t=>{
  const f=await fixture(t,'cashier');
  const products=f.state.menu.map(p=>({...p,allergens:p.id==='black-01'?'検証用の原材料情報\n追加オプションは別途確認':''}));
  assert.equal((await f.staff('/api/menu',{products,revision:f.state.menuRevision})).status,200);
  let saved=await (await f.staff('/api/state')).json();assert.equal(saved.menu[0].allergens,products[0].allergens);
  const fresh=createStore(f.database, {catalog:templateCatalog()});try{assert.equal(fresh.menu()[0].allergens,products[0].allergens);}finally{fresh.close();}
  const legacy=saved.menu.map(({allergens,...p})=>({...p,description:'新しい説明'}));
  assert.equal((await f.staff('/api/menu',{products:legacy,revision:saved.menuRevision})).status,200);
  saved=await (await f.staff('/api/state')).json();assert.equal(saved.menu[0].allergens,products[0].allergens);
  assert.equal((await f.staff('/api/menu',{products:saved.menu.map(p=>({...p,allergens:'a'.repeat(501)})),revision:saved.menuRevision})).status,400);
  assert.equal((await f.staff('/api/menu',{products:saved.menu.map(p=>({...p,allergens:['乳']})),revision:saved.menuRevision})).status,400);
  const current=await (await f.staff('/api/state')).json();assert.equal(current.menuRevision,saved.menuRevision);assert.equal(current.menu[0].allergens,products[0].allergens);
  assert.equal((await f.staff('/api/menu',{products:saved.menu.map(p=>({...p,allergens:''})),revision:saved.menuRevision})).status,200);
  assert.equal((await (await f.staff('/api/state')).json()).menu[0].allergens,'');
  assert.equal((await (await f.request('/api/public')).json()).menu,undefined);
});
test('LANの予備番号・紙受付・会計同期はHTTPでも一意で、公開APIに金額・明細・端末情報を出さない',async t=>{
  const f=await fixture(t);
  const payload={requestId:randomUUID(),terminalId:randomUUID(),serverId:f.state.serverId,sessionId:f.state.currentSessionId,menuRevision:f.state.menuRevision};
  const responses=await Promise.all(Array.from({length:8},()=>f.staff('/api/offline/reserve',payload)));
  const reservations=await Promise.all(responses.map(r=>r.json()));assert.equal(new Set(reservations.map(r=>r.id)).size,1);
  const r=reservations[0];assert.equal((await (await f.staff('/api/state')).json()).session.next_number,51);
  const paper=await (await f.staff('/api/paper-orders',{requestId:randomUUID(),sessionId:r.sessionId,number:r.start,note:'紙'})).json();
  assert.equal(paper.source,'paper');
  await f.staff(`/api/orders/${paper.id}/status`,{expected:'waiting',status:'ready'});
  const input={requestId:randomUUID(),sessionId:r.sessionId,menuRevision:r.menuRevision,serverId:r.serverId,terminalId:r.terminalId,reservationId:r.id,number:r.start,acceptedAt:new Date().toISOString(),quotedTotal:450,items:[{productId:'black-01',quantity:1,milk:true}],tendered:500,note:''};
  const sales=await Promise.all(Array.from({length:10},()=>f.staff('/api/orders',input).then(r=>r.json())));assert.ok(sales.every(o=>o.id===paper.id&&o.status==='ready'));
  const state=await (await f.staff('/api/state')).json();assert.equal(state.totals.revenue,450);assert.equal(state.orders.length,1);assert.equal(state.audio.pending,1);
  const view=await (await f.request('/api/public')).json();assert.deepEqual(Object.keys(view.orders[0]).sort(),['label','number','status']);assert.equal(view.offlineReservations,undefined);assert.equal(view.serverId,undefined);
  assert.equal((await f.request('/api/offline/reserve',{...payload,requestId:randomUUID()},{headers:{Origin:'https://example.com'}})).status,403);
  assert.equal((await f.staff('/api/sessions',{previousId:f.state.currentSessionId,name:'翌日'})).status,409);
  const cashier=await fixture(t,'cashier');assert.equal((await cashier.staff('/api/offline/reserve',payload)).status,409);
  const kitchen=await fixture(t,'kitchen');assert.equal((await kitchen.staff('/api/offline/reserve',payload)).status,409);
});
