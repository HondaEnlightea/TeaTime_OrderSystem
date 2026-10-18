// Reports use recorded item prices and option fees, never today's catalog prices.
export function salesSummary(orders) {
  const menus=new Map(),baskets=new Map();let cups=0;
  for(const o of orders.filter(o=>o.source==='cashier'&&o.status!=='cancelled')){
    const count=o.items.reduce((n,i)=>n+i.quantity,0);cups+=count;
    const basket=baskets.get(count)??{cups:count,orders:0,revenue:0};basket.orders++;basket.revenue+=o.total;baskets.set(count,basket);
    for(const i of o.items){
      const key=JSON.stringify([i.product_id,i.name]);
      const row=menus.get(key)??{id:i.product_id,name:i.name,cups:0,baseRevenue:0,iceCups:0,iceRevenue:0,milkCups:0,milkRevenue:0,revenue:0};
      row.cups+=i.quantity;row.baseRevenue+=i.price*i.quantity;
      row.iceCups+=i.ice?i.quantity:0;row.milkCups+=i.milk?i.quantity:0;
      row.iceRevenue+=i.ice_price*i.quantity;row.milkRevenue+=i.milk_price*i.quantity;
      row.revenue+=(i.price+i.ice_price+i.milk_price)*i.quantity;menus.set(key,row);
    }
  }
  return {cups,byMenu:[...menus.values()].sort((a,b)=>b.cups-a.cups||a.name.localeCompare(b.name,'ja')),byCupCount:[...baskets.values()].sort((a,b)=>a.cups-b.cups)};
}
export function summaryCsvRows(state,kind){
  if(kind==='menu-sales')return [['営業回','茶葉ID','茶葉名','販売杯数','基本料金売上','氷杯数','氷売上','ミルク杯数','ミルク売上','売り上げ合計'],...state.totals.byMenu.map(p=>[state.session.name,p.id,p.name,p.cups,p.baseRevenue,p.iceCups,p.iceRevenue,p.milkCups,p.milkRevenue,p.revenue])];
  if(kind==='cup-sales')return [['営業回','1注文の杯数','注文件数','販売杯数','売り上げ合計'],...state.totals.byCupCount.map(p=>[state.session.name,p.cups,p.orders,p.cups*p.orders,p.revenue])];
  throw new Error('Unknown report kind');
}

export function csvCell(value){let s=String(value??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
export function detailCsvRows(state){
 const labels={waiting:'待ち',ready:'提供可能',served:'提供済み',cancelled:'取消・返金'};
 return [['営業回','受付番号','状態','受付時刻','更新時刻','茶葉','基本価格','氷','ミルク','氷料金','ミルク料金','単価合計','数量','商品小計','注文合計','お預かり','お釣り','備考','同期状況'],...state.orders.flatMap(o=>o.items.map(i=>[state.session.name,o.label,!o.fulfillment&&o.status!=='cancelled'?'会計登録済み':labels[o.status],o.created_at,o.updated_at,i.name,i.price,i.ice===null?'未記録':i.ice?'あり':'なし',i.milk===null?'未記録':i.milk?'あり':'なし',i.ice_price,i.milk_price,i.unit_price,i.quantity,i.unit_price*i.quantity,o.total,o.tendered,o.change,o.note,o.local?'未同期':'親機保存済み']))];
}
export const csvText=rows=>'\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
