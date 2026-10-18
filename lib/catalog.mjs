import providedMenu from '../config/menu.json' with {type:'json'};
import researchedNotes from '../config/menu-notes.json' with {type:'json'};
export const TEA_CATEGORIES = ['紅茶', '日本茶など'];
export const PRICE_TIERS = [300, 400, 500, 600];
export const OPTION_PRICE = 50;
export const MENU_NOTES_REVISION = researchedNotes.revision;
export function initialCatalog() {
  return providedMenu.items.filter(p=>p.kind==='tea').map(p=>{
    const notes=researchedNotes.items.find(n=>n.id===p.id&&n.name===p.name);
    return {id:p.id,name:p.name,price:p.price,category:p.category,active:true,recommendation:p.recommendedOption,description:notes?.description??'',allergens:notes?.allergens??''};
  });
}
export function templateCatalog() {
  return ['紅茶','ウーロン茶','緑茶'].flatMap((category,group)=>Array.from({length:10},(_,i)=>({
    id:`${['black','oolong','green'][group]}-${String(i+1).padStart(2,'0')}`,
    name:`${category} 茶葉${String(i+1).padStart(2,'0')}`,price:400,category,active:true
  })));
}
export function isUnmodifiedTemplate(products){
  const template=templateCatalog();
  return products.length===template.length&&template.every((p,i)=>products.some(e=>e.id===p.id&&e.name===p.name&&e.price===p.price&&e.category===p.category&&Boolean(e.active)&&e.position===i&&!e.description&&!e.allergens&&!e.recommendation));
}
