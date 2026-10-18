// Editing keeps each cup separate; only the registration payload groups variants.
const variant=item=>JSON.stringify([item.productId,item.ice??false,item.milk??false]);
export function groupCups(rows){
  const grouped=new Map();
  for(const item of rows){
    const ice=item.ice??false,milk=item.milk??false;
    if(typeof item.productId!=='string'||!item.productId||!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>99||typeof ice!=='boolean'||typeof milk!=='boolean')throw Error('注文の茶葉・杯数・オプションを確認してください。');
    const key=variant(item),line=grouped.get(key)??{productId:item.productId,quantity:0,ice,milk};
    if(line.quantity+item.quantity>99)throw Error('同じ茶葉・オプションは99杯までです。');
    line.quantity+=item.quantity;grouped.set(key,line);
  }
  return [...grouped.values()];
}
export function separateCups(items){
  groupCups(items);
  return items.flatMap(item=>Array.from({length:item.quantity},()=>({productId:item.productId,quantity:1,ice:item.ice??false,milk:item.milk??false})));
}
export function appendCup(rows,productId){
  const next=[...rows,{productId,quantity:1,ice:false,milk:false}];groupCups(next);return next;
}
export function toggleCup(rows,index,option){
  if(!Number.isInteger(index)||!rows[index]||!['ice','milk'].includes(option))throw Error('変更する1杯を確認してください。');
  const next=rows.map((item,n)=>n===index?{...item,[option]:!item[option]}:item);groupCups(next);return next;
}
