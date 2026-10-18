import test from 'node:test';
import assert from 'node:assert/strict';
import {startupMessages} from '../lib/startup.mjs';
const interfaces={
  'Wi-Fi':[{family:'IPv4',internal:false,address:'10.250.52.27'},{family:'IPv6',internal:false,address:'fe80::1'}],
  'ローカル エリア接続* 10':[{family:'IPv4',internal:false,address:'192.168.137.1'}],
  Loopback:[{family:'IPv4',internal:true,address:'127.0.0.1'}],
  Duplicate:[{family:'IPv4',internal:false,address:'192.168.137.1'}]
};
test('学校Wi-Fiとテザリングが共存しても、親機の全画面と接続名付きの候補を案内する',()=>{
  const lines=startupMessages({mode:'shared',port:3018,interfaces}),text=lines.join('\n');
  assert.equal(lines[0],'TeaTime 連携');
  const localLines=lines.slice(lines.indexOf('【このPCで開くリンク】')+1,lines.indexOf('【別の端末で開くリンク（接続先候補）】'));
  assert.equal(localLines.filter(l=>l.includes('http://')).length,3);
  for(const path of ['cashier','kitchen','display?setup=1'])assert.ok(localLines.some(l=>l.endsWith('http://127.0.0.1:3018/'+path)));
  assert.match(text,/接続名: Wi-Fi（10\.250\.52\.27）/);
  assert.match(text,/接続名: ローカル エリア接続\* 10（192\.168\.137\.1）/);
  for(const address of ['10.250.52.27','192.168.137.1']){
    for(const path of ['cashier','kitchen','display?setup=1','portal'])assert.equal(lines.filter(l=>l.endsWith(`http://${address}:3018/${path}`)).length,1);
  }
  assert.doesNotMatch(text,/fe80|Loopback|Duplicate/);assert.match(text,/複数の候補/);assert.match(text,/このPC専用/);
});
test('独立起動は他端末への接続先を案内せず、LAN未接続でも親機用URLは出す',()=>{
  for(const mode of ['cashier','kitchen']){
    const text=startupMessages({mode,port:3000,interfaces}).join('\n');
    assert.doesNotMatch(text,/10\.250|192\.168|別の端末で開くリンク/);
    assert.ok(text.includes(`http://127.0.0.1:3000/${mode}`));
    if(mode==='cashier')assert.doesNotMatch(text,/\/display/);else assert.match(text,/手入力/);
  }
  const text=startupMessages({mode:'shared',port:3000}).join('\n');
  assert.match(text,/接続先候補がありません/);assert.match(text,/http:\/\/127\.0\.0\.1:3000\/kitchen/);
});
