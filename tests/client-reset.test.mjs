import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createClientReset} from '../public/client-reset.js';

test('明示した初期化だけで注文下書き・紙入力・未同期記録を一度消し、音量と以後の注文を保持する',async()=>{
  const values=new Map([['teatime-draft-v1','test'],['teatime-draft-v2','test'],['teatime-paper-v1','test'],['teatime-volume-v2','volume'],['teatime-voice-v2','voice']]);
  const storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  let ledger=['test order'];const clearLedger=async()=>{ledger=[];};
  const reset=createClientReset({storage,clearLedger}),token=randomUUID();
  for(const t of [undefined,null,'','different-server'])assert.equal(await reset(t),false);
  assert.equal(ledger.length,1);assert.equal(await reset(token),true);
  assert.equal(ledger.length,0);assert.equal(values.has('teatime-draft-v2'),false);assert.equal(values.has('teatime-paper-v1'),false);
  assert.equal(values.get('teatime-volume-v2'),'volume');assert.equal(values.get('teatime-voice-v2'),'voice');
  ledger.push('real order');storage.setItem('teatime-draft-v2','real draft');
  assert.equal(await reset(token),false);assert.equal(await createClientReset({storage,clearLedger})(token),false);
  assert.deepEqual(ledger,['real order']);assert.equal(values.get('teatime-draft-v2'),'real draft');
});

test('端末記録の消去失敗時は完了扱いにせず、下書きを維持して再試行できる',async()=>{
  const values=new Map([['teatime-draft-v2','test draft']]);
  const storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  let fails=true;const reset=createClientReset({storage,clearLedger:async()=>{if(fails)throw Error('保存領域エラー');}}),token=randomUUID();
  await assert.rejects(reset(token),/保存領域/);assert.equal(values.get('teatime-draft-v2'),'test draft');assert.equal(values.has('teatime-applied-test-reset'),false);
  fails=false;assert.equal(await reset(token),true);assert.equal(values.has('teatime-draft-v2'),false);
  const unavailable=createClientReset({storage:{getItem(){throw Error('端末保存が無効');}},clearLedger:async()=>{}});
  await assert.rejects(unavailable(token),error=>error.clientReset===true&&/端末保存/.test(error.message));
});
