import http from 'node:http';
import { readFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { createStore, AppError } from './lib/store.mjs';
import { summaryCsvRows,detailCsvRows,csvText } from './lib/reports.mjs';
import { startupMessages } from './lib/startup.mjs';
import {initialCatalog} from './lib/catalog.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/cashier',['index.html','text/html; charset=utf-8']],
  ['/kitchen',['index.html','text/html; charset=utf-8']], ['/sales',['index.html','text/html; charset=utf-8']],
  ['/settings',['index.html','text/html; charset=utf-8']], ['/display',['index.html','text/html; charset=utf-8']],
  ['/history',['index.html','text/html; charset=utf-8']], ['/menu',['index.html','text/html; charset=utf-8']], ['/staff-menu',['index.html','text/html; charset=utf-8']],
  ['/app.js',['app.js','text/javascript; charset=utf-8']], ['/style.css',['style.css','text/css; charset=utf-8']],
  ['/audio.js',['audio.js','text/javascript; charset=utf-8']],
  ['/display.js',['display.js','text/javascript; charset=utf-8']],
  ['/cashier-admin.js',['cashier-admin.js','text/javascript; charset=utf-8']],
  ['/cart.js',['cart.js','text/javascript; charset=utf-8']],
  ['/offline.js',['offline.js','text/javascript; charset=utf-8']], ['/reports.js',['../lib/reports.mjs','text/javascript; charset=utf-8']],
  ['/client-reset.js',['client-reset.js','text/javascript; charset=utf-8']],
  ['/favicon.svg',['favicon.svg','image/svg+xml']]
]);
function assert(condition, message, status=400) { if (!condition) throw new AppError(message,status); }

export function createApplication(options = {}) {
  const mode=options.mode??'cashier';
  assert(['shared','cashier','kitchen'].includes(mode),'運用モードが不正です。');
  const database = options.database ?? resolve(root,mode==='shared'?'data/teatime.sqlite':`data/${mode}.sqlite`);
  const store = createStore(database,{catalog:options.catalog});
  const resetManifest=resolve(root,'data/test-reset.json');
  if(database!==':memory:'&&dirname(resolve(database))===resolve(root,'data')&&existsSync(resetManifest)){
    const reset=JSON.parse(readFileSync(resetManifest,'utf8'));
    assert(typeof reset.token==='string'&&/^[a-f0-9-]{36}$/.test(reset.token),'テスト初期化の記録が不正です。');
    store.setting('clientResetToken',reset.token);
  }
  store.setting('audioExpires','0'); // The display explicitly restarts its audio lease after a server restart.
  const allowedHosts = new Set(['localhost','127.0.0.1','[::1]',...Object.values(networkInterfaces()).flat().filter(Boolean).map(a=>a.address),...(options.allowedHosts ?? [])]);
  const backupDir = options.backupDir ?? resolve(root,`backups/${mode}`);
  const backup = () => {
    mkdirSync(backupDir,{recursive:true});
    const filename = join(backupDir, `teatime-${new Date().toISOString().replaceAll(':','-')}-${randomUUID()}.sqlite`);
    store.backup(filename);
    // Keep 288 snapshots (one day at a five-minute interval), plus externally copied files.
    const files = readdirSync(backupDir).filter(f=>/^teatime-.*\.sqlite$/.test(f)).sort();
    for (const old of files.slice(0,-288)) unlinkSync(join(backupDir,old));
    return filename;
  };
  function headers(res,type) {
    res.setHeader('Content-Type',type);
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options',options.preview?'SAMEORIGIN':'DENY');
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${options.preview?"'self'":"'none'"}; form-action 'self'`);
  }
  function json(res,status,body) { headers(res,'application/json; charset=utf-8'); res.writeHead(status); res.end(JSON.stringify(body)); }
  async function body(req,limit=65536) {
    assert((req.headers['content-type'] ?? '').split(';')[0] === 'application/json','JSON形式で送信してください。',415);
    let size=0, chunks=[];
    for await (const chunk of req) { size+=chunk.length; assert(size<=limit,'送信内容が大きすぎます。',413); chunks.push(chunk); }
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert(input && typeof input==='object' && !Array.isArray(input),'送信内容が不正です。');
      return input;
    } catch (e) { if (e instanceof AppError) throw e; throw new AppError('JSON形式が不正です。'); }
  }
  const server = http.createServer({requestTimeout:10000, headersTimeout:10000, maxHeaderSize:16384}, async (req,res) => {
    try {
      let url;
      try { url = new URL(req.url,`http://${req.headers.host}`); } catch { throw new AppError('接続先が不正です。',400); }
      assert(allowedHosts.has(url.hostname),'許可されていない接続先です。親機のIPアドレスを使ってください。',403);
      const path=url.pathname;
      // Independent stations expose only their own workflow; the customer screen belongs to the kitchen.
      const stationRoute=mode==='cashier'?'/cashier':'/kitchen';
      if(req.method==='GET'&&mode!=='shared'&&(path==='/'||(mode==='kitchen'&&['/cashier','/menu','/staff-menu'].includes(path))||(mode==='cashier'&&['/kitchen','/display'].includes(path)))){
        headers(res,'text/plain; charset=utf-8');res.writeHead(302,{Location:stationRoute});res.end();return;
      }
      if (options.preview && req.method==='GET' && ['/responsive-check','/responsive-check.css'].includes(path)) {
        const css=path.endsWith('.css');headers(res,css?'text/css; charset=utf-8':'text/html; charset=utf-8');
        res.end(readFileSync(join(root,'tests/browser',css?'responsive.css':'responsive.html')));return;
      }
      if (req.method === 'GET' && ASSETS.has(path)) {
        const [file,type] = ASSETS.get(path); headers(res,type); res.end(readFileSync(join(root,'public',file))); return;
      }
      if (req.method === 'GET' && path === '/api/health') { json(res,200,{ok:true}); return; }
      if(req.method==='GET'&&path==='/api/menu/default'){assert(mode!=='kitchen','メニューの編集は会計端末で行ってください。',409);json(res,200,initialCatalog());return;}
      if(req.method==='GET'&&path==='/portal'){
        headers(res,'text/html; charset=utf-8');
        const destinations=mode==='shared'?[['/cashier','注文・会計へ'],['/kitchen','キッチン・お渡しへ'],['/display?setup=1','番号表示・音声準備へ']]:mode==='cashier'?[['/cashier','注文・会計へ']]:[['/kitchen','キッチン・お渡しへ'],['/display?setup=1','番号表示・音声準備へ']];
        res.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TeaTime 端末用入口</title><link rel="stylesheet" href="/style.css"></head><body><main class="connection-page"><section class="connection-card"><h1>端末用入口</h1><p>この端末で使う画面を選んでください。</p><p class="connection-success">接続できました</p><p class="hint">${mode==='shared'?'親機の注文・提供状況を共有します。音声は番号表示用PCで開始してください。':'独立ローカルで起動中です。別端末との連携にはLAN起動を使ってください。'}</p><nav class="connection-actions" aria-label="使う画面を選択">${destinations.map(([path,label],i)=>`<a class="button ${i===0?'primary ':''}wide" href="${path}">${label}</a>`).join('')}</nav><p class="note">接続確認 ${new Date().toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}<br>入口を開くだけでは注文や売り上げは変更されません。</p><a class="button wide" href="/portal">接続を再確認</a></section></main></body></html>`);return;
      }
      if (req.method === 'GET' && path === '/api/public') { json(res,200,store.publicState()); return; }
      if (req.method === 'POST') {
        assert(req.headers.origin === url.origin,'同じ画面から操作してください。',403);
        const input = await body(req,path==='/api/menu'?400*1024:65536);
        if(path.startsWith('/api/offline/')){assert(mode==='shared','予備番号はLAN連携で利用します。',409);if(path==='/api/offline/reserve'){json(res,201,store.reserveNumbers(input));return;}if(path==='/api/offline/close'){json(res,200,store.closeReservation(input));return;}if(path==='/api/offline/cancel'){json(res,200,store.cancelReserved(input));return;}}
        if (path === '/api/orders') { assert(!input.reservationId||mode==='shared','予備番号はLAN連携で利用します。',409);assert(mode!=='kitchen','独立キッチンでは会計登録できません。',409);json(res,201,store.createOrder(input,{fulfillment:mode!=='cashier'})); return; }
        if (path === '/api/paper-orders') { assert(mode!=='cashier','注文票の手入力はキッチンで使用してください。',409);json(res,201,store.createPaperOrder(input));return; }
        const statusMatch = path.match(/^\/api\/orders\/([a-zA-Z0-9-]+)\/(status|recall)$/);
        if (statusMatch) {
          const result = statusMatch[2]==='status' ? store.transition(statusMatch[1],input.expected,input.status,input.reason) : store.recall(statusMatch[1],input.requestId);
          json(res,200,result); return;
        }
        if (path === '/api/menu') { json(res,200,store.saveMenu(input)); return; }
        if (path === '/api/sessions') { backup(); json(res,201,store.newSession(input)); return; }
        if (path === '/api/audio/lease') { json(res,200,store.acquireAudio(input.consumer)); return; }
        if (path === '/api/audio/claim') { json(res,200,{call:store.claimCall(input.consumer)}); return; }
        if (path === '/api/audio/finish') { json(res,200,store.finishCall(input.id,input.consumer,input.success)); return; }
        if (path === '/api/backup') {
          const filename = backup(); headers(res,'application/octet-stream');
          res.setHeader('Content-Disposition',`attachment; filename="${filename.split(/[\\/]/).pop()}"`); res.end(readFileSync(filename)); return;
        }
      } else if (req.method === 'GET') {
        if (path === '/api/state') { json(res,200,{...store.state(url.searchParams.get('session') || undefined),mode}); return; }
        const historyMatch = path.match(/^\/api\/orders\/([a-zA-Z0-9-]+)\/history$/);
        if (historyMatch) { json(res,200,store.history(historyMatch[1])); return; }
        if (path === '/api/export') {
          const state=store.state(url.searchParams.get('session') || undefined);
          const kind=url.searchParams.get('kind');
          if(kind){
            assert(['menu-sales','cup-sales'].includes(kind),'集計の種類が不正です。');
            const rows=summaryCsvRows(state,kind);headers(res,'text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="teatime-${kind}.csv"`);
            res.end(csvText(rows));return;
          }
          const rows=detailCsvRows(state);
          headers(res,'text/csv; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename="teatime-sales.csv"');
          res.end(csvText(rows)); return;
        }
      }
      throw new AppError('ページが見つかりません。',404);
    } catch (e) {
      if (!(e instanceof AppError)) console.error('Request failed:',e.message);
      if (!res.headersSent) json(res,e.status ?? 500,{error:e instanceof AppError?e.message:'保存できませんでした。親機の状態を確認してから再試行してください。'});
      else res.end();
    }
  });
  server.on('clientError',(_error,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  server.setTimeout(15000);
  let backupTimer;
  if (options.automaticBackups !== false) {
    backupTimer = setInterval(()=>{try { backup(); } catch(e) { console.error('自動バックアップ失敗:',e.message); }},300000); backupTimer.unref();
  }
  return {server,store,backup,close:async()=>{
    clearInterval(backupTimer);
    await new Promise((r,e)=>server.close(err=>err?e(err):r())); store.close();
  }};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [major,minor]=process.versions.node.split('.').map(Number);
  if (major!==24||minor<14) { console.error('Node.js 24（24.14以降）を使ってください。'); process.exit(1); }
  const preview=process.argv.includes('--preview');
  if(preview&&process.argv.includes('--lan')){console.error('プレビューは親機内のみで使用してください。');process.exit(1);}
  let mode=process.argv.includes('--lan')?'shared':process.argv.includes('--kitchen')?'kitchen':process.argv.includes('--cashier')?'cashier':undefined;
  if(process.argv.includes('--kitchen')&&process.argv.includes('--cashier')){console.error('会計かキッチンのどちらかを指定してください。');process.exit(1);}
  if(process.argv.includes('--lan')&&['--cashier','--kitchen','--local'].some(flag=>process.argv.includes(flag))){console.error('独立運用はネットワーク公開しません。連携運用では--lanのみ指定してください。');process.exit(1);}
  if(!mode&&preview)mode='cashier';
  if(!mode){
    const prompt=createInterface({input:process.stdin,output:process.stdout});
    const inputClosed=new AbortController();
    prompt.once('close',()=>inputClosed.abort());
    console.log('TeaTime 独立ローカル運用：このPCの用途を選んでください。');
    console.log('1：会計専用（注文・会計・番号発行）');
    console.log('2：キッチン専用（紙の番号を手入力・完成・番号表示）');
    console.log('会計PCとキッチンPCは別の記録を保存し、自動共有しません。');
    try{
      while(!mode){
        const answer=(await prompt.question('1 または 2 を入力して Enter：',{signal:inputClosed.signal})).trim();
        if(answer==='1')mode='cashier';else if(answer==='2')mode='kitchen';else console.log('1（会計）か2（キッチン）を選んでください。');
      }
    }catch{console.error('用途を選択できません。node server.mjs --cashier または node server.mjs --kitchen で起動してください。');process.exitCode=1;}
    finally{prompt.close();}
    if(!mode)process.exit(1);
  }
  const host=process.argv.includes('--lan')?'0.0.0.0':'127.0.0.1';
  const port=Number(process.env.PORT || 3000);
  const app=createApplication({database:process.env.TEATIME_DB || (preview?resolve(root,`data/preview-${mode}.sqlite`):mode==='shared'?undefined:resolve(root,`data/${mode}.sqlite`)), preview, mode,
    backupDir:resolve(root,`backups/${mode}`),
    allowedHosts:(process.env.TEATIME_ALLOWED_HOSTS || '').split(',').filter(Boolean)});
  app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'ポートが使用中です。別の起動ウィンドウを確認してください。':e.message); process.exit(1);});
  app.server.listen(port,host,()=>{
    const listeningPort=app.server.address().port;
    for(const line of startupMessages({mode,port:listeningPort,interfaces:networkInterfaces()}))console.log(line);
    if(preview)console.log('練習用プレビュー。実機相当の390px確認: /responsive-check。本番はnpm start。');
    console.log('停止: Ctrl+C');
  });
  let stopping=false;
  const stop=async()=>{
    if (stopping) return; stopping=true;
    try { app.backup(); await app.close(); } catch(e) { console.error(e.message); process.exitCode=1; }
  };
  process.on('SIGINT',stop); process.on('SIGTERM',stop);
}
