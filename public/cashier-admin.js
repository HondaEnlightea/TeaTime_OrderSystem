export function createCashierAdmin({getState,api,refresh,toast,openDialog,id,e,yen,time,date,heading,downloadCsv}){
  let historyQuery='',historyFilter='all',historyPage=0,menuDraft=null,menuRevision,menuDirty=false,menuQuery='',menuCategory='all';
  let staffEditing=false,staffDraft=null,staffRevision,staffDirty=false,staffQuery='',staffCategory='all',saving=false;
  const cats=['紅茶','日本茶など'];
  const content=()=>document.querySelector('#content');
  const status=o=>o.local?'未同期'+(o.status==='cancelled'?'・返金':''):!o.fulfillment&&o.status!=='cancelled'?'会計登録済み':({waiting:'準備中',ready:'提供可能',served:'提供済み',cancelled:'取消・返金'}[o.status]);
  const optionText=i=>i.ice===null?'オプション未記録':[i.ice?'氷あり':'氷なし',i.milk?'ミルクあり':'ミルクなし'].join('・');
  const sessionSelect=()=>`<label class="field period-picker"><span>営業回</span><select id="sales-session">${getState().sessions.map(s=>`<option value="${s.id}" ${s.id===getState().session.id?'selected':''}>${e(s.name)}</option>`).join('')}</select></label>`;
  const categories=(menu,selected,controlId)=>`<select id="${controlId}" aria-label="茶種で絞り込み"><option value="all">すべての茶種</option>${[...new Set([...cats,...menu.map(p=>p.category)])].map(c=>`<option value="${e(c)}" ${selected===c?'selected':''}>${e(c)}</option>`).join('')}</select>`;
  function renderRecent(){
    const root=document.querySelector('#recent-orders');if(!root)return;
    root.innerHTML=getState().orders.slice(0,6).map(o=>`<button class="recent-order ${o.status==='cancelled'?'cancelled':''}" data-action="history" data-id="${o.id}"><strong class="number">${o.label}</strong><span>${e(o.items.map(i=>`${i.name} ×${i.quantity}`).join(' / '))}<small>${time(o.created_at)} · ${status(o)}</small></span><strong>${yen(o.total)}</strong></button>`).join('')||'<p class="empty">登録した注文がここに表示されます。</p>';
  }
  function renderHistory(){
    const s=getState(),q=historyQuery.trim().toLowerCase();
    const orders=s.orders.filter(o=>(historyFilter==='all'||(historyFilter==='cancelled'?o.status==='cancelled':o.status!=='cancelled'))&&`${o.label} ${o.number} ${o.note} ${o.items.map(i=>i.name+' '+optionText(i)).join(' ')}`.toLowerCase().includes(q));
    const pages=Math.max(1,Math.ceil(orders.length/20));historyPage=Math.min(historyPage,pages-1);
    content().innerHTML=heading('注文履歴')+`<div class="history-tools">${sessionSelect()}<label class="field"><span>検索</span><input id="history-search" type="search" value="${e(historyQuery)}" placeholder="受付番号・茶葉・備考" aria-label="注文履歴を検索"></label><label class="field"><span>表示</span><select id="history-status"><option value="all">すべて</option><option value="valid" ${historyFilter==='valid'?'selected':''}>取消以外</option><option value="cancelled" ${historyFilter==='cancelled'?'selected':''}>取消・返金</option></select></label></div><div class="ledger-heading"><span>${orders.length}件</span><div><button class="small" data-action="history-page" data-delta="-1" ${historyPage===0?'disabled':''}>前へ</button><span>${historyPage+1} / ${pages}</span><button class="small" data-action="history-page" data-delta="1" ${historyPage>=pages-1?'disabled':''}>次へ</button></div></div><div class="ledger-grid">${orders.slice(historyPage*20,(historyPage+1)*20).map(o=>`<article class="ledger-card ${o.status==='cancelled'?'cancelled':''}"><div class="ledger-title"><strong class="number">${o.label}</strong><span class="badge ${o.status}">${status(o)}</span></div><time>${date(o.created_at)}</time><ul>${o.items.map(i=>`<li><div>${e(i.name)}<small>${optionText(i)} · ${yen(i.unit_price)} / 杯</small></div><strong>×${i.quantity}</strong></li>`).join('')||`<li>${e(o.note||'紙の注文票を参照')}</li>`}</ul>${o.note&&o.items.length?`<p class="ledger-note">${e(o.note)}</p>`:''}<div class="ledger-bottom"><span>${o.source==='paper'?'番号管理':`${o.items.reduce((n,i)=>n+i.quantity,0)}杯 · ${yen(o.total)}`}</span><button class="small" data-action="history" data-id="${o.id}">詳細・返金</button></div></article>`).join('')||'<p class="empty">該当する注文はありません。</p>'}</div>`;
  }
  function renderSales(){
    const s=getState(),t=s.totals,max=Math.max(1,...t.byMenu.map(p=>p.cups));
    content().innerHTML=heading('売り上げ')+`${s.orders.some(o=>o.local)?'<p class="alert">この端末の未同期注文を含みます。ほかの端末の記録は最後に確認した時点の情報です。CSVにも未同期の明細を含みます。</p>':''}<div class="sales-tools">${sessionSelect()}<button data-action="export">注文明細CSV</button><button data-action="backup">バックアップ</button></div><div class="metrics sales-summary">${[['売り上げ',yen(t.revenue)],['販売杯数',`${t.cups} 杯`],['会計件数',`${t.orders} 件`],['取消・返金',`${t.cancelled} 件`]].map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div><p class="hint">取消・返金した注文は販売杯数と売り上げから除外しています。登録当時の価格・追加料金で集計します。</p><div class="sales-panels"><section class="panel"><div class="cart-title"><h2>茶葉別の販売杯数・売り上げ</h2><button class="small" data-action="summary-export" data-kind="menu-sales">茶葉別CSV</button></div>${t.byMenu.map(p=>`<div class="sales-bar-row"><div><strong>${e(p.name)}</strong><span>${p.cups}杯 · ${yen(p.revenue)}</span></div><meter min="0" max="${max}" value="${p.cups}" aria-label="${e(p.name)}の販売杯数">${p.cups}杯</meter></div>`).join('')||'<p class="empty">販売の記録はありません。</p>'}</section><section class="panel"><div class="cart-title"><h2>注文の杯数別</h2><button class="small" data-action="summary-export" data-kind="cup-sales">杯数別CSV</button></div><p class="note">1注文に含まれる杯数でまとめています。</p><table><thead><tr><th>杯数 / 注文</th><th>件数</th><th>売り上げ</th></tr></thead><tbody>${t.byCupCount.map(p=>`<tr><td>${p.cups}杯</td><td>${p.orders}件</td><td>${yen(p.revenue)}</td></tr>`).join('')||'<tr><td colspan="3">記録はありません。</td></tr>'}</tbody></table></section></div>`;
  }
  function row(p,n){return `<article class="catalog-edit-row" data-menu-id="${e(p.id)}"><span class="catalog-number">${String(n+1).padStart(2,'0')}</span><label class="field"><span>茶葉名</span><input data-menu-name aria-label="${e(p.id)}の茶葉名" value="${e(p.name)}" required maxlength="40" placeholder="茶葉名を入力"></label><label class="field"><span>茶種</span><select data-menu-category aria-label="${e(p.id)}の茶種">${[...new Set([...cats,p.category])].map(c=>`<option ${c===p.category?'selected':''}>${e(c)}</option>`).join('')}</select></label><label class="field"><span>価格</span><select data-menu-price aria-label="${e(p.id)}の価格">${[...new Set([300,400,500,600,p.price])].sort((a,b)=>a-b).map(price=>`<option value="${price}" ${p.price===price?'selected':''}>${yen(price)}</option>`).join('')}</select></label><label class="field"><span>販売状況</span><select data-menu-active aria-label="${e(p.id)}の販売状況"><option value="1" ${p.active?'selected':''}>販売中</option><option value="0" ${!p.active?'selected':''}>売り切れ</option></select></label><label class="field catalog-allergens"><span>アレルギー情報（500文字以内）</span><textarea data-menu-allergens maxlength="500" aria-label="${e(p.id)}のアレルギー情報" placeholder="原材料・追加オプションなどの確認情報">${e(p.allergens)}</textarea></label></article>`;}
  function renderMenu(){
    if(!menuDraft){menuDraft=getState().menu.map(p=>({...p}));menuRevision=getState().menuRevision;menuDirty=false;}
    content().innerHTML=heading('メニュー変更')+`<form id="catalog-form"><div class="catalog-toolbar"><div><h2>茶葉・価格・売り切れ</h2><p class="note">保存すると会計画面に反映されます。氷・ミルクは各1杯につき¥50です。</p></div><div><button type="button" data-action="provided-menu">提供メニューを読み込む</button><button type="button" data-action="add-menu" ${menuDraft.length>=50?'disabled':''}>新規メニューを追加</button><button class="primary" type="submit">変更を保存</button></div></div><div class="catalog-filters"><input type="search" id="menu-search" aria-label="編集する茶葉を検索" value="${e(menuQuery)}" placeholder="茶葉名・アレルギーで検索">${categories(menuDraft,menuCategory,'menu-category')}</div><p class="hint">現在${menuDraft.length}件。提供されたメニューを反映できます。説明は「メニュー説明」で記入できます。アレルギー情報の未入力は「未確認」と表示します。</p><div id="catalog-rows">${menuDraft.map(row).join('')}</div><div class="editor-footer"><span id="menu-draft-status">${menuDirty?'未保存の変更があります':'保存済みの内容です'}</span><div><button type="button" data-action="reset-menu">最新の内容を読み込む</button><button class="primary" type="submit">変更を保存</button></div></div></form>`;filterRows('menu');
  }
  function renderStaff(){
    if(staffEditing&&!staffDraft){staffDraft=getState().menu.map(p=>({...p}));staffRevision=getState().menuRevision;staffDirty=false;}
    const menu=staffEditing?staffDraft:getState().menu;
    content().innerHTML=heading('メニュー説明')+`<form id="staff-notes-form"><div class="catalog-toolbar"><div><h2>茶葉の説明</h2><p class="note">味・香り、おすすめの飲み方、案内時の補足などを記入できます。</p></div>${staffEditing?'<button class="primary" type="submit">説明を保存</button>':'<button type="button" data-action="edit-descriptions">説明を編集</button>'}</div><div class="catalog-filters"><input type="search" id="staff-search" value="${e(staffQuery)}" aria-label="メニュー説明を検索" placeholder="茶葉名・説明・おすすめなどで検索">${categories(menu,staffCategory,'staff-category')}</div><div class="staff-menu-grid">${menu.map(p=>`<article class="staff-menu-card" data-staff-id="${e(p.id)}"><div class="cart-title"><span class="badge ${p.active?'':'sold-out'}">${p.active?'販売中':'売り切れ'}</span><strong>${yen(p.price)}</strong></div><span class="eyebrow">${e(p.category)}</span><h2>${e(p.name)}</h2><section class="recommendation-info"><strong>おすすめオプション</strong>${staffEditing?`<input data-recommendation maxlength="100" aria-label="${e(p.name)}のおすすめオプション" value="${e(p.recommendation??'')}" placeholder="未設定">`:`<p>${e(p.recommendation?.trim()||'未設定')}</p>`}</section><section class="allergy-info ${p.allergens?.trim()?'':'unconfirmed'}" aria-label="${e(p.name)}のアレルギー情報"><strong>アレルギー情報</strong><p>${e(p.allergens?.trim()||'未確認')}</p></section>${staffEditing?`<label class="field"><span>説明（2000文字以内）</span><textarea data-description maxlength="2000" aria-label="${e(p.name)}の説明" placeholder="例：香り・味わい・おすすめの飲み方">${e(p.description)}</textarea></label>`:`<p class="staff-description">${e(p.description||'説明はまだ記入されていません。')}</p>`}</article>`).join('')}</div>${staffEditing?`<div class="editor-footer"><span id="staff-draft-status">${staffDirty?'未保存の変更があります':'説明を編集中です'}</span><div><button type="button" data-action="cancel-descriptions">編集を終了</button><button class="primary" type="submit">説明を保存</button></div></div>`:''}</form>`;filterRows('staff');
  }
  function filterRows(which){
    const menu=which==='menu'?menuDraft:(staffEditing?staffDraft:getState().menu),query=(which==='menu'?menuQuery:staffQuery).trim().toLowerCase(),cat=which==='menu'?menuCategory:staffCategory;
    document.querySelectorAll(which==='menu'?'[data-menu-id]':'[data-staff-id]').forEach(el=>{const p=menu.find(p=>p.id===(el.dataset.menuId??el.dataset.staffId));el.hidden=!(cat==='all'||p.category===cat)||!`${p.name} ${p.allergens??''} ${which==='staff'?(p.description+' '+(p.recommendation??'')):''}`.toLowerCase().includes(query);});
  }
  function updateDraft(target){
    const row=target.closest('[data-menu-id]');if(!row||!menuDraft)return;
    const p=menuDraft.find(p=>p.id===row.dataset.menuId);
    if(target.hasAttribute('data-menu-name'))p.name=target.value;
    if(target.hasAttribute('data-menu-price'))p.price=Number(target.value);
    if(target.hasAttribute('data-menu-category'))p.category=target.value;
    if(target.hasAttribute('data-menu-active'))p.active=target.value==='1';
    if(target.hasAttribute('data-menu-allergens'))p.allergens=target.value;
    menuDirty=true;document.querySelector('#menu-draft-status').textContent='未保存の変更があります';
  }
  function onInput(target){
    if(target.id==='history-search'){historyQuery=target.value;historyPage=0;const position=target.selectionStart;renderHistory();const input=document.querySelector('#history-search');input.focus();input.setSelectionRange(position,position);}
    if(target.id==='menu-search'){menuQuery=target.value;filterRows('menu');}
    if(target.id==='staff-search'){staffQuery=target.value;filterRows('staff');}
    if(target.hasAttribute('data-menu-name')||target.hasAttribute('data-menu-allergens'))updateDraft(target);
    if(target.hasAttribute('data-recommendation')){const p=staffDraft.find(p=>p.id===target.closest('[data-staff-id]').dataset.staffId);p.recommendation=target.value;staffDirty=true;document.querySelector('#staff-draft-status').textContent='未保存の変更があります';}
    if(target.hasAttribute('data-description')){const p=staffDraft.find(p=>p.id===target.closest('[data-staff-id]').dataset.staffId);p.description=target.value;staffDirty=true;document.querySelector('#staff-draft-status').textContent='未保存の変更があります';}
  }
  function onChange(target){
    if(target.id==='history-status'){historyFilter=target.value;historyPage=0;renderHistory();}
    if(target.id==='menu-category'){menuCategory=target.value;filterRows('menu');}
    if(target.id==='staff-category'){staffCategory=target.value;filterRows('staff');}
    if(['data-menu-category','data-menu-price','data-menu-active'].some(a=>target.hasAttribute(a)))updateDraft(target);
  }
  async function onSubmit(form){
    if(!['catalog-form','staff-notes-form'].includes(form.id))return false;
    if(form.id==='staff-notes-form'&&!staffEditing)return true;
    if(saving)return true;saving=true;form.querySelectorAll('input,select,textarea,button').forEach(b=>b.disabled=true);
    try{
      const isMenu=form.id==='catalog-form',revision=isMenu?menuRevision:staffRevision,products=isMenu?menuDraft:staffDraft;
      const saved=await api('/api/menu',{revision,products});const s=getState();s.menu=saved;s.menuRevision=revision+1;
      if(isMenu){menuDraft=null;menuDirty=false;}else{staffDraft=null;staffDirty=false;staffEditing=false;}
      let online=true;await refresh(false).catch(()=>online=false);
      if(isMenu)renderMenu();else renderStaff();toast(online?'保存しました。':'保存しました。接続の復旧後に最新情報を確認してください。');
    }catch(error){toast(error.message);form.querySelectorAll('input,select,textarea,button').forEach(b=>b.disabled=false);const add=form.querySelector('[data-action="add-menu"]');if(add)add.disabled=menuDraft.length>=50;}
    finally{saving=false;}return true;
  }
  async function onClick(button){
    const action=button.dataset.action;
    if(action==='provided-menu'&&menuDirty){openDialog('<h2>未保存の変更を破棄して提供メニューを読み込みますか？</h2><p>まだデータベースには保存しません。</p><div class="dialog-actions"><button data-action="close">戻る</button><button data-action="provided-menu-confirm">読み込む</button></div>');return true;}
    if(action==='provided-menu'||action==='provided-menu-confirm'){
      if(action==='provided-menu-confirm')document.querySelector('#modal').close();
      const products=await api('/api/menu/default');await refresh(false);
      const existing=getState().menu;menuDraft=products.map(p=>{const same=existing.filter(old=>old.name===p.name),old=same.length===1?same[0]:null;return {...p,description:old?.description?.trim()?old.description:p.description,allergens:old?.allergens?.trim()?old.allergens:p.allergens,active:old?.active??true};});
      menuRevision=getState().menuRevision;menuDirty=true;menuQuery='';menuCategory='all';renderMenu();toast(products.length+'品を読み込みました。内容を確認して変更を保存してください。');return true;
    }
    if(action==='summary-export'){downloadCsv(button.dataset.kind);return true;}
    if(action==='history-page'){historyPage=Math.max(0,historyPage+Number(button.dataset.delta));renderHistory();return true;}
    if(action==='add-menu'){if(menuDraft.length>=50)return true;menuDraft.push({id:id(),name:'',price:300,category:'紅茶',active:true,description:'',allergens:'',recommendation:''});menuDirty=true;menuQuery='';menuCategory='all';renderMenu();document.querySelector('[data-menu-id]:last-child [data-menu-name]').focus();return true;}
    if(action==='reset-menu'){
      if(menuDirty){openDialog('<h2>未保存の変更を破棄しますか？</h2><div class="dialog-actions"><button data-action="close">戻る</button><button data-action="reset-menu-confirm">最新の内容を読み込む</button></div>');return true;}
      await refresh(false);menuDraft=null;renderMenu();return true;
    }
    if(action==='reset-menu-confirm'){document.querySelector('#modal').close();await refresh(false);menuDraft=null;menuDirty=false;renderMenu();return true;}
    if(action==='edit-descriptions'){staffEditing=true;renderStaff();return true;}
    if(action==='cancel-descriptions'){
      if(staffDirty){openDialog('<h2>未保存の説明を破棄しますか？</h2><div class="dialog-actions"><button data-action="close">戻る</button><button data-action="cancel-descriptions-confirm">編集を終了</button></div>');return true;}
      staffEditing=false;staffDraft=null;renderStaff();return true;
    }
    if(action==='cancel-descriptions-confirm'){document.querySelector('#modal').close();staffEditing=false;staffDraft=null;staffDirty=false;renderStaff();return true;}
    return false;
  }
  window.addEventListener('beforeunload',event=>{if(menuDirty||staffDirty){event.preventDefault();event.returnValue='';}});
  return {hasUnsaved:()=>menuDirty||staffDirty,renderRecent,renderHistory,renderSales,renderMenu,renderStaff,onInput,onChange,onSubmit,onClick,
    update(){if(location.pathname==='/history')renderHistory();else if(location.pathname==='/sales')renderSales();else if(location.pathname==='/staff-menu'&&!staffEditing)renderStaff();},resetHistoryPage(){historyPage=0;}};
}
