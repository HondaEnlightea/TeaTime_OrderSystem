import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { initialCatalog, OPTION_PRICE } from './catalog.mjs';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (condition, message, status) => { if (!condition) throw new AppError(message, status); };
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v, max, required = true) => typeof v === 'string' && v.length <= max && (!required || v.trim().length > 0);
const now = () => new Date().toISOString();
export const numberLabel = n => String(n).padStart(3, '0');

export function createStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, next_number INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=0), category TEXT NOT NULL, active INTEGER NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), number INTEGER NOT NULL,
      request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('waiting','ready','served','cancelled')),
      total INTEGER NOT NULL, tendered INTEGER NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(session_id,number));
    CREATE TABLE IF NOT EXISTS order_items (order_id TEXT NOT NULL REFERENCES orders(id), product_id TEXT NOT NULL,
      name TEXT NOT NULL, price INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), PRIMARY KEY(order_id, product_id));
    CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id),
      action TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id),
      status TEXT NOT NULL DEFAULT 'pending', consumer TEXT, created_at TEXT NOT NULL, finished_at TEXT);
    CREATE INDEX IF NOT EXISTS orders_session ON orders(session_id,status);
    CREATE INDEX IF NOT EXISTS calls_pending ON calls(status,id);
  `);
  const getSetting = key => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  const setting = (key, value) => db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  if (!db.prepare('PRAGMA table_info(orders)').all().some(c=>c.name==='source')) db.exec("ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'cashier'");
  if (!db.prepare('PRAGMA table_info(orders)').all().some(c=>c.name==='fulfillment')) db.exec('ALTER TABLE orders ADD COLUMN fulfillment INTEGER NOT NULL DEFAULT 1');
  if (!db.prepare('PRAGMA table_info(calls)').all().some(c=>c.name==='claimed_at')) db.exec('ALTER TABLE calls ADD COLUMN claimed_at TEXT');
  // Upgrade existing item snapshots without changing any order, amount or receipt number.
  if (!db.prepare('PRAGMA table_info(order_items)').all().some(c=>c.name==='line_key')) transaction(()=>{
    db.exec(`ALTER TABLE order_items RENAME TO order_items_v1;
      CREATE TABLE order_items (order_id TEXT NOT NULL REFERENCES orders(id), line_key TEXT NOT NULL, product_id TEXT NOT NULL,
        name TEXT NOT NULL, price INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0),
        ice INTEGER, milk INTEGER, ice_price INTEGER NOT NULL DEFAULT 0, milk_price INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(order_id,line_key));
      INSERT INTO order_items(order_id,line_key,product_id,name,price,quantity)
        SELECT order_id,product_id,product_id,name,price,quantity FROM order_items_v1;
      DROP TABLE order_items_v1;`);
  });
  const insertCatalog = products => products.forEach((p,i)=>db.prepare('INSERT INTO products VALUES (?,?,?,?,?,?)').run(p.id,p.name,p.price,p.category,Number(p.active),i));
  if (!getSetting('session')) transaction(() => {
    const id = randomUUID();
    db.prepare('INSERT INTO sessions(id,name,created_at) VALUES (?,?,?)').run(id, '営業 1', now());
    setting('session', id);
    setting('menuRevision', '1');
    insertCatalog(initialCatalog());
    setting('catalogTemplate','1');
  });
  const legacy = [['tea','紅茶',300,'ドリンク'],['milk-tea','ミルクティー',350,'ドリンク'],['coffee','コーヒー',300,'ドリンク'],['scone','スコーン',250,'フード'],['cake','ケーキ',400,'フード']];
  const existingProducts = db.prepare('SELECT * FROM products').all();
  if (existingProducts.length===5 && legacy.every(([id,name,price,category])=>existingProducts.some(p=>p.id===id&&p.name===name&&p.price===price&&p.category===category&&p.active===1))) transaction(()=>{
    db.exec('DELETE FROM products');insertCatalog(initialCatalog());setting('catalogTemplate','1');
    setting('menuRevision',String(Number(getSetting('menuRevision'))+1));
  });
  const currentSession = () => db.prepare('SELECT * FROM sessions WHERE id=?').get(getSetting('session'));
  const order = id => {
    const row = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    fail(row, '注文が見つかりません。', 404);
    return { ...row, label: numberLabel(row.number), change: row.tendered - row.total,
      items: db.prepare('SELECT line_key,product_id,name,price,quantity,ice,milk,ice_price,milk_price FROM order_items WHERE order_id=? ORDER BY rowid').all(id)
        .map(i=>({...i,ice:i.ice===null?null:Boolean(i.ice),milk:i.milk===null?null:Boolean(i.milk),unit_price:i.price+i.ice_price+i.milk_price})) };
  };
  const audit = (id, action, reason = '') => db.prepare('INSERT INTO history(order_id,action,reason,created_at) VALUES (?,?,?,?)').run(id, action, reason, now());
  const menu = () => db.prepare('SELECT * FROM products ORDER BY position,id').all().map(p => ({...p, active: Boolean(p.active)}));
  const state = (sessionId = getSetting('session')) => transaction(() => {
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    fail(session, '営業回が見つかりません。', 404);
    const orders = db.prepare('SELECT id FROM orders WHERE session_id=? ORDER BY number DESC').all(sessionId).map(r => order(r.id));
    const active = orders.filter(o => o.status !== 'cancelled');
    const valid = active.filter(o=>o.source==='cashier');
    const byProduct = new Map();
    valid.forEach(o => o.items.forEach(i => {
      const key = `${i.product_id}:${i.name}:${i.price}:${i.ice}:${i.milk}`;
      const p = byProduct.get(key) ?? {name:i.name, price:i.unit_price, ice:i.ice, milk:i.milk, quantity:0, total:0};
      p.quantity += i.quantity; p.total += i.unit_price*i.quantity; byProduct.set(key,p);
    }));
    return { session, currentSessionId: getSetting('session'), sessions: db.prepare('SELECT * FROM sessions ORDER BY created_at DESC,rowid DESC').all(),
      menu: menu(), menuRevision: Number(getSetting('menuRevision')), catalogTemplate:getSetting('catalogTemplate')==='1', optionPrice:OPTION_PRICE, orders,
      totals: { revenue: valid.reduce((n,o)=>n+o.total,0), orders:valid.length, paper:active.filter(o=>o.source==='paper').length, cancelled:orders.filter(o=>o.status==='cancelled').length,
        waiting: active.filter(o=>o.fulfillment&&o.status==='waiting').length, ready:active.filter(o=>o.fulfillment&&o.status==='ready').length, served:active.filter(o=>o.fulfillment&&o.status==='served').length,
        products:[...byProduct.values()] },
      audio: { consumer: getSetting('audioConsumer') || null, expires: Number(getSetting('audioExpires') || 0),
        pending: db.prepare("SELECT COUNT(*) AS n FROM calls c JOIN orders o ON c.order_id=o.id WHERE o.session_id=? AND o.status='ready' AND c.status='pending'").get(sessionId).n,
        failed: db.prepare("SELECT c.id,o.number,c.status FROM calls c JOIN orders o ON c.order_id=o.id WHERE o.session_id=? AND o.status='ready' AND (c.status='failed' OR (c.status='claimed' AND (c.claimed_at IS NULL OR c.claimed_at<? OR ?<=?))) ORDER BY c.id DESC LIMIT 20").all(sessionId,new Date(Date.now()-35000).toISOString(),Number(getSetting('audioExpires')||0),Date.now()) }, serverTime: now() };
  });
  return {
    db, getSetting, setting, currentSession, order, state, menu,
    publicState() {
      return transaction(() => ({ session: currentSession().name, sessionId:getSetting('session'),
        orders: db.prepare("SELECT number,status FROM orders WHERE session_id=? AND fulfillment=1 AND status IN ('waiting','ready') ORDER BY number").all(getSetting('session')).map(o => ({...o, label:numberLabel(o.number)})), serverTime: now() }));
    },
    createOrder(input,{fulfillment=true}={}) {
      fail(input && typeof input === 'object', '注文の形式が不正です。');
      fail(text(input.requestId, 80) && /^[a-zA-Z0-9-]{16,80}$/.test(input.requestId), '登録識別子が不正です。');
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      return transaction(() => {
        const existing = db.prepare('SELECT id,request_hash FROM orders WHERE request_id=?').get(input.requestId);
        if (existing) { fail(existing.request_hash === hash, '同じ登録識別子で内容を変更することはできません。', 409); return order(existing.id); }
        fail(input.sessionId === getSetting('session'), '営業回が変わりました。内容を確認して再登録してください。', 409);
        fail(input.menuRevision === Number(getSetting('menuRevision')), 'メニューが変更されました。金額を確認し直してください。', 409);
        fail(Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 200, '商品を1点以上選択してください。');
        fail(text(input.note ?? '', 200, false), '備考は200文字以内で入力してください。');
        const seen = new Set();
        const items = input.items.map(i => {
          fail(i && text(i.productId,80) && integer(i.quantity,1,99) && (i.ice===undefined||typeof i.ice==='boolean') && (i.milk===undefined||typeof i.milk==='boolean'), '商品・数量・オプションが不正です（1〜99杯）。');
          const ice=i.ice??false,milk=i.milk??false,lineKey=`${i.productId}:${Number(ice)}:${Number(milk)}`;
          fail(!seen.has(lineKey),'同じ茶葉とオプションの明細が重複しています。');seen.add(lineKey);
          const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(i.productId);
          fail(p, '販売停止中または存在しない商品です。', 409);
          return {line_key:lineKey,product_id:p.id,name:p.name,price:p.price,quantity:i.quantity,ice,milk,ice_price:ice?OPTION_PRICE:0,milk_price:milk?OPTION_PRICE:0};
        });
        const total = items.reduce((n,i)=>n+(i.price+i.ice_price+i.milk_price)*i.quantity,0);
        fail(total <= 1000000, '注文金額が上限を超えています。');
        fail(integer(input.tendered, total, 1000000), 'お預かり金額が不足しているか、不正です。');
        const session = currentSession();
        fail(session.next_number <= 9999, '受付番号が上限に達しました。営業回を切り替えてください。', 409);
        const id = randomUUID(), time = now();
        db.prepare('INSERT INTO orders(id,session_id,number,request_id,request_hash,status,total,tendered,note,created_at,updated_at,fulfillment) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, session.id, session.next_number, input.requestId, hash, 'waiting', total, input.tendered, input.note ?? '', time, time,Number(fulfillment));
        items.forEach(i=>db.prepare('INSERT INTO order_items VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,i.line_key,i.product_id,i.name,i.price,i.quantity,Number(i.ice),Number(i.milk),i.ice_price,i.milk_price));
        db.prepare('UPDATE sessions SET next_number=next_number+1 WHERE id=?').run(session.id);
        audit(id,'registered');
        return order(id);
      });
    },
    createPaperOrder(input) {
      fail(input && text(input.requestId,80) && /^[a-zA-Z0-9-]{16,80}$/.test(input.requestId),'登録識別子が不正です。');
      const hash=createHash('sha256').update('paper:'+JSON.stringify(input)).digest('hex');
      return transaction(()=>{
        const existing=db.prepare('SELECT id,request_hash FROM orders WHERE request_id=?').get(input.requestId);
        if(existing){fail(existing.request_hash===hash,'同じ登録識別子で内容を変更できません。',409);return order(existing.id);}
        fail(input.sessionId===getSetting('session'),'営業回が変わりました。注文票を確認してください。',409);
        fail(integer(input.number,1,9999),'受付番号は1〜9999で入力してください。');
        fail(text(input.note??'',200,false),'注文票の内容は200文字以内で入力してください。');
        fail(!db.prepare('SELECT id FROM orders WHERE session_id=? AND number=?').get(input.sessionId,input.number),'この受付番号は登録済みです。注文票と履歴を確認してください。',409);
        const id=randomUUID(),at=now();
        db.prepare("INSERT INTO orders(id,session_id,number,request_id,request_hash,status,total,tendered,note,created_at,updated_at,source) VALUES (?,?,?,?,?,'waiting',0,0,?,?,?,'paper')").run(id,input.sessionId,input.number,input.requestId,hash,input.note??'',at,at);
        db.prepare('UPDATE sessions SET next_number=MAX(next_number,?) WHERE id=?').run(input.number+1,input.sessionId);
        audit(id,'registered','独立運用・注文票から受付');return order(id);
      });
    },
    transition(id, expected, target, reason = '') {
      return transaction(() => {
        const o = order(id);
        fail(o.session_id === getSetting('session'), '過去の営業回は変更できません。', 409);
        fail(o.status === expected, '別のスタッフが状態を変更しました。最新の状態を確認してください。', 409);
        fail(o.fulfillment||target==='cancelled','独立会計の記録は、完成・提供の状態を管理しません。',409);
        fail((expected === 'waiting' && target === 'ready') || (expected === 'ready' && target === 'served') || (['waiting','ready'].includes(expected) && target === 'cancelled'), 'この状態変更はできません。', 409);
        if (target === 'cancelled') fail(text(reason,200), '取消理由を入力してください。');
        db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(target,now(),id);
        audit(id,target,reason);
        if (target === 'ready') db.prepare('INSERT INTO calls(order_id,created_at) VALUES (?,?)').run(id,now());
        else db.prepare("UPDATE calls SET status='skipped' WHERE order_id=? AND status='pending'").run(id);
        return order(id);
      });
    },
    recall(id, requestId) {
      fail(text(requestId,80) && /^[a-zA-Z0-9-]{16,80}$/.test(requestId), '再呼出の識別子が不正です。');
      return transaction(() => {
        const o = order(id);
        fail(o.session_id === getSetting('session') && o.status === 'ready', '提供可能な注文だけ再呼出できます。', 409);
        const key = `recall:${requestId}`;
        const old = getSetting(key);
        if (old) { fail(old === id, '再呼出の識別子が重複しています。',409); return o; }
        setting(key,id);
        db.prepare('INSERT INTO calls(order_id,created_at) VALUES (?,?)').run(id,now());
        audit(id,'recalled'); return o;
      });
    },
    history(id) { order(id); return db.prepare('SELECT * FROM history WHERE order_id=? ORDER BY id').all(id); },
    saveMenu(input) {
      fail(Array.isArray(input.products) && input.products.length > 0 && input.products.length <= 50, '商品は1〜50件で設定してください。');
      const ids = new Set();
      input.products.forEach(p => {
        fail(p && text(p.id,80) && /^[a-zA-Z0-9-]+$/.test(p.id) && !ids.has(p.id) && text(p.name,40) && text(p.category,20) && integer(p.price,0,100000) && typeof p.active === 'boolean', '商品設定が不正です。'); ids.add(p.id);
      });
      return transaction(() => {
        fail(input.revision === Number(getSetting('menuRevision')), '別のスタッフがメニューを更新しました。再読み込みしてください。',409);
        db.exec('DELETE FROM products');
        input.products.forEach((p,i) => db.prepare('INSERT INTO products VALUES (?,?,?,?,?,?)').run(p.id,p.name.trim(),p.price,p.category.trim(),Number(p.active),i));
        setting('catalogTemplate',input.products.some(p=>/茶葉\d{2}$/.test(p.name))?'1':'0');
        setting('menuRevision',String(input.revision+1)); return menu();
      });
    },
    newSession(input) {
      fail(text(input.name,40), '営業回の名前を1〜40文字で入力してください。');
      fail(input.startNumber===undefined||integer(input.startNumber,1,9999),'開始番号は1〜9999で入力してください。');
      return transaction(() => {
        fail(input.previousId === getSetting('session'), '営業回がすでに変わりました。',409);
        fail(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE session_id=? AND fulfillment=1 AND status IN ('waiting','ready')").get(getSetting('session')).n === 0, '未提供の注文があります。すべて提供または取消後に切り替えてください。',409);
        const id = randomUUID(); db.prepare('INSERT INTO sessions(id,name,created_at,next_number) VALUES (?,?,?,?)').run(id,input.name.trim(),now(),input.startNumber??1); setting('session',id); return currentSession();
      });
    },
    acquireAudio(consumer) {
      fail(text(consumer,80) && /^[a-zA-Z0-9-]{16,80}$/.test(consumer), '表示端末の識別子が不正です。');
      return transaction(() => {
        const owner = getSetting('audioConsumer'), expires = Number(getSetting('audioExpires') || 0);
        fail(!owner || owner === consumer || expires < Date.now(), '別の画面が音声呼び出し中です。元の画面を閉じ、15秒後に開始してください。',409);
        setting('audioConsumer',consumer); setting('audioExpires',String(Date.now()+15000));
        return {consumer, expires:Date.now()+15000};
      });
    },
    claimCall(consumer) {
      return transaction(() => {
        fail(getSetting('audioConsumer') === consumer && Number(getSetting('audioExpires') || 0) > Date.now(), '音声の担当画面が変わりました。',409);
        setting('audioExpires',String(Date.now()+15000));
        const c = db.prepare("SELECT c.id,c.order_id,o.number,o.session_id FROM calls c JOIN orders o ON c.order_id=o.id WHERE c.status='pending' AND o.status='ready' AND o.session_id=? ORDER BY c.id LIMIT 1").get(getSetting('session'));
        if (!c) return null;
        db.prepare("UPDATE calls SET status='claimed',consumer=?,claimed_at=? WHERE id=?").run(consumer,now(),c.id);
        return {...c, label:numberLabel(c.number)};
      });
    },
    finishCall(id, consumer, success) {
      fail(integer(id,1,Number.MAX_SAFE_INTEGER) && typeof success === 'boolean', '呼び出し結果が不正です。');
      const result = db.prepare("UPDATE calls SET status=?,finished_at=? WHERE id=? AND consumer=? AND status='claimed'").run(success?'spoken':'failed',now(),id,consumer);
      fail(result.changes === 1, '呼び出し結果は登録済みか、担当画面が異なります。',409);
      return {ok:true};
    },
    backup(file) { mkdirSync(dirname(resolve(file)),{recursive:true}); db.prepare('VACUUM INTO ?').run(resolve(file)); return resolve(file); },
    close() { db.close(); }
  };
}
