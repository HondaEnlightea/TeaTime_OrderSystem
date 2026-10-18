import {bootDisplay} from './display.js';
import {createCashierAdmin} from './cashier-admin.js';
import {createOfflineRegister,openLedger} from './offline.js';
import {createClientReset} from './client-reset.js';
import {separateCups,groupCups,appendCup,toggleCup} from './cart.js';
import {salesSummary,summaryCsvRows,detailCsvRows,csvText} from './reports.js';
const app=document.querySelector('#app'),modal=document.querySelector('#modal');
let route=location.pathname==='/'?'home':location.pathname.slice(1),isDisplay=route==='display';
const labels={waiting:'準備中',ready:'提供可能',served:'提供済み',cancelled:'取消'};
const actions={registered:'注文登録',ready:'完成・呼び出し',served:'お渡し完了',cancelled:'取消',recalled:'再呼び出し',accounted:'会計同期'};
const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yen=n=>`¥${Number(n).toLocaleString('ja-JP')}`;
const time=v=>new Date(v).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'});
const date=v=>new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
const id=()=>[...crypto.getRandomValues(new Uint8Array(16))].map(v=>v.toString(16).padStart(2,'0')).join('');
let serverState,offline,ledgerReady=false,networkWork=false;
let state,mode='shared',cart=[],tendered='',note='',pending=null,confirmed=null,storageOK=true,busy=false,connected=false,pollTimer,toastTimer,selectedSession='',category='紅茶',search='';
let paperNumber='',paperNote='',paperPending=null;
const draftKey='teatime-draft-v2',paperKey='teatime-paper-v1';
let resetLedger;
const resetTestClient=createClientReset({storage:{getItem:key=>localStorage.getItem(key),removeItem:key=>localStorage.removeItem(key),setItem:(key,value)=>localStorage.setItem(key,value)},clearLedger:()=>{resetLedger??=openLedger();return resetLedger.clear();}});
const options=i=>[i.ice?'氷 +¥50':'',i.milk?'ミルク +¥50':''].filter(Boolean).join(' / ')||'オプションなし';
function toast(message){clearTimeout(toastTimer);document.querySelector('#toast').textContent=message;toastTimer=setTimeout(()=>document.querySelector('#toast').textContent='',7000);}
async function api(path,body){
  let res;try{res=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(path.startsWith('/api/state')?2500:7000),cache:'no-store'});}catch{const err=new Error('接続できません。起動状態と、連携運用の場合はネットワークを確認してください。');err.network=true;throw err;}
  const data=await res.json();if(!res.ok){const err=new Error(data.error||'操作できませんでした。');err.status=res.status;throw err;}return data;
}
function loadDraft(){
  try{
    let v=JSON.parse(localStorage.getItem(draftKey)||'null');
    if(!v){const old=JSON.parse(localStorage.getItem('teatime-draft-v1')||'null');if(old)v={...old,cart:Object.entries(old.cart||{}).filter(([,q])=>q>0).map(([productId,quantity])=>({productId,quantity,ice:false,milk:false}))};}
    if(v){cart=Array.isArray(v.cart)?separateCups(v.cart):[];tendered=v.tendered??'';note=v.note??'';pending=v.pending??null;}
    const p=JSON.parse(localStorage.getItem(paperKey)||'null');if(p){paperNumber=p.number??'';paperNote=p.note??'';paperPending=p.pending??null;}
  }catch{storageOK=false;}
}
function saveDraft(){try{localStorage.setItem(draftKey,JSON.stringify({cart,tendered,note,pending}));localStorage.setItem(paperKey,JSON.stringify({number:paperNumber,note:paperNote,pending:paperPending}));}catch{storageOK=false;toast('再送情報を保存できません。ブラウザのサイトデータ保存を許可してください。');}}
function connection(ok){const changed=connected!==ok;connected=ok;document.querySelectorAll('[data-connection]').forEach(el=>{el.textContent=ok?(mode==='shared'?'連携中':'この端末で稼働中'):'接続なし';el.classList.toggle('offline',!ok);});document.querySelector('#offline')?.classList.toggle('hidden',ok);updateConnectionWarning();document.querySelectorAll('[data-online]').forEach(el=>el.disabled=!ok||busy);if(changed&&state&&route==='cashier'&&document.querySelector('#checkout'))renderCart();}
function brand(){return '<a class="brand" href="/"><img src="/favicon.svg" alt=""><strong>ティータイム同好会<br>オーダーシステム</strong></a>';}
function badge(status){return `<span class="badge ${e(status)}">${labels[status]}</span>`;}
function heading(title,sub=''){return `<div class="heading"><div><h1>${title}</h1>${sub?`<p>${sub}</p>`:''}</div><span class="session-chip">${e(state.session.name)}</span></div>`;}
function shell(){
  const station=mode==='kitchen'||route==='kitchen'?'kitchen':'cashier';
  const tabs=[['cashier','注文・会計'],['history','注文履歴'],['sales','売り上げ'],['menu','メニュー変更'],['staff-menu','メニュー説明']];
  app.innerHTML=`<div class="shell"><header class="topbar">${brand()}<div class="top-right"><span class="connection" data-connection></span>${station==='kitchen'?'<a class="station-link" href="/kitchen">キッチン</a><a class="station-link" href="/display?setup=1" target="_blank" rel="noopener">番号表示 ↗</a>':''}<details class="admin-menu"><summary>管理</summary><div>${station==='kitchen'?'<a href="/sales">番号の履歴</a>':''}<a href="/settings">営業設定</a></div></details></div></header>${station==='cashier'?`<nav class="cashier-nav" aria-label="会計メニュー">${tabs.map(([path,label])=>`<a href="/${path}" ${route===path?'aria-current="page"':''}>${label}</a>`).join('')}</nav>`:''}<main class="main"><div id="offline" class="alert hidden" role="alert">接続が切れています。表示は最後に確認できた状態です。登録結果が不明な場合は、同じ注文を再送してください。</div><div id="content"></div></main></div>`;connection(connected);
}
function home(){document.querySelector('#content').innerHTML=heading('操作画面を選択')+`<div class="home-stations">${mode!=='kitchen'?'<a class="station-card" href="/cashier"><h2>注文・会計</h2><p>茶葉とオプションを選び、受付番号をお渡しします。</p><span>会計画面へ →</span></a>':''}${mode!=='cashier'?'<a class="station-card" href="/kitchen"><h2>キッチン・お渡し</h2><p>完成したお茶を呼び出し、お渡しまで管理します。</p><span>キッチン画面へ →</span></a>':''}${mode!=='cashier'?'<a class="station-card" href="/display?setup=1" target="_blank" rel="noopener"><h2>番号表示</h2><p>お客様向けの受付番号と呼び出し音声を準備します。</p><span>番号表示を新しいタブで開く ↗</span></a>':''}</div><p class="hint">${mode==='shared'?'連携運用：会計端末では「注文・会計」、キッチンPCでは「キッチン」を開きます。':'独立運用：注文票で受付番号と注文内容をキッチンへ渡します。'}</p>`;}
function cartItems(){return cart.map(i=>{const p=state.menu.find(p=>p.id===i.productId);return {...i,...p,unit_price:(p?.price??0)+(i.ice?50:0)+(i.milk?50:0)};});}
function total(){return cartItems().reduce((n,i)=>n+i.unit_price*i.quantity,0);}
function renderProducts(){
  const products=state.menu.filter(p=>(category==='紅茶'?p.category==='紅茶':p.category!=='紅茶')&&p.name.toLowerCase().includes(search.toLowerCase()));
  document.querySelector('#products').innerHTML=products.map(p=>`<button class="tea-card ${p.active?'':'sold-out'}" data-action="add-tea" data-product="${e(p.id)}" ${pending||busy||!p.active?'disabled':''}><span class="tea-index">${String(state.menu.indexOf(p)+1).padStart(2,'0')}</span><strong>${e(p.name)}</strong><span>${yen(p.price)} ${p.active?'<b aria-hidden="true">＋</b>':'<span class="sold-out-label">売り切れ</span>'}</span></button>`).join('')||'<p class="empty">該当する茶葉はありません。</p>';
  document.querySelectorAll('[data-action="category"]').forEach(el=>{el.classList.toggle('active',el.dataset.category===category);el.setAttribute('aria-selected',String(el.dataset.category===category));});
}
function renderCashier(){
  const categories=['紅茶','緑茶など'];if(!categories.includes(category))category=categories[0]||'紅茶';
  document.querySelector('#content').innerHTML=heading('注文・会計')+`<div class="cashier-layout"><section class="tea-selection"><div class="tea-tools"><div class="tea-tabs" role="tablist" aria-label="お茶の種類">${categories.map(c=>`<button role="tab" data-action="category" data-category="${e(c)}">${e(c)}</button>`).join('')}</div><input id="tea-search" type="search" placeholder="茶葉を探す" aria-label="茶葉を探す" value="${e(search)}"></div><div id="products" class="tea-grid"></div>${state.catalogTemplate?'<p class="hint">茶葉名は仮の30枠です。「メニュー変更」で当日の名前・価格に変更してください。</p>':''}</section><aside class="panel cart" id="current-order"><div class="cart-title"><h2>今回の注文</h2><button class="text-button" data-action="clear">クリア</button></div><div id="draft-alert"></div><div id="cart-lines"></div><div class="total"><span>合計</span><strong id="total"></strong></div><label class="field"><span>お預かり（円）</span><input id="tendered" type="number" inputmode="numeric" min="0" max="1000000" step="1" value="${e(tendered)}" placeholder="金額を入力"></label><div class="cash-keypad" role="group" aria-label="お預かり金額のテンキー">${['7','8','9','4','5','6','1','2','3','clear','0','backspace'].map(key=>`<button type="button" data-action="cash-key" data-key="${key}" aria-label="${key==='clear'?'お預かり金額をクリア':key==='backspace'?'1桁削除':key+'を入力'}" class="${/^\d$/.test(key)?'':'cash-key-edit'}">${key==='clear'?'クリア':key==='backspace'?'⌫':key}</button>`).join('')}</div><button class="text-button" data-action="exact">ちょうどのお支払い</button><div class="change"><span>お釣り</span><strong id="change"></strong></div><details class="order-memo"><summary>備考を追加</summary><textarea id="note" maxlength="200" aria-label="注文の備考">${e(note)}</textarea></details><div id="pending-info"></div><button id="checkout" class="primary wide" data-action="checkout">会計を確認</button></aside></div><section class="recent-history panel"><div class="cart-title"><h2>直近の注文</h2><a href="/history">履歴をすべて見る →</a></div><div id="recent-orders"></div></section><section id="offline-preparation" class="offline-preparation cashier-support" aria-label="通信・同期"></section><div class="mobile-cart-summary"><div><span id="mobile-cups"></span><strong id="mobile-total"></strong></div><button class="primary" data-action="cart-jump">注文・オプションへ ↓</button></div>`;renderProducts();renderCart();admin.renderRecent();
}
function renderCart(){
  const items=cartItems(),sum=total(),locked=Boolean(pending)||busy;
  document.querySelector('#cart-lines').innerHTML=items.length?items.map((i,n)=>`<div class="cart-line"><div><span class="cup-index">${n+1}杯目</span><strong>${e(i.name||'変更された茶葉')}</strong><small>${yen(i.unit_price)} / 杯</small><div class="line-options" aria-label="この1杯のオプション">${['ice','milk'].map(option=>`<button data-action="line-option" data-index="${n}" data-option="${option}" aria-label="${n+1}杯目 ${e(i.name)}の${option==='ice'?'氷':'ミルク'}" aria-pressed="${i[option]}"><span>${option==='ice'?'氷':'ミルク'} <small>+¥50 / 杯</small></span><strong>${i[option]?'✓ あり':'なし'}</strong></button>`).join('')}</div><button class="text-button remove-cup" data-action="remove-cup" data-index="${n}" aria-label="${n+1}杯目 ${e(i.name)}を削除">この1杯を削除</button></div><strong>${yen(i.unit_price)}</strong></div>`).join(''):'<p class="cart-empty">茶葉を選んでください。</p>';
  document.querySelector('#total').textContent=yen(sum);document.querySelector('#change').textContent=tendered===''?'—':Number(tendered)>=sum?yen(Number(tendered)-sum):'お預かり不足';
  document.querySelectorAll('[data-action="remove-cup"],[data-action="line-option"],[data-action="clear"],[data-action="exact"],[data-action="cash-key"],#tendered,#note').forEach(el=>el.disabled=locked);
  document.querySelectorAll('[data-action="add-tea"]').forEach(el=>el.disabled=locked||!state.menu.find(p=>p.id===el.dataset.product)?.active);
  const mobileCups=document.querySelector('#mobile-cups');if(mobileCups){mobileCups.textContent=items.reduce((n,i)=>n+i.quantity,0)+'杯';document.querySelector('#mobile-total').textContent=yen(sum);}
  const invalid=cart.some(i=>!state.menu.some(p=>p.id===i.productId&&p.active));
  document.querySelector('#draft-alert').innerHTML=invalid&&!pending?'<p class="alert">選択した茶葉が販売停止・削除されました。クリアして選び直してください。</p>':!storageOK?'<p class="alert">端末への保存ができないため、登録を止めています。</p>':'';
  document.querySelector('#pending-info').innerHTML=pending?'<p class="lock-message">登録結果を確認するまで内容は固定されます。同じ注文を再送してください。</p>':'';
  renderPreparation();
  const checkout=document.querySelector('#checkout');checkout.textContent=busy?'登録結果を確認中…':pending?'登録結果の確認・再送':'会計を確認';checkout.disabled=busy||!(mode==='shared'?ledgerReady&&(offline?.info(state.menuRevision,state.currentSessionId).remaining>0||pending?.offlinePrepared&&offline.entries().some(e=>e.payload.requestId===pending.requestId))||pending&&!pending.offlinePrepared&&connected:connected)||!storageOK||(!pending&&(invalid||!items.length||tendered===''||!Number.isSafeInteger(Number(tendered))||Number(tendered)<sum));
}
function openDialog(html){modal.innerHTML=html;modal.showModal();}
function closeDialog(){modal.close();}
function confirmCheckout(){
  if(pending){submitOrder();return;}const items=cartItems();
  confirmed={requestId:id(),sessionId:state.currentSessionId,menuRevision:state.menuRevision,items:groupCups(cart),tendered:Number(tendered),note};
  openDialog(`<h2>会計の確認</h2>${items.map((i,n)=>`<div class="cart-line"><div><span class="cup-index">${n+1}杯目</span>${e(i.name)}<small>${options(i)}</small></div><strong>${yen(i.unit_price)}</strong></div>`).join('')}<div class="total"><span>合計</span><strong>${yen(total())}</strong></div><p>お預かり ${yen(tendered)} ／ お釣り ${yen(Number(tendered)-total())}</p>${note?`<p>${e(note)}</p>`:''}<p class="note">代金を受け取ってから登録してください。</p><div class="dialog-actions"><button data-action="close">戻る</button><button class="primary" data-action="register">受領・注文登録</button></div>`);
}
async function submitOrder(){
  if(busy)return;
  if(!pending){if(!confirmed)return;pending={...confirmed,...(mode==='shared'?{offlinePrepared:true}:{})};saveDraft();if(!storageOK){pending=null;closeDialog();renderCart();return;}}
  busy=true;closeDialog();renderCart();
  try{
    let order;
    if(mode==='shared'&&pending.offlinePrepared){
      if(!ledgerReady)throw Error('端末保存の準備を確認してください。');
      order=await offline.accept(pending);
    }else order=await api('/api/orders',pending);
    const requestId=pending.requestId;
    pending=null;cart=[];tendered='';note='';saveDraft();ledgerChanged();
    if(mode!=='shared')await refresh(false).catch(()=>connection(false));
    renderCashier();
    openDialog(`<div class="receipt"><h2>受付番号</h2><div class="receipt-number">${order.label}</div><p>合計 ${yen(order.total)} ／ お釣り ${yen(order.change)}</p><p class="note">注文票とお客様控えに番号を記入してください。${mode==='cashier'?'注文票をキッチンへ渡してください。':''}</p><p id="receipt-sync" data-request="${requestId}" class="receipt-sync">${order.local?'端末に保存しました。紙の注文票をキッチンへ渡してください。':'登録しました。'}</p><button class="primary wide" data-action="close">次の注文へ</button></div>`);
    if(mode==='shared'&&connected)offline.sync().catch(()=>connection(false));
  }catch(error){
    if(mode!=='shared'&&error.status>=400&&error.status<500&&![401,429].includes(error.status)){pending=null;saveDraft();await refresh(false).catch(()=>{});}
    toast(error.message);
  }finally{busy=false;renderCart();}
}
function orderCard(o){return `<article class="order-card ${o.status}"><div class="order-top"><strong class="number">${o.label}</strong><span>${time(o.created_at)}</span></div>${o.items.length?`<ul class="order-items">${o.items.map(i=>`<li><div>${e(i.name)}${i.ice!==null?`<small>${options(i)}</small>`:''}</div><strong>×${i.quantity}</strong></li>`).join('')}</ul>`:''}${o.note?`<p class="order-note">${e(o.note)}</p>`:''}<div class="order-actions"><button class="primary" data-online data-action="status" data-id="${o.id}" data-expected="${o.status}" data-status="${o.status==='waiting'?'ready':'served'}">${o.status==='waiting'?'完成・呼び出し':'お渡し完了'}</button>${o.status==='ready'?`<button data-online data-action="recall" data-id="${o.id}">再呼出</button>`:''}<button class="text-button" data-online data-action="cancel" data-id="${o.id}" data-expected="${o.status}">取消</button></div></article>`;}
function renderKitchen(){
  const focused=document.activeElement,focusId=['paper-number','paper-note'].includes(focused?.id)?focused.id:'',position=focused?.selectionStart;
  const waiting=state.orders.filter(o=>o.fulfillment&&o.status==='waiting').reverse(),ready=state.orders.filter(o=>o.fulfillment&&o.status==='ready').reverse();
  document.querySelector('#content').innerHTML=heading('キッチン・お渡し',mode==='kitchen'?'注文票の受付番号を入力して、完成したら呼び出してください。':'会計で登録された注文が届きます。切断中は、紙の注文票の番号を手入力してください。')+`${mode!=='cashier'?`<form id="paper-form" class="paper-entry panel"><label class="field"><span>注文票の受付番号</span><input id="paper-number" type="number" min="1" max="9999" step="1" inputmode="numeric" required value="${e(paperNumber)}" ${paperPending?'disabled':''}></label><label class="field"><span>注文票の内容（任意）</span><input id="paper-note" maxlength="200" placeholder="例：紅茶 茶葉01 ×2 / 氷あり" value="${e(paperNote)}" ${paperPending?'disabled':''}></label><button class="primary" type="submit" ${!connected||!storageOK||busy?'disabled':''}>${paperPending?'登録結果の確認・再送':'準備中に追加'}</button>${paperPending?'<p class="lock-message">結果を確認するまで番号・内容は固定されます。</p>':''}</form>`:''}<div class="kitchen-info"><span>音声 ${state.audio.expires>Date.now()?'接続中':'停止中'} · 呼出待ち ${state.audio.pending}件</span>${state.audio.failed.length?'<span class="alert-inline">音声の未確認・失敗あり。番号を確認し、必要な場合は再呼出してください。</span>':''}</div><div class="kitchen-columns"><section><div class="column-title"><h2>準備中</h2><span>${waiting.length}</span></div><div class="order-grid">${waiting.map(orderCard).join('')||'<p class="empty">準備中の注文はありません。</p>'}</div></section><section><div class="column-title"><h2>お渡し待ち</h2><span>${ready.length}</span></div><div class="order-grid">${ready.map(orderCard).join('')||'<p class="empty">完成した注文がここに並びます。</p>'}</div></section></div><details class="completed"><summary>提供済み・取消の履歴</summary>${state.orders.filter(o=>['served','cancelled'].includes(o.status)).slice(0,30).map(o=>`<button class="history-link" data-action="history" data-id="${o.id}"><strong>${o.label}</strong>${badge(o.status)}<span>${time(o.updated_at)}</span></button>`).join('')||'<p class="empty">まだ履歴はありません。</p>'}</details>`;connection(connected);const input=focusId&&document.getElementById(focusId);if(input&&!input.disabled){input.focus();if(focusId==='paper-note'&&position!==null)input.setSelectionRange(position,position);}
}
async function submitPaper(){
  if(busy||!storageOK)return;paperPending??={requestId:id(),sessionId:state.currentSessionId,number:Number(paperNumber),note:paperNote};saveDraft();if(!storageOK)return;busy=true;renderKitchen();
  try{const o=await api('/api/paper-orders',paperPending);paperPending=null;paperNumber='';paperNote='';saveDraft();await refresh(false);toast(o.status==='waiting'?`${o.label}を準備中に追加しました。`:`${o.label}は既に${labels[o.status]}として記録されています。`);}
  catch(error){if(error.status>=400&&error.status<500&&![401,429].includes(error.status)){paperPending=null;saveDraft();}toast(error.message);}
  finally{busy=false;renderKitchen();}
}
function metrics(){
  const count=state.totals.products.reduce((n,p)=>n+p.quantity,0);
  const values=mode==='cashier'?[['売上',yen(state.totals.revenue)],['会計件数',`${state.totals.orders} 件`],['販売杯数',`${count} 杯`],['取消件数',`${state.totals.cancelled} 件`]]:mode==='kitchen'?[['受付数',`${state.orders.filter(o=>o.status!=='cancelled').length} 組`],['準備中',`${state.totals.waiting} 組`],['お渡し待ち',`${state.totals.ready} 組`],['提供済み',`${state.totals.served} 組`]]:[['売上',yen(state.totals.revenue)],['会計件数',`${state.totals.orders} 件`],['準備中',`${state.totals.waiting} 組`],['提供済み',`${state.totals.served} 組`]];
  return `<div class="metrics">${values.map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>`;
}
function renderKitchenHistory(){document.querySelector('#content').innerHTML=heading(mode==='kitchen'?'番号の履歴':'売上・履歴')+`<div class="sales-tools"><label class="field"><span>営業回</span><select id="sales-session">${state.sessions.map(s=>`<option value="${s.id}" ${s.id===state.session.id?'selected':''}>${e(s.name)}</option>`).join('')}</select></label>${mode!=='kitchen'?'<button data-action="export">会計CSV</button>':''}<button data-action="backup">バックアップ</button></div>${mode==='kitchen'?'<p class="hint">独立キッチンの記録は番号管理専用です。売上は会計端末で確認してください。</p>':''}${metrics()}${mode!=='kitchen'?`<section class="panel"><h2>茶葉別の販売</h2><div class="table-wrap"><table><thead><tr><th>茶葉・オプション</th><th>杯数</th><th>金額</th></tr></thead><tbody>${state.totals.products.map(p=>`<tr><td>${e(p.name)}<small>${p.ice!==null?options(p):'旧記録'}</small></td><td>${p.quantity}</td><td>${yen(p.total)}</td></tr>`).join('')||'<tr><td colspan="3">会計の記録はありません。</td></tr>'}</tbody></table></div></section>`:''}<section class="panel recent"><h2>受付履歴</h2><div class="table-wrap"><table><thead><tr><th>番号</th><th>時刻</th><th>注文</th><th>金額</th><th>状態</th><th></th></tr></thead><tbody>${state.orders.map(o=>`<tr><td><strong class="number">${o.label}</strong></td><td>${time(o.created_at)}</td><td>${o.source==='paper'?'注文票の番号管理':e(o.items.map(i=>`${i.name} ×${i.quantity}`).join(' / '))}</td><td>${o.source==='paper'?'—':yen(o.total)}</td><td>${!o.fulfillment&&o.status!=='cancelled'?'<span class="badge">会計登録済み</span>':badge(o.status)}</td><td><button class="small" data-action="history" data-id="${o.id}">詳細</button></td></tr>`).join('')||'<tr><td colspan="6">記録はありません。</td></tr>'}</tbody></table></div></section>`;}
function renderSettings(){document.querySelector('#content').innerHTML=heading('営業設定')+`<div class="settings-layout kitchen-settings"><aside><section class="panel"><h2>営業回の切り替え</h2><p class="hint">${mode==='cashier'?'会計の記録は保存されます。キッチン側も同じ営業回名に揃えてください。':'未提供の注文がある間は切り替えできません。過去の記録は保存されます。'}</p><label class="field"><span>新しい営業回の名前</span><input id="session-name" maxlength="40" placeholder="例：学祭 2日目"></label><label class="field"><span>開始番号</span><input id="start-number" type="number" min="1" max="9999" step="1" value="1"></label><button class="wide" data-action="new-session">営業回を切り替える</button></section><section class="panel recent"><h2>この端末の運用</h2><p>${mode==='shared'?'ネットワーク連携':mode==='cashier'?'独立・会計':'独立・キッチン'}</p><p class="hint">${mode==='shared'?'キッチンPCで起動し、会計スマホは表示された接続先を開きます。':'各端末が自身の記録を保存します。番号・注文内容は紙の注文票で引き継ぎます。'}</p>${mode!=='cashier'?'<a class="button" href="/display?setup=1" target="_blank" rel="noopener">番号表示・音量調節 ↗</a>':''}</section>${mode==='shared'?`<section class="panel recent"><h2>LAN会計の終了</h2><p class="hint">営業回の切り替え前に、各会計端末で未同期の注文を保存し、予備番号の利用を終了してください。親機に残る割り当ては${state.offlineReservations?.length??0}件です。</p><button data-online data-action="close-reservations">この端末を同期・利用終了</button><label class="field"><span>端末記録の復旧（JSON）</span><input id="ledger-import" type="file" accept="application/json,.json"></label><p class="hint">IP・端末変更時に保存した記録を読み込めます。元の会計端末の使用を止めてから復旧してください。番号の新規割り当ては復旧ファイルからは行いません。</p></section>`:''}</aside></div>`;connection(connected);}
function renderSales(){if(mode==='kitchen')renderKitchenHistory();else admin.renderSales();}
const admin=createCashierAdmin({getState:()=>state,api,refresh,toast,openDialog,id,e,yen,time,date,heading,downloadCsv});
function render(){({home,cashier:renderCashier,kitchen:renderKitchen,sales:renderSales,history:admin.renderHistory,menu:admin.renderMenu,'staff-menu':admin.renderStaff,settings:renderSettings}[route]||home)();}
function mergeStaffState(raw){
  const s=mode==='shared'&&ledgerReady?offline.overlay(raw):raw;
  const active=s.orders.filter(o=>o.status!=='cancelled'),valid=active.filter(o=>o.source==='cashier');
  return {...s,totals:{...s.totals,revenue:valid.reduce((n,o)=>n+o.total,0),orders:valid.length,cancelled:s.orders.filter(o=>o.source==='cashier'&&o.status==='cancelled').length,waiting:active.filter(o=>o.fulfillment&&o.status==='waiting').length,ready:active.filter(o=>o.fulfillment&&o.status==='ready').length,served:active.filter(o=>o.fulfillment&&o.status==='served').length,...salesSummary(s.orders)}};
}
function updateConnectionWarning(){
  if(isDisplay)return;
  const warning=document.querySelector('#connection-warning');if(!warning)return;
  const info=ledgerReady&&state?offline.info(state.menuRevision,state.currentSessionId):{pending:0,errors:0};
  const visible=!connected||info.pending>0||info.errors>0||Boolean(info.error);
  warning.classList.toggle('hidden',!visible);document.body.classList.toggle('staff-warning',visible);
  warning.innerHTML=visible?`<strong aria-hidden="true">!</strong><span>${!connected?'通信切断':info.errors||info.error?'同期を確認':'未同期 '+info.pending+'件'}</span>`:'';
  warning.classList.toggle('pending',connected&&!info.errors&&!info.error);
}
function renderPreparation(){
  const root=document.querySelector('#offline-preparation');if(!root)return;
  if(mode!=='shared'){root.innerHTML='';return;}
  const info=ledgerReady?offline.info(state.menuRevision,state.currentSessionId):{remaining:0,pending:0};
  root.innerHTML=`<div><strong>切断中に使える番号：${info.remaining}件</strong><span>未同期 ${info.pending}件${info.errors?' ／ 要確認 '+info.errors+'件':''}</span></div><p>${!connected?'紙の注文票でキッチンへ渡してください。接続が戻ると自動で同期します。':info.remaining?'番号は端末へ割り当て済みです。':info.ended?'この端末は利用終了しています。再開する場合は予備番号を追加してください。':'予備番号を準備しています。'}</p><div class="offline-tools"><button class="small" data-action="prepare-extra" ${!connected||info.preparing?'disabled':''}>予備番号を追加</button><button class="small" data-action="sync-now" ${!connected||info.syncing?'disabled':''}>再同期</button><button class="small" data-action="ledger-backup">端末記録を保存</button></div>${info.error?`<p class="alert-inline">${e(info.error)}</p>`:''}`;
}
function ledgerChanged(){
  if(serverState)state=mergeStaffState(serverState);updateConnectionWarning();
  if(!document.querySelector('#content'))return;
  if(route==='cashier'&&state){renderPreparation();if(!busy){renderCart();admin.renderRecent();}}
  else if(['history','sales'].includes(route)&&state&&!admin.hasUnsaved()&&!modal.open)admin.update();
  const receipt=document.querySelector('#receipt-sync');
  if(receipt&&ledgerReady){const entry=offline.entries().find(p=>p.payload.requestId===receipt.dataset.request);if(entry)receipt.textContent=entry.synced?'親機への保存が完了しました。':entry.error?'同期を確認してください。端末には保存されています。':'端末に保存しました。紙の注文票をキッチンへ渡してください。';}
}
async function initOffline(){
  if(!offline)offline=createOfflineRegister({api,id,onChange:ledgerChanged});if(!ledgerReady){await offline.init();ledgerReady=true;}
}
async function refresh(update=true){
  let old=state;const wasConnected=connected,raw=await api(`/api/state${selectedSession?`?session=${encodeURIComponent(selectedSession)}`:''}`);
  if(await resetTestClient(raw.clientResetToken)){
    cart=[];tendered='';note='';pending=null;confirmed=null;paperNumber='';paperNote='';paperPending=null;
    offline=undefined;ledgerReady=false;selectedSession='';old=undefined;
  }
  mode=raw.mode;serverState=raw;
  if(mode==='shared'){
    await initOffline();await offline.attach(raw);
  }
  state=mergeStaffState(raw);connection(true);if(ledgerReady&&mode==='shared'&&route==='cashier')renderPreparation();
  if(mode==='shared'&&!networkWork){
    networkWork=true;
    (async()=>{try{await offline.sync();if(route==='cashier')await offline.prepare(raw);}catch(error){if(error.network)connection(false);}finally{networkWork=false;ledgerChanged();}})();
  }
  if(!update)return;
  if(!old){shell();render();}
  else if(route==='cashier'){
    if(old.menuRevision!==state.menuRevision||old.currentSessionId!==state.currentSessionId){renderCashier();toast('営業回またはメニューが変わりました。金額を確認してください。');}
    else{if(!wasConnected)renderCart();if(JSON.stringify(old.orders)!==JSON.stringify(state.orders))admin.renderRecent();}
  }
  else if(route==='kitchen'&&JSON.stringify([old.orders,old.audio.pending,old.audio.failed,old.audio.expires>Date.now()])!==JSON.stringify([state.orders,state.audio.pending,state.audio.failed,state.audio.expires>Date.now()]))renderKitchen();
  else if(['sales','history'].includes(route)&&(old.session.id!==state.session.id||JSON.stringify(old.orders)!==JSON.stringify(state.orders))){if(mode==='kitchen')renderSales();else admin.update();}
  else if(route==='staff-menu'&&old.menuRevision!==state.menuRevision)admin.update();
}
function startPolling(){clearTimeout(pollTimer);const tick=async()=>{try{await refresh();}catch(error){connection(false);}pollTimer=setTimeout(tick,1500);};pollTimer=setTimeout(tick,1500);}
async function boot(){
  if(isDisplay){bootDisplay({app,api,id,toast});return;}
  loadDraft();state=undefined;
  try{await refresh();startPolling();}
  catch(error){
    if(!error.clientReset)try{
      await initOffline();const cached=await offline.cache();
      if(cached?.mode==='shared'){serverState=cached;mode='shared';state=mergeStaffState(cached);connection(false);shell();render();startPolling();return;}
    }catch{}
    connection(false);app.innerHTML=`<main class="connection-page"><div class="connection-card">${brand()}<h1>接続を確認してください</h1><p>${e(error.message)}</p><button data-action="reload">再読み込み</button></div></main>`;
  }
}
function saveFile(text,name,type){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function downloadCsv(kind){const rows=kind?summaryCsvRows(state,kind):detailCsvRows(state);saveFile(csvText(rows),`teatime-${kind||'sales'}.csv`,'text/csv;charset=utf-8');}
async function backup(){const res=await fetch('/api/backup',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});if(!res.ok)throw new Error((await res.json()).error);const url=URL.createObjectURL(await res.blob()),a=document.createElement('a');a.href=url;a.download=`teatime-backup-${Date.now()}.sqlite`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
// Confirmed payload is copied to the persistent pending request before closing the dialog.
modal.addEventListener('close',()=>{confirmed=null;});
document.addEventListener('input',event=>{
  const target=event.target;admin.onInput(target);
  if(target.id==='tendered'){tendered=target.value;saveDraft();renderCart();}
  if(target.id==='note'){note=target.value;saveDraft();}
  if(target.id==='tea-search'){search=target.value;renderProducts();}
  if(target.id==='paper-number'){paperNumber=target.value;saveDraft();}
  if(target.id==='paper-note'){paperNote=target.value;saveDraft();}
});
document.addEventListener('change',async event=>{
  const target=event.target;
  admin.onChange(target);
  if(target.id==='ledger-import'&&target.files[0]){
    try{if(target.files[0].size>10*1024*1024)throw Error('端末記録は10MB以内です。');const count=await offline.importBackup(JSON.parse(await target.files[0].text()));if(connected)await offline.sync(true);await refresh(false);renderSettings();toast(count+'件の記録を照合しました。未同期件数を確認してください。');}catch(error){toast(error.message);}finally{target.value='';}return;
  }
  if(target.id==='sales-session'){selectedSession=target.value;admin.resetHistoryPage();try{await refresh(false);render();}catch(error){toast(error.message);}}
});
document.addEventListener('submit',async event=>{
  if(!['catalog-form','staff-notes-form','paper-form'].includes(event.target.id))return;event.preventDefault();
  try{if(await admin.onSubmit(event.target))return;if(event.target.id==='paper-form')await submitPaper();}catch(error){toast(error.message);}
});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button||button.disabled)return;const action=button.dataset.action;
  try{
    if(action==='close'){closeDialog();return;}if(action==='reload'){location.reload();return;}
    if(action==='prepare-extra'){await offline.prepare(serverState,true);return;}
    if(action==='sync-now'){await offline.sync(true);await refresh(false);ledgerChanged();toast('同期結果を確認しました。');return;}
    if(action==='ledger-backup'){saveFile(JSON.stringify(offline.backup(),null,2),'teatime-terminal-records-'+Date.now()+'.json','application/json');return;}
    if(action==='close-reservations'){openDialog('<h2>この端末の予備番号の利用を終了しますか？</h2><p>未同期の注文をすべて保存し、未使用の番号は使用終了にします。会計を再開する場合は注文・会計画面で新しい番号を準備します。</p><div class="dialog-actions"><button data-action="close">戻る</button><button class="primary" data-action="close-reservations-confirm">同期・利用終了</button></div>');return;}
    if(action==='close-reservations-confirm'){button.disabled=true;await offline.sync(true);await offline.close();closeDialog();await refresh(false);renderSettings();toast('この端末の予備番号の利用を終了しました。');return;}
    if(await admin.onClick(button))return;
    if(action==='cart-jump'){document.querySelector('#current-order').scrollIntoView({behavior:'smooth',block:'start'});return;}
    if(action==='category'){category=button.dataset.category;renderProducts();return;}
    if(['add-tea','remove-cup','line-option','clear','exact'].includes(action)&&!pending&&!busy){
      if(action==='add-tea'){if(!state.menu.find(p=>p.id===button.dataset.product)?.active)return;cart=appendCup(cart,button.dataset.product);}
      if(action==='remove-cup')cart.splice(Number(button.dataset.index),1);
      if(action==='line-option')cart=toggleCup(cart,Number(button.dataset.index),button.dataset.option);
      if(action==='clear'){cart=[];tendered='';note='';document.querySelector('#tendered').value='';document.querySelector('#note').value='';}
      if(action==='exact'){tendered=String(total());document.querySelector('#tendered').value=tendered;}
      saveDraft();renderCart();return;
    }
    if(action==='cash-key'){
      if(pending||busy)return;
      const key=button.dataset.key,current=/^\d*$/.test(tendered)?tendered:'';
      let next;
      if(key==='clear')next='';
      else if(key==='backspace')next=current.slice(0,-1);
      else if(/^\d$/.test(key))next=(current+key).replace(/^0+(?=\d)/,'');
      else return;
      if(Number(next)>1000000){toast('お預かり金額は1,000,000円までです。');return;}
      tendered=next;document.querySelector('#tendered').value=next;saveDraft();renderCart();return;
    }
    if(action==='checkout'){confirmCheckout();return;}if(action==='register'){await submitOrder();return;}
    if(action==='status'){button.disabled=true;await api(`/api/orders/${button.dataset.id}/status`,{expected:button.dataset.expected,status:button.dataset.status});await refresh(false);renderKitchen();return;}
    if(action==='recall'){openDialog(`<h2>もう一度呼び出しますか？</h2><div class="dialog-actions"><button data-action="close">戻る</button><button class="primary" data-action="recall-confirm" data-id="${button.dataset.id}" data-request="${id()}">再呼出</button></div>`);return;}
    if(action==='recall-confirm'){button.disabled=true;await api(`/api/orders/${button.dataset.id}/recall`,{requestId:button.dataset.request});closeDialog();return;}
    if(action==='cancel'){const o=state.orders.find(o=>o.id===button.dataset.id);openDialog(`<h2>${o.source==='paper'?'番号登録の取消':'取消・返金'}</h2><p>${o.source==='paper'?'会計係へ取消を伝えてください。':'返金はスタッフが行い、記録した売上から除外します。'}</p><label class="field"><span>理由</span><textarea id="cancel-reason" maxlength="200"></textarea></label><div class="dialog-actions"><button data-action="close">戻る</button><button class="danger" data-action="cancel-confirm" data-id="${o.id}" data-expected="${o.status}">取消を記録</button></div>`);return;}
    if(action==='cancel-confirm'){const o=state.orders.find(o=>o.id===button.dataset.id),reason=document.querySelector('#cancel-reason').value;if(o.local){await offline.cancelLocal(o.localRequestId,reason);if(connected)await offline.sync().catch(()=>connection(false));}else await api(`/api/orders/${button.dataset.id}/status`,{expected:button.dataset.expected,status:'cancelled',reason});closeDialog();if(connected)await refresh(false);else ledgerChanged();render();return;}
    if(action==='history'){const o=state.orders.find(o=>o.id===button.dataset.id),history=o.local?[{action:'registered',created_at:o.created_at,reason:o.syncError||'端末保存済み・親機へ未同期。紙の注文票でキッチンへ渡してください。'},...(o.status==='cancelled'?[{action:'cancelled',created_at:o.updated_at,reason:'返金記録を未同期'}]:[])]:await api(`/api/orders/${o.id}/history`);openDialog(`<h2>受付番号 ${o.label}</h2>${o.items.map(i=>`<p>${e(i.name)} ×${i.quantity}<small>${i.ice===null?'旧記録':options(i)}</small></p>`).join('')}${o.source==='cashier'?`<p>合計 ${yen(o.total)} ／ お釣り ${yen(o.change)}</p>`:''}${o.note?`<p>${e(o.note)}</p>`:''}${history.map(h=>`<div class="history-row"><time>${date(h.created_at)}</time><strong>${actions[h.action]||e(h.action)}</strong><span>${e(h.reason)}</span></div>`).join('')}<div class="dialog-actions">${o.session_id===state.currentSessionId&&['waiting','ready'].includes(o.status)?`<button class="danger" data-action="cancel" data-id="${o.id}" data-expected="${o.status}">取消・返金</button>`:''}<button data-action="close">閉じる</button></div>`);return;}
    if(action==='export'){downloadCsv();return;}
    if(action==='backup'){button.disabled=true;try{await backup();toast('バックアップを保存しました。');}finally{button.disabled=false;}return;}
    if(action==='new-session'){const name=document.querySelector('#session-name').value,startNumber=Number(document.querySelector('#start-number').value);if(!name.trim()||!Number.isInteger(startNumber)||startNumber<1||startNumber>9999){toast('営業回の名前と開始番号を確認してください。');return;}openDialog(`<h2>営業回を切り替えますか？</h2><p>${e(name)} ／ 開始番号 ${startNumber}</p><div class="dialog-actions"><button data-action="close">戻る</button><button class="primary" data-action="session-confirm" data-name="${e(name)}" data-number="${startNumber}" data-previous="${state.currentSessionId}">切り替える</button></div>`);return;}
    if(action==='session-confirm'){button.disabled=true;await api('/api/sessions',{name:button.dataset.name,startNumber:Number(button.dataset.number),previousId:button.dataset.previous});closeDialog();await refresh(false);renderSettings();toast('営業回を切り替えました。');}
  }catch(error){button.disabled=false;toast(error.message);}
});
async function navigateStaff(path,push=true){
  if(push)history.pushState({},'',path);route=path==='/'?'home':path.slice(1);
  if(!['sales','history'].includes(route))selectedSession='';
  if(connected){try{await refresh(false);}catch{connection(false);}}
  else if(serverState.session.id!==serverState.currentSessionId){const cached=await offline.cache();if(cached?.session.id===serverState.currentSessionId)serverState=cached;else serverState={...serverState,session:serverState.sessions.find(s=>s.id===serverState.currentSessionId),orders:[]};state=mergeStaffState(serverState);}
  shell();render();if(route==='cashier'&&connected)offline.prepare(serverState).catch(error=>toast(error.message));
}
document.addEventListener('click',event=>{
  if(isDisplay||mode!=='shared'||!state||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  const link=event.target.closest('a[href]');if(!link||link.target||link.hasAttribute('download'))return;
  const path=new URL(link.href,location.href).pathname;
  if(!['/','/cashier','/kitchen','/history','/sales','/menu','/staff-menu','/settings'].includes(path)||new URL(link.href).origin!==location.origin)return;
  event.preventDefault();navigateStaff(path).catch(error=>toast(error.message));
});
window.addEventListener('popstate',()=>{if(!isDisplay&&mode==='shared')navigateStaff(location.pathname,false).catch(error=>toast(error.message));});
window.addEventListener('beforeunload',event=>{if(!isDisplay&&(pending||mode==='shared'&&ledgerReady&&offline.info(state?.menuRevision,state?.currentSessionId).pending>0)){event.preventDefault();event.returnValue='';}});
window.addEventListener('offline',()=>{if(!isDisplay)connection(false);});
boot();




