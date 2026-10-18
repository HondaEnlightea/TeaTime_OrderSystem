import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
for(const config of [
  {name:'指定なしの起動は独立会計を選べる。共有モードには入らない',args:[],choice:'1',mode:'cashier'},
  {name:'ローカル起動で独立キッチンを選ぶと紙番号の手入力を受け付ける',args:['--local'],choice:'2',mode:'kitchen'},
  {name:'cmdやnpmを介さずNode.js直接指定で独立会計を起動できる',args:['--cashier'],mode:'cashier'},
  {name:'cmdやnpmを介さずNode.js直接指定で独立キッチンを起動できる',args:['--kitchen'],mode:'kitchen'},
  {name:'LANを明示した起動だけが会計・キッチンの共有モードになる',args:['--lan'],mode:'shared'}
])test(config.name,{timeout:20000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'teatime-cli-'));
  const child=spawn(process.execPath,[join(root,'server.mjs'),...config.args],{
    cwd:root,env:{...process.env,PORT:'0',TEATIME_DB:join(directory,'db.sqlite')},stdio:['pipe','pipe','pipe']
  });
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill();await closed;}
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'teatime-cli-'));rmSync(directory,{recursive:true,force:true});
  });
  let output='',errors='',answered=false;
  child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>errors+=chunk);
  child.stdout.setEncoding('utf8');
  const base=await new Promise((res,rej)=>{
    child.once('error',rej);
    child.once('exit',()=>rej(new Error(`起動前に停止しました: ${errors}`)));
    child.stdout.on('data',chunk=>{
      output+=chunk;
      if(config.choice&&!answered&&output.includes('Enter')){answered=true;child.stdin.write(config.choice+'\n');}
      const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)res(match[0]);
    });
  });
  assert.ok(config.choice?answered:!output.includes('用途を選んで'));
  const state=await(await fetch(base+'/api/state')).json();assert.equal(state.mode,config.mode);
  assert.ok(output.includes(base+'/'+(config.mode==='cashier'?'cashier':'kitchen')));
  if(config.mode==='kitchen'){
    assert.ok(output.includes('キッチン・お渡し: '+base+'/kitchen'));
    assert.ok(output.includes('お客様向け番号表示: '+base+'/display'));
    assert.ok(output.includes('音声・音量の準備: '+base+'/display?setup=1'));
  }
  if(config.mode==='shared'){
    assert.ok(output.includes('【別の端末で開くリンク（接続先候補）】'));
    for(const [label,path] of [['注文・会計','cashier'],['キッチン・お渡し','kitchen'],['お客様向け番号表示・音声準備','display?setup=1']])assert.ok(output.includes(label+': '+base+'/'+path));
  }else assert.ok(!output.includes('【別の端末で開くリンク（接続先候補）】'));
  if(config.mode==='kitchen'){
    const result=await fetch(base+'/api/paper-orders',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({requestId:'paper-cli-request-0001',sessionId:state.currentSessionId,number:71})});
    assert.equal(result.status,201);assert.equal((await result.json()).label,'071');
  }
});
