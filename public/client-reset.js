// Only an explicit, persisted reset token authorizes clearing this origin's old test records.
export function createClientReset({storage,clearLedger}){
  const marker='teatime-applied-test-reset';let handled='';
  return async token=>{
    if(typeof token!=='string'||!/^[a-f0-9-]{36}$/.test(token)||handled===token)return false;
    try{
      if(storage.getItem(marker)===token){handled=token;return false;}
      await clearLedger();
      for(const key of ['teatime-draft-v1','teatime-draft-v2','teatime-paper-v1'])storage.removeItem(key);
      storage.setItem(marker,token);handled=token;return true;
    }catch(error){error.clientReset=true;throw error;}
  };
}
