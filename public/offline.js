export function buildLocalSale(input,reservation){
  if(!Array.isArray(input.items)||!input.items.length||input.items.length>200)throw Error('茶葉を選んでください。');
  const seen=new Set(),items=input.items.map(i=>{
    if(!Number.isSafeInteger(i.quantity)||i.quantity<1||i.quantity>99||typeof i.ice!=='boolean'||typeof i.milk!=='boolean')throw Error('数量・オプションを確認してください。');
    const p=reservation.catalog.find(p=>p.id===i.productId&&p.active),key=`${i.productId}:${Number(i.ice)}:${Number(i.milk)}`;
    if(!p||seen.has(key))throw Error('販売中の茶葉と明細を確認してください。');seen.add(key);
    const ice_price=i.ice?reservation.optionPrice:0,milk_price=i.milk?reservation.optionPrice:0;
    return {product_id:p.id,line_key:key,name:p.name,price:p.price,quantity:i.quantity,ice:i.ice,milk:i.milk,ice_price,milk_price,unit_price:p.price+ice_price+milk_price};
  });
  const total=items.reduce((n,i)=>n+i.unit_price*i.quantity,0);
  if(total>1000000||!Number.isSafeInteger(input.tendered)||input.tendered<total||input.tendered>1000000)throw Error('お預かり金額を確認してください。');
  if(typeof input.note!=='string'||input.note.length>200)throw Error('備考は200文字以内です。');
  return {items,total,tendered:input.tendered,change:input.tendered-total,note:input.note};
}
export function openLedger(){
  let opened;const channel=globalThis.window&&globalThis.BroadcastChannel?new BroadcastChannel('teatime-ledger-v1'):null;
  function database(){return opened??=new Promise((resolve,reject)=>{
    if(!globalThis.indexedDB){reject(Error('端末に注文を保存できません。このブラウザではLAN会計を開始できません。'));return;}
    const request=indexedDB.open('teatime-offline-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('records');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('端末の注文保存を有効にしてください。'));
  });}
  async function get(key){const db=await database();return new Promise((resolve,reject)=>{const request=db.transaction('records').objectStore('records').get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  async function change(key,fn){
    const db=await database();return new Promise((resolve,reject)=>{
      const transaction=db.transaction('records','readwrite'),store=transaction.objectStore('records'),request=store.get(key);let value,error;
      request.onsuccess=()=>{try{value=fn(request.result);store.put(value,key);}catch(e){error=e;transaction.abort();}};
      transaction.oncomplete=()=>{if(key==='book')channel?.postMessage('changed');resolve(value);};transaction.onabort=transaction.onerror=()=>reject(error??transaction.error??Error('注文を保存できません。登録を止めています。'));
    });
  }
  async function clear(){const db=await database();return new Promise((resolve,reject)=>{const transaction=db.transaction('records','readwrite');transaction.objectStore('records').clear();transaction.oncomplete=()=>resolve();transaction.onabort=transaction.onerror=()=>reject(transaction.error??Error('テスト記録を削除できません。'));});}
  return {get,clear,update:fn=>change('book',fn),cache:value=>change('snapshot',()=>value),subscribe(callback){channel?.addEventListener('message',callback);}};
}
export function createOfflineRegister({api,id,storage=openLedger(),onChange=()=>{}}){
  let book,syncing=false,preparing=false,error='',subscribed=false,serverMismatch=false;
  const pending=()=>book?.entries.filter(e=>!e.synced)??[];
  const available=revision=>book?.reservations.filter(r=>r.status==='open'&&r.menuRevision===revision&&r.next<=r.end)??[];
  async function update(fn){book=await storage.update(fn);onChange();return book;}
  function validateServer(s){serverMismatch=Boolean(book.serverId&&book.serverId!==s.serverId);if(serverMismatch){error='親機の記録が変わっています。未同期注文を保存して確認してください。';throw Error(error);}}
  async function init(){
    if(!subscribed){storage.subscribe?.(async()=>{book=await storage.get('book');onChange();});subscribed=true;}
    book=await storage.get('book');if(!book)await update(()=>({terminalId:id(),serverId:'',reservations:[],entries:[],reserveRequest:null}));return storage.get('snapshot');
  }
  async function attach(s){validateServer(s);if(book.lastSessionId!==s.currentSessionId)await update(b=>({...b,serverId:s.serverId,lastSessionId:s.currentSessionId,closedSessionId:null}));if(s.session.id===s.currentSessionId)await storage.cache(s);}
  async function prepare(s,extra=false){
    if(preparing||(!extra&&book.closedSessionId===s.currentSessionId)||(!extra&&available(s.menuRevision).reduce((n,r)=>n+r.end-r.next+1,0)>=10))return;
    preparing=true;
    try{
      validateServer(s);
      await update(b=>{if(!extra&&b.closedSessionId===s.currentSessionId)throw Error('この端末の会計は利用終了しています。再開する場合は予備番号を追加してください。');return {...b,closedSessionId:extra?null:b.closedSessionId,reserveRequest:b.reserveRequest??{requestId:id(),terminalId:b.terminalId,serverId:s.serverId,sessionId:s.currentSessionId,menuRevision:s.menuRevision}};});
      const payload=book.reserveRequest,r=await api('/api/offline/reserve',payload);
      await update(b=>({...b,reservations:b.reservations.some(p=>p.id===r.id)?b.reservations:[...b.reservations,{...r,next:r.start}],reserveRequest:b.reserveRequest?.requestId===payload.requestId?null:b.reserveRequest}));error='';
    }catch(e){error=e.message;if(e.status>=400&&e.status<500)await update(b=>({...b,reserveRequest:null}));throw e;}
    finally{preparing=false;onChange();}
  }
  async function accept(input){
    if(serverMismatch)throw Error(error);
    let entry;
    await update(b=>{
      const old=b.entries.find(e=>e.payload.requestId===input.requestId);if(old){if(JSON.stringify(old.input)!==JSON.stringify(input))throw Error('同じ注文の内容を変更できません。保存済みの内容を確認してください。');entry=old;return b;}
      if(b.closedSessionId===input.sessionId)throw Error('この端末の会計は利用終了しています。予備番号を追加して再開してください。');
      const r=b.reservations.find(r=>r.status==='open'&&r.sessionId===input.sessionId&&r.menuRevision===input.menuRevision&&r.next<=r.end);
      if(!r)throw Error('切断中に使える番号がありません。接続を復旧して予備番号を準備してください。');
      const sale=buildLocalSale(input,r),number=r.next,acceptedAt=new Date().toISOString();
      const payload={...input,serverId:r.serverId,terminalId:r.terminalId,reservationId:r.id,number,acceptedAt,quotedTotal:sale.total};
      entry={input,payload,synced:false,error:'',receipt:{...sale,id:'local-'+input.requestId,number,label:String(number).padStart(3,'0'),session_id:input.sessionId,source:'cashier',fulfillment:1,status:'waiting',created_at:acceptedAt,updated_at:acceptedAt,local:true}};
      return {...b,reservations:b.reservations.map(p=>p.id===r.id?{...p,next:number+1}:p),entries:[...b.entries,entry]};
    });return entry.receipt;
  }
  async function cancelLocal(requestId,reason){
    if(!reason.trim()||reason.length>200)throw Error('返金理由を入力してください。');
    await update(b=>({...b,entries:b.entries.map(e=>e.payload.requestId===requestId?{...e,synced:false,cancelReason:reason,cancelId:e.cancelId??id(),error:'',receipt:{...e.receipt,status:'cancelled',updated_at:new Date().toISOString()}}:e)}));
  }
  async function sync(retry=false){
    if(syncing||!pending().some(entry=>retry||!entry.error))return;syncing=true;
    try{
      for(const entry of pending()){
        if(entry.error&&!retry)continue;
        try{
          let receipt=await api('/api/orders',entry.payload);
          // Re-read after the request so a refund entered during syncing is not lost.
          book=await storage.get('book');const current=book.entries.find(e=>e.payload.requestId===entry.payload.requestId);
          if(current.cancelReason)receipt=await api('/api/offline/cancel',{id:receipt.id,requestId:current.cancelId,terminalId:entry.payload.terminalId,serverId:entry.payload.serverId,reason:current.cancelReason});
          await update(b=>({...b,entries:b.entries.map(e=>e.payload.requestId===entry.payload.requestId?{...e,synced:e.cancelId===current.cancelId,error:'',receipt:e.cancelId===current.cancelId?{...receipt,local:false}:e.receipt}:e)}));
        }catch(e){
          if(e.network||!e.status||e.status>=500)throw e;
          await update(b=>({...b,entries:b.entries.map(p=>p.payload.requestId===entry.payload.requestId?{...p,error:e.message}:p)}));
        }
      }
    }finally{syncing=false;onChange();}
  }
  async function close(){
    if(preparing||syncing)throw Error('予備番号の準備・同期中です。完了後に終了してください。');
    if(pending().length)throw Error('未同期の会計があります。同期を完了してから予備番号の利用を終了してください。');
    await update(b=>{if(b.entries.some(e=>!e.synced)||b.reserveRequest)throw Error('ほかの画面で受付・予備番号の準備中です。同期完了後に終了してください。');return {...b,closedSessionId:b.lastSessionId,reservations:b.reservations.map(r=>['open','recovery'].includes(r.status)?{...r,status:'closing'}:r)};});
    for(const r of book.reservations.filter(r=>r.status==='closing')){
      await api('/api/offline/close',{id:r.id,terminalId:r.terminalId,serverId:r.serverId});
      await update(b=>({...b,reservations:b.reservations.map(p=>p.id===r.id?{...p,status:'closed'}:p)}));
    }
  }
  async function importBackup(source){
    if(!source||source.serverId!==book.serverId||!Array.isArray(source.entries)||source.entries.length>10000||!Array.isArray(source.reservations)||source.reservations.length>200)throw Error('この親機の端末記録ではありません。');
    const reservations=source.reservations.map(r=>{
      if(typeof r.id!=='string'||typeof r.terminalId!=='string'||r.serverId!==book.serverId||!Number.isSafeInteger(r.menuRevision)||!Number.isSafeInteger(r.optionPrice)||r.optionPrice<0||r.optionPrice>100000||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<1||r.end>9999||r.end<r.start||!Array.isArray(r.catalog)||r.catalog.length>50)throw Error('予備番号の記録が不正です。');
      return {...r,status:'recovery'};
    });
    const entries=source.entries.map(entry=>{
      const p=entry.payload,r=reservations.find(r=>r.id===p?.reservationId);
      if(!r||p.serverId!==book.serverId||p.terminalId!==r.terminalId||p.sessionId!==r.sessionId||typeof p.requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(p.requestId)||!Number.isSafeInteger(p.number)||p.number<r.start||p.number>r.end||!Number.isFinite(Date.parse(p.acceptedAt)))throw Error('会計記録を確認できません。');
      if(entry.cancelReason!==undefined&&(typeof entry.cancelReason!=='string'||entry.cancelReason.length>200||typeof entry.cancelId!=='string'))throw Error('返金記録が不正です。');
      const sale=buildLocalSale(p,r);if(sale.total!==p.quotedTotal)throw Error('会計金額が記録と一致しません。');
      return {input:entry.input,payload:p,cancelReason:entry.cancelReason,cancelId:entry.cancelId,synced:false,error:'',receipt:{...sale,id:'local-'+p.requestId,number:p.number,label:String(p.number).padStart(3,'0'),session_id:p.sessionId,source:'cashier',fulfillment:1,status:entry.cancelReason?'cancelled':'waiting',created_at:p.acceptedAt,updated_at:p.acceptedAt,local:true}};
    });
    await update(b=>{
      const merged=[...b.entries];
      for(const entry of entries){const index=merged.findIndex(e=>e.payload.requestId===entry.payload.requestId),old=merged[index];if(old){if(JSON.stringify(old.payload)!==JSON.stringify(entry.payload))throw Error('既存の注文と内容が異なります。');if(entry.cancelReason){if(old.cancelReason&&(old.cancelId!==entry.cancelId||old.cancelReason!==entry.cancelReason))throw Error('既存の返金記録と内容が異なります。');if(!old.cancelReason)merged[index]={...old,synced:false,error:'',cancelId:entry.cancelId,cancelReason:entry.cancelReason,receipt:{...old.receipt,local:true,status:'cancelled'}};}}else merged.push(entry);}
      return {...b,entries:merged,reservations:[...b.reservations,...reservations.filter(r=>!b.reservations.some(p=>p.id===r.id))]};
    });return entries.length;
  }
  function overlay(s){
    const orders=[...s.orders];
    for(const entry of book.entries){
      if(entry.receipt.session_id!==s.session.id)continue;
      const index=orders.findIndex(o=>o.number===entry.receipt.number);
      if(entry.synced&&index>=0)continue;
      const paper=index>=0?orders[index]:null;
      const receipt={...entry.receipt,status:entry.cancelReason?'cancelled':paper?.status??entry.receipt.status,local:!entry.synced,localRequestId:entry.payload.requestId,syncError:entry.error,request_id:entry.payload.requestId};
      if(index>=0)orders[index]=receipt;else orders.push(receipt);
    }
    orders.sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.number-a.number);return {...s,orders};
  }
  return {init,attach,prepare,accept,cancelLocal,sync,close,overlay,importBackup,
    info(revision,sessionId){const usable=serverMismatch?[]:available(revision).filter(r=>r.sessionId===sessionId);return {remaining:usable.reduce((n,r)=>n+r.end-r.next+1,0),pending:pending().length,errors:pending().filter(e=>e.error).length,syncing,preparing,error,ended:book?.closedSessionId===sessionId,closing:book?.reservations.some(r=>r.status==='closing')};},
    entries:()=>book?.entries??[],backup:()=>book,cache:()=>storage.get('snapshot')};
}
