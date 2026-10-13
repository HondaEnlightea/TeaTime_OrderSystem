export const TEA_CATEGORIES = ['紅茶', 'ウーロン茶', '緑茶'];
export const PRICE_TIERS = [400, 500, 600];
export const OPTION_PRICE = 50;
export function initialCatalog() {
  return TEA_CATEGORIES.flatMap((category,group)=>Array.from({length:10},(_,i)=>({
    id:`${['black','oolong','green'][group]}-${String(i+1).padStart(2,'0')}`,
    name:`${category} 茶葉${String(i+1).padStart(2,'0')}`,price:400,category,active:true
  })));
}
