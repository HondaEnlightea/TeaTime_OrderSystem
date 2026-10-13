import {bootDisplay} from './display.js';
const app=document.querySelector('#app'),modal=document.querySelector('#modal');
const route=location.pathname==='/'?'home':location.pathname.slice(1),isDisplay=route==='display';
const labels={waiting:'準備中',ready:'提供可能',served:'提供済み',cancelled:'取消'};
const actions={registered:'注文登録',ready:'完成・呼び出し',served:'お渡し完了',cancelled:'取消',recalled:'再呼び出し'};
const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yen=n=>`¥${Number(n).toLocaleString('ja-JP')}`;
const time=v=>new Date(v).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'});
const date=v=>new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
const id=()=>[...crypto.getRandomValues(new Uint8Array(16))].map(v=>v.toString(16).padStart(2,'0')).join('');
let state,mode='shared',cart=[],tendered='',note='',pending=null,confirmed=null,storageOK=true,busy=false,connected=false,pollTimer,toastTimer,selectedSession='',category='紅茶',search='',ice=false,milk=false;
let paperNumber='',paperNote='',paperPending=null;
const draftKey='teatime-draft-v2',paperKey='teatime-paper-v1';
const variants=i=>`${i.productId}:${Number(i.ice)}:${Number(i.milk)}`;
const options=i=>[i.ice?'氷 +¥50':'',i.milk?'ミルク +¥50':''].filter(Boolean).join(' / ')||'オプションなし';
function toast(message){clearTimeout(toastTimer);document.querySelector('#toast').textContent=message;toastTimer=setTimeout(()=>document.querySelector('#toast').textContent='',7000);}
async function api(path,body){
  let res;try{res=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(7000),cache:'no-store'});}catch{const err=new Error('接続できません。起動状態と、連携運用の場合はネットワークを確認してください。');err.network=true;throw err;}
  const data=await res.json();if(!res.ok){const err=new Error(data.error||'操作できませんでした。');err.status=res.status;throw err;}return data;
}
function loadDraft(){
  try{
    let v=JSON.parse(localStorage.getItem(draftKey)||'null');
    if(!v){const old=JSON.parse(localStorage.getItem('teatime-draft-v1')||'null');if(old)v={...old,cart:Object.entries(old.cart||{}).filter(([,q])=>q>0).map(([productId,quantity])=>({productId,quantity,ice:false,milk:false}))};}
    if(v){cart=Array.isArray(v.cart)?v.cart:[];tendered=v.tendered??'';note=v.note??'';pending=v.pending??null;}
    const p=JSON.parse(localStorage.getItem(paperKey)||'null');if(p){paperNumber=p.number??'';paperNote=p.note??'';paperPending=p.pending??null;}
  }catch{storageOK=false;}
}
function saveDraft(){try{localStorage.setItem(draftKey,JSON.stringify({cart,tendered,note,pending}));localStorage.setItem(paperKey,JSON.stringify({number:paperNumber,note:paperNote,pending:paperPending}));}catch{storageOK=false;toast('再送情報を保存できません。ブラウザのサイトデータ保存を許可してください。');}}
function connection(ok){connected=ok;document.querySelectorAll('[data-connection]').forEach(el=>{el.textContent=ok?(mode==='shared'?'連携中':'この端末で稼働中'):'接続なし';el.classList.toggle('offline',!ok);});document.querySelector('#offline')?.classList.toggle('hidden',ok);document.querySelectorAll('[data-online]').forEach(el=>el.disabled=!ok||busy);}
function brand(){return '<a class="brand" href="/"><img src="/favicon.svg" alt=""><div><strong>TeaTime</strong><span>FESTIVAL TEA ROOM</span></div></a>';}
function badge(status){return `<span class="badge ${e(status)}">${labels[status]}</span>`;}
function heading(title,sub=''){return `<div class="heading"><div><span class="eyebrow">TEATIME / ${mode==='shared'?'NETWORK':'LOCAL'}</span><h1>${title}</h1>${sub?`<p>${sub}</p>`:''}</div><span class="session-chip">${e(state.session.name)}</span></div>`;}
function shell(){
  const station=mode==='kitchen'||route==='kitchen'?'kitchen':'cashier';
  app.innerHTML=`<div class="shell"><header class="topbar">${brand()}<div class="top-right"><span class="connection" data-connection></span><a class="station-link" href="/${station}">${station==='cashier'?'注文・会計':'キッチン'}</a>${station==='kitchen'?'<a class="station-link" href="/display?setup=1" target="_blank" rel="noopener">番号表示 ↗</a>':''}<details class="admin-menu"><summary>管理</summary><div><a href="/sales">${mode==='kitchen'?'番号の履歴':'売上・履歴'}</a><a href="/settings">${mode==='kitchen'?'営業設定':'茶葉・営業設定'}</a></div></details></div></header><main class="main"><div id="offline" class="alert hidden" role="alert">接続が切れています。表示は最後に確認できた状態です。登録結果が不明な場合は、同じ注文を再送してください。</div><div id="content"></div></main></div>`;connection(connected);
}
function home(){document.querySelector('#content').innerHTML=heading('お茶の時間を、はじめましょう。')+`<div class="home-stations">${mode!=='kitchen'?'<a class="station-card" href="/cashier"><span class="eyebrow">CASHIER</span><h2>注文・会計</h2><p>茶葉とオプションを選び、受付番号をお渡しします。</p><span>会計画面へ →</span></a>':''}${mode!=='cashier'?'<a class="station-card" href="/kitchen"><span class="eyebrow">KITCHEN</span><h2>キッチン・お渡し</h2><p>完成したお茶を呼び出し、お渡しまで管理します。</p><span>キッチン画面へ →</span></a>':''}</div><p class="hint">${mode==='shared'?'連携運用：会計端末では「注文・会計」、キッチンPCでは「キッチン」を開きます。':'独立運用：注文票で受付番号と注文内容をキッチンへ渡します。'}</p>`;}
function cartItems(){return cart.map(i=>{const p=state.menu.find(p=>p.id===i.productId);return {...i,...p,unit_price:(p?.price??0)+(i.ice?50:0)+(i.milk?50:0)};});}
function total(){return cartItems().reduce((n,i)=>n+i.unit_price*i.quantity,0);}
function renderProducts(){
  const products=state.menu.filter(p=>p.active&&p.category===category&&p.name.toLowerCase().includes(search.toLowerCase()));
  document.querySelector('#products').innerHTML=products.map(p=>`<button class="tea-card" data-action="add-tea" data-product="${e(p.id)}" ${pending||busy?'disabled':''}><span class="tea-index">${String(state.menu.indexOf(p)+1).padStart(2,'0')}</span><strong>${e(p.name)}</strong><span>${yen(p.price)} <b aria-hidden="true">＋</b></span></button>`).join('')||'<p class="empty">該当する茶葉はありません。</p>';
  document.querySelectorAll('[data-action="category"]').forEach(el=>{el.classList.toggle('active',el.dataset.category===category);el.setAttribute('aria-selected',String(el.dataset.category===category));});
}
function renderCashier(){
  const categories=[...new Set(state.menu.filter(p=>p.active).map(p=>p.category))];if(!categories.includes(category))category=categories[0]||'紅茶';
  document.querySelector('#content').innerHTML=heading('注文・会計')+`<div class="cashier-layout"><section class="tea-selection"><div class="tea-tools"><div class="tea-tabs" role="tablist" aria-label="お茶の種類">${categories.map(c=>`<button role="tab" data-action="category" data-category="${e(c)}">${e(c)}</button>`).join('')}</div><input id="tea-search" type="search" placeholder="茶葉を探す" aria-label="茶葉を探す" value="${e(search)}"></div><div class="option-picker"><span>追加するお茶のオプション</span><label><input id="pick-ice" type="checkbox" ${ice?'checked':''}>氷 <small>+¥50</small></label><label><input id="pick-milk" type="checkbox" ${milk?'checked':''}>ミルク <small>+¥50</small></label></div><div id="products" class="tea-grid"></div>${state.catalogTemplate?'<p class="hint">茶葉名は仮の30枠です。管理から当日の名前・価格に変更してください。</p>':''}</section><aside class="panel cart"><div class="cart-title"><h2>今回の注文</h2><button class="text-button" data-action="clear">クリア</button></div><div id="draft-alert"></div><div id="cart-lines"></div><div class="total"><span>合計</span><strong id="total"></strong></div><label class="field"><span>お預かり（円）</span><input id="tendered" type="number" inputmode="numeric" min="0" max="1000000" step="1" value="${e(tendered)}" placeholder="金額を入力"></label><button class="text-button" data-action="exact">ちょうどのお支払い</button><div class="change"><span>お釣り</span><strong id="change"></strong></div><details class="order-memo"><summary>備考を追加</summary><textarea id="note" maxlength="200" aria-label="注文の備考">${e(note)}</textarea></details><div id="pending-info"></div><button id="checkout" class="primary wide" data-action="checkout">会計を確認</button></aside></div>`;renderProducts();renderCart();
}
function renderCart(){
  const items=cartItems(),sum=total(),locked=Boolean(pending)||busy;
  document.querySelector('#cart-lines').innerHTML=items.length?items.map((i,n)=>`<div class="cart-line"><div><strong>${e(i.name||'変更された茶葉')}</strong><small>${yen(i.unit_price)} / 杯</small><div class="line-options"><button data-action="line-option" data-index="${n}" data-option="ice" aria-pressed="${i.ice}">氷 +¥50</button><button data-action="line-option" data-index="${n}" data-option="milk" aria-pressed="${i.milk}">ミルク +¥50</button></div><div class="qty"><button data-action="qty" data-index="${n}" data-delta="-1" aria-label="${e(i.name)}を1杯減らす">−</button><output>${i.quantity}</output><button data-action="qty" data-index="${n}" data-delta="1" aria-label="${e(i.name)}を1杯増やす">＋</button></div></div><strong>${yen(i.unit_price*i.quantity)}</strong></div>`).join(''):'<p class="cart-empty">茶葉を選んでください。</p>';
  document.querySelector('#total').textContent=yen(sum);document.querySelector('#change').textContent=tendered===''?'—':Number(tendered)>=sum?yen(Number(tendered)-sum):'お預かり不足';
  document.querySelectorAll('[data-action="qty"],[data-action="line-option"],[data-action="clear"],[data-action="exact"],[data-action="add-tea"],#pick-ice,#pick-milk,#tendered,#note').forEach(el=>el.disabled=locked);
  const invalid=cart.some(i=>!state.menu.some(p=>p.id===i.productId&&p.active));
  document.querySelector('#draft-alert').innerHTML=invalid&&!pending?'<p class="alert">選択した茶葉が販売停止・削除されました。クリアして選び直してください。</p>':!storageOK?'<p class="alert">端末への保存ができないため、登録を止めています。</p>':'';
  document.querySelector('#pending-info').innerHTML=pending?'<p class="lock-message">登録結果を確認するまで内容は固定されます。同じ注文を再送してください。</p>':'';
  const checkout=document.querySelector('#checkout');checkout.textContent=busy?'登録結果を確認中…':pending?'登録結果の確認・再送':'会計を確認';checkout.disabled=busy||!connected||!storageOK||(!pending&&(invalid||!items.length||tendered===''||!Number.isSafeInteger(Number(tendered))||Number(tendered)<sum));
}
function openDialog(html){modal.innerHTML=html;modal.showModal();}
function closeDialog(){modal.close();}
function confirmCheckout(){
  if(pending){submitOrder();return;}const items=cartItems();
  confirmed={requestId:id(),sessionId:state.currentSessionId,menuRevision:state.menuRevision,items:cart.map(i=>({...i})),tendered:Number(tendered),note};
  openDialog(`<h2>会計の確認</h2>${items.map(i=>`<div class="cart-line"><div>${e(i.name)} × ${i.quantity}<small>${options(i)}</small></div><strong>${yen(i.unit_price*i.quantity)}</strong></div>`).join('')}<div class="total"><span>合計</span><strong>${yen(total())}</strong></div><p>お預かり ${yen(tendered)} ／ お釣り ${yen(Number(tendered)-total())}</p>${note?`<p>${e(note)}</p>`:''}<p class="note">代金を受け取ってから登録してください。</p><div class="dialog-actions"><button data-action="close">戻る</button><button class="primary" data-action="register">受領・注文登録</button></div>`);
}
async function submitOrder(){
  if(busy)return;if(!pending){if(!confirmed)return;pending=confirmed;saveDraft();if(!storageOK){pending=null;closeDialog();renderCart();return;}}
  busy=true;closeDialog();renderCart();
  try{const order=await api('/api/orders',pending);pending=null;cart=[];tendered='';note='';saveDraft();await refresh(false).catch(()=>connection(false));renderCashier();openDialog(`<div class="receipt"><span class="eyebrow">ORDER REGISTERED</span><h2>受付番号</h2><div class="receipt-number">${order.label}</div><p>合計 ${yen(order.total)} ／ お釣り ${yen(order.change)}</p><p class="note">注文票とお客様控えに番号を記入してください。${mode==='cashier'?'注文票をキッチンへ渡してください。':''}</p><button class="primary wide" data-action="close">次の注文へ</button></div>`);}
  catch(error){if(error.status>=400&&error.status<500&&![401,429].includes(error.status)){pending=null;saveDraft();await refresh(false).catch(()=>{});}toast(error.message);}
  finally{busy=false;renderCart();}
}
function orderCard(o){return `<article class="order-card ${o.status}"><div class="order-top"><strong class="number">${o.label}</strong><span>${time(o.created_at)}</span></div>${o.items.length?`<ul class="order-items">${o.items.map(i=>`<li><div>${e(i.name)}${i.ice!==null?`<small>${options(i)}</small>`:''}</div><strong>×${i.quantity}</strong></li>`).join('')}</ul>`:''}${o.note?`<p class="order-note">${e(o.note)}</p>`:''}<div class="order-actions"><button class="primary" data-online data-action="status" data-id="${o.id}" data-expected="${o.status}" data-status="${o.status==='waiting'?'ready':'served'}">${o.status==='waiting'?'完成・呼び出し':'お渡し完了'}</button>${o.status==='ready'?`<button data-online data-action="recall" data-id="${o.id}">再呼出</button>`:''}<button class="text-button" data-online data-action="cancel" data-id="${o.id}" data-expected="${o.status}">取消</button></div></article>`;}
function renderKitchen(){
  const waiting=state.orders.filter(o=>o.fulfillment&&o.status==='waiting').reverse(),ready=state.orders.filter(o=>o.fulfillment&&o.status==='ready').reverse();
  document.querySelector('#content').innerHTML=heading('キッチン・お渡し',mode==='kitchen'?'注文票の受付番号を入力して、完成したら呼び出してください。':'会計で登録された注文が、この画面に届きます。')+`${mode==='kitchen'?`<form id="paper-form" class="paper-entry panel"><label class="field"><span>注文票の受付番号</span><input id="paper-number" type="number" min="1" max="9999" step="1" inputmode="numeric" required value="${e(paperNumber)}" ${paperPending?'disabled':''}></label><label class="field"><span>注文票の内容（任意）</span><input id="paper-note" maxlength="200" placeholder="例：紅茶 茶葉01 ×2 / 氷あり" value="${e(paperNote)}" ${paperPending?'disabled':''}></label><button class="primary" type="submit" ${!connected||!storageOK||busy?'disabled':''}>${paperPending?'登録結果の確認・再送':'準備中に追加'}</button>${paperPending?'<p class="lock-message">結果を確認するまで番号・内容は固定されます。</p>':''}</form>`:''}<div class="kitchen-info"><span>音声 ${state.audio.expires>Date.now()?'接続中':'停止中'} · 呼出待ち ${state.audio.pending}件</span>${state.audio.failed.length?'<span class="alert-inline">音声の未確認・失敗あり。番号を確認し、必要な場合は再呼出してください。</span>':''}</div><div class="kitchen-columns"><section><div class="column-title"><h2>準備中</h2><span>${waiting.length}</span></div><div class="order-grid">${waiting.map(orderCard).join('')||'<p class="empty">準備中の注文はありません。</p>'}</div></section><section><div class="column-title"><h2>お渡し待ち</h2><span>${ready.length}</span></div><div class="order-grid">${ready.map(orderCard).join('')||'<p class="empty">完成した注文がここに並びます。</p>'}</div></section></div><details class="completed"><summary>提供済み・取消の履歴</summary>${state.orders.filter(o=>['served','cancelled'].includes(o.status)).slice(0,30).map(o=>`<button class="history-link" data-action="history" data-id="${o.id}"><strong>${o.label}</strong>${badge(o.status)}<span>${time(o.updated_at)}</span></button>`).join('')||'<p class="empty">まだ履歴はありません。</p>'}</details>`;connection(connected);
}
async function submitPaper(){
  if(busy||!storageOK)return;paperPending??={requestId:id(),sessionId:state.currentSessionId,number:Number(paperNumber),note:paperNote};saveDraft();if(!storageOK)return;busy=true;renderKitchen();
  try{const o=await api('/api/paper-orders',paperPending);paperPending=null;paperNumber='';paperNote='';saveDraft();await refresh(false);toast(`${o.label}を準備中に追加しました。`);}
  catch(error){if(error.status>=400&&error.status<500&&![401,429].includes(error.status)){paperPending=null;saveDraft();}toast(error.message);}
  finally{busy=false;renderKitchen();}
}
function metrics(){
  const count=state.totals.products.reduce((n,p)=>n+p.quantity,0);
  const values=mode==='cashier'?[['売上',yen(state.totals.revenue)],['会計件数',`${state.totals.orders} 件`],['販売杯数',`${count} 杯`],['取消件数',`${state.totals.cancelled} 件`]]:mode==='kitchen'?[['受付数',`${state.orders.filter(o=>o.status!=='cancelled').length} 組`],['準備中',`${state.totals.waiting} 組`],['お渡し待ち',`${state.totals.ready} 組`],['提供済み',`${state.totals.served} 組`]]:[['売上',yen(state.totals.revenue)],['会計件数',`${state.totals.orders} 件`],['準備中',`${state.totals.waiting} 組`],['提供済み',`${state.totals.served} 組`]];
  return `<div class="metrics">${values.map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>`;
}
function renderSales(){document.querySelector('#content').innerHTML=heading(mode==='kitchen'?'番号の履歴':'売上・履歴')+`<div class="sales-tools"><label class="field"><span>営業回</span><select id="sales-session">${state.sessions.map(s=>`<option value="${s.id}" ${s.id===state.session.id?'selected':''}>${e(s.name)}</option>`).join('')}</select></label>${mode!=='kitchen'?'<button data-action="export">会計CSV</button>':''}<button data-action="backup">バックアップ</button></div>${mode==='kitchen'?'<p class="hint">独立キッチンの記録は番号管理専用です。売上は会計端末で確認してください。</p>':''}${metrics()}${mode!=='kitchen'?`<section class="panel"><h2>茶葉別の販売</h2><div class="table-wrap"><table><thead><tr><th>茶葉・オプション</th><th>杯数</th><th>金額</th></tr></thead><tbody>${state.totals.products.map(p=>`<tr><td>${e(p.name)}<small>${p.ice!==null?options(p):'旧記録'}</small></td><td>${p.quantity}</td><td>${yen(p.total)}</td></tr>`).join('')||'<tr><td colspan="3">会計の記録はありません。</td></tr>'}</tbody></table></div></section>`:''}<section class="panel recent"><h2>受付履歴</h2><div class="table-wrap"><table><thead><tr><th>番号</th><th>時刻</th><th>注文</th><th>金額</th><th>状態</th><th></th></tr></thead><tbody>${state.orders.map(o=>`<tr><td><strong class="number">${o.label}</strong></td><td>${time(o.created_at)}</td><td>${o.source==='paper'?'注文票の番号管理':e(o.items.map(i=>`${i.name} ×${i.quantity}`).join(' / '))}</td><td>${o.source==='paper'?'—':yen(o.total)}</td><td>${!o.fulfillment&&o.status!=='cancelled'?'<span class="badge">会計登録済み</span>':badge(o.status)}</td><td><button class="small" data-action="history" data-id="${o.id}">詳細</button></td></tr>`).join('')||'<tr><td colspan="6">記録はありません。</td></tr>'}</tbody></table></div></section>`;}
function menuRow(p){return `<div class="menu-row" data-menu-id="${e(p.id)}"><label><span class="sr-only">茶葉名</span><input data-menu-name aria-label="${e(p.id)}の茶葉名" maxlength="40" required value="${e(p.name)}"></label><select data-menu-category aria-label="${e(p.id)}のお茶の種類">${[...new Set(['紅茶','ウーロン茶','緑茶',p.category])].map(c=>`<option ${c===p.category?'selected':''}>${e(c)}</option>`).join('')}</select><select data-menu-price aria-label="${e(p.id)}の価格">${[...new Set([400,500,600,p.price])].sort((a,b)=>a-b).map(n=>`<option value="${n}" ${p.price===n?'selected':''}>${yen(n)}</option>`).join('')}</select><label class="active-check"><input data-menu-active type="checkbox" ${p.active?'checked':''}>販売</label></div>`;}
function renderSettings(){document.querySelector('#content').innerHTML=heading(mode==='kitchen'?'営業設定':'茶葉・営業設定')+`<div class="settings-layout ${mode==='kitchen'?'kitchen-settings':''} ">${mode!=='kitchen'?`<form id="menu-form" class="panel"><div class="cart-title"><h2>茶葉メニュー</h2><button class="primary" type="submit">保存</button></div><p class="hint">30種の仮枠は各茶種10枠、初期価格¥400。¥400・¥500・¥600から選択できます。氷・ミルクはそれぞれ1杯につき¥50です。</p><div id="menu-rows">${state.menu.map(menuRow).join('')}</div></form>`:''}<aside><section class="panel"><h2>営業回の切り替え</h2><p class="hint">${mode==='cashier'?'会計の記録は保存されます。キッチン側も同じ営業回名に揃えてください。':'未提供の注文がある間は切り替えできません。過去の記録は保存されます。'}</p><label class="field"><span>新しい営業回の名前</span><input id="session-name" maxlength="40" placeholder="例：学祭 2日目"></label><label class="field"><span>開始番号</span><input id="start-number" type="number" min="1" max="9999" step="1" value="1"></label><button class="wide" data-action="new-session">営業回を切り替える</button></section><section class="panel recent"><h2>この端末の運用</h2><p>${mode==='shared'?'ネットワーク連携':mode==='cashier'?'独立・会計':'独立・キッチン'}</p><p class="hint">${mode==='shared'?'キッチンPCで起動し、会計スマホは表示された接続先を開きます。':'各端末が自身の記録を保存します。番号・注文内容は紙の注文票で引き継ぎます。'}</p>${mode!=='cashier'?'<a class="button" href="/display?setup=1" target="_blank" rel="noopener">番号表示・音量調節 ↗</a>':''}</section></aside></div>`;}
function render(){({home,cashier:renderCashier,kitchen:renderKitchen,sales:renderSales,settings:renderSettings}[route]||home)();}
async function refresh(update=true){
  const old=state;state=await api(`/api/state${selectedSession?`?session=${encodeURIComponent(selectedSession)}`:''}`);mode=state.mode;connection(true);
  if(!update)return;
  if(!old){shell();render();}
  else if(route==='cashier'){if(old.menuRevision!==state.menuRevision||old.currentSessionId!==state.currentSessionId){renderCashier();toast('営業回またはメニューが変わりました。金額を確認してください。');}else renderCart();}
  else if(route==='kitchen'&&JSON.stringify([old.orders,old.audio.pending,old.audio.failed,old.audio.expires>Date.now()])!==JSON.stringify([state.orders,state.audio.pending,state.audio.failed,state.audio.expires>Date.now()]))renderKitchen();
  else if(route==='sales'&&JSON.stringify(old.orders)!==JSON.stringify(state.orders))renderSales();
}
function startPolling(){clearTimeout(pollTimer);const tick=async()=>{try{await refresh();}catch(error){connection(false);if(route==='cashier'&&state)renderCart();}pollTimer=setTimeout(tick,1500);};pollTimer=setTimeout(tick,1500);}
async function boot(){
  if(isDisplay){bootDisplay({app,api,id,toast});return;}
  try{loadDraft();state=undefined;await refresh();startPolling();}
  catch(error){app.innerHTML=`<main class="connection-page"><div class="connection-card">${brand()}<h1>接続を確認してください</h1><p>${e(error.message)}</p><button data-action="reload">再読み込み</button></div></main>`;}
}
async function backup(){const res=await fetch('/api/backup',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});if(!res.ok)throw new Error((await res.json()).error);const url=URL.createObjectURL(await res.blob()),a=document.createElement('a');a.href=url;a.download=`teatime-backup-${Date.now()}.sqlite`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function mergeVariant(index,option){const changed={...cart[index],[option]:!cart[index][option]},other=cart.findIndex((i,n)=>n!==index&&variants(i)===variants(changed));if(other>=0){if(cart[other].quantity+changed.quantity>99){toast('同じ茶葉・オプションは99杯までです。');return;}cart[other].quantity+=changed.quantity;cart.splice(index,1);}else cart[index]=changed;}
// Confirmed payload is copied to the persistent pending request before closing the dialog.
modal.addEventListener('close',()=>{confirmed=null;});
document.addEventListener('input',event=>{
  const target=event.target;
  if(target.id==='tendered'){tendered=target.value;saveDraft();renderCart();}
  if(target.id==='note'){note=target.value;saveDraft();}
  if(target.id==='tea-search'){search=target.value;renderProducts();}
  if(target.id==='paper-number'){paperNumber=target.value;saveDraft();}
  if(target.id==='paper-note'){paperNote=target.value;saveDraft();}
});
document.addEventListener('change',async event=>{
  const target=event.target;
  if(target.id==='pick-ice')ice=target.checked;if(target.id==='pick-milk')milk=target.checked;
  if(target.id==='sales-session'){selectedSession=target.value;try{await refresh(false);renderSales();}catch(error){toast(error.message);}}
});
document.addEventListener('submit',async event=>{
  if(!['menu-form','paper-form'].includes(event.target.id))return;event.preventDefault();
  try{
    if(event.target.id==='menu-form'){const products=[...document.querySelectorAll('[data-menu-id]')].map(row=>({id:row.dataset.menuId,name:row.querySelector('[data-menu-name]').value,price:Number(row.querySelector('[data-menu-price]').value),category:row.querySelector('[data-menu-category]').value,active:row.querySelector('[data-menu-active]').checked}));await api('/api/menu',{products,revision:state.menuRevision});await refresh(false);renderSettings();toast('茶葉メニューを保存しました。');}
    if(event.target.id==='paper-form')await submitPaper();
  }catch(error){toast(error.message);}
});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button||button.disabled)return;const action=button.dataset.action;
  try{
    if(action==='close'){closeDialog();return;}if(action==='reload'){location.reload();return;}
    if(action==='category'){category=button.dataset.category;renderProducts();return;}
    if(['add-tea','qty','line-option','clear','exact'].includes(action)&&!pending&&!busy){
      if(action==='add-tea'){const item={productId:button.dataset.product,quantity:1,ice,milk},old=cart.find(i=>variants(i)===variants(item));if(old){if(old.quantity>=99){toast('99杯までです。');return;}old.quantity++;}else cart.push(item);}
      if(action==='qty'){const n=Number(button.dataset.index);cart[n].quantity=Math.min(99,cart[n].quantity+Number(button.dataset.delta));if(cart[n].quantity<=0)cart.splice(n,1);}
      if(action==='line-option')mergeVariant(Number(button.dataset.index),button.dataset.option);
      if(action==='clear'){cart=[];tendered='';note='';document.querySelector('#tendered').value='';document.querySelector('#note').value='';}
      if(action==='exact'){tendered=String(total());document.querySelector('#tendered').value=tendered;}
      saveDraft();renderCart();return;
    }
    if(action==='checkout'){confirmCheckout();return;}if(action==='register'){await submitOrder();return;}
    if(action==='status'){button.disabled=true;await api(`/api/orders/${button.dataset.id}/status`,{expected:button.dataset.expected,status:button.dataset.status});await refresh(false);renderKitchen();return;}
    if(action==='recall'){openDialog(`<h2>もう一度呼び出しますか？</h2><div class="dialog-actions"><button data-action="close">戻る</button><button class="primary" data-action="recall-confirm" data-id="${button.dataset.id}" data-request="${id()}">再呼出</button></div>`);return;}
    if(action==='recall-confirm'){button.disabled=true;await api(`/api/orders/${button.dataset.id}/recall`,{requestId:button.dataset.request});closeDialog();return;}
    if(action==='cancel'){const o=state.orders.find(o=>o.id===button.dataset.id);openDialog(`<h2>${o.source==='paper'?'番号登録の取消':'取消・返金'}</h2><p>${o.source==='paper'?'会計係へ取消を伝えてください。':'返金はスタッフが行い、記録した売上から除外します。'}</p><label class="field"><span>理由</span><textarea id="cancel-reason" maxlength="200"></textarea></label><div class="dialog-actions"><button data-action="close">戻る</button><button class="danger" data-action="cancel-confirm" data-id="${o.id}" data-expected="${o.status}">取消を記録</button></div>`);return;}
    if(action==='cancel-confirm'){await api(`/api/orders/${button.dataset.id}/status`,{expected:button.dataset.expected,status:'cancelled',reason:document.querySelector('#cancel-reason').value});closeDialog();await refresh(false);render();return;}
    if(action==='history'){const o=state.orders.find(o=>o.id===button.dataset.id),history=await api(`/api/orders/${o.id}/history`);openDialog(`<h2>受付番号 ${o.label}</h2>${o.items.map(i=>`<p>${e(i.name)} ×${i.quantity}<small>${i.ice===null?'旧記録':options(i)}</small></p>`).join('')}${o.source==='cashier'?`<p>合計 ${yen(o.total)} ／ お釣り ${yen(o.change)}</p>`:''}${o.note?`<p>${e(o.note)}</p>`:''}${history.map(h=>`<div class="history-row"><time>${date(h.created_at)}</time><strong>${actions[h.action]||e(h.action)}</strong><span>${e(h.reason)}</span></div>`).join('')}<div class="dialog-actions">${o.session_id===state.currentSessionId&&['waiting','ready'].includes(o.status)?`<button class="danger" data-action="cancel" data-id="${o.id}" data-expected="${o.status}">取消・返金</button>`:''}<button data-action="close">閉じる</button></div>`);return;}
    if(action==='export'){location.href=`/api/export?session=${encodeURIComponent(state.session.id)}`;return;}
    if(action==='backup'){button.disabled=true;try{await backup();toast('バックアップを保存しました。');}finally{button.disabled=false;}return;}
    if(action==='new-session'){const name=document.querySelector('#session-name').value,startNumber=Number(document.querySelector('#start-number').value);if(!name.trim()||!Number.isInteger(startNumber)||startNumber<1||startNumber>9999){toast('営業回の名前と開始番号を確認してください。');return;}openDialog(`<h2>営業回を切り替えますか？</h2><p>${e(name)} ／ 開始番号 ${startNumber}</p><div class="dialog-actions"><button data-action="close">戻る</button><button class="primary" data-action="session-confirm" data-name="${e(name)}" data-number="${startNumber}" data-previous="${state.currentSessionId}">切り替える</button></div>`);return;}
    if(action==='session-confirm'){button.disabled=true;await api('/api/sessions',{name:button.dataset.name,startNumber:Number(button.dataset.number),previousId:button.dataset.previous});closeDialog();await refresh(false);renderSettings();toast('営業回を切り替えました。');}
  }catch(error){button.disabled=false;toast(error.message);}
});
window.addEventListener('offline',()=>{if(!isDisplay)connection(false);});
boot();




