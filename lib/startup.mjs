// Every interface is a candidate; its presence does not prove client reachability.
export function startupMessages({mode,port,interfaces={}}){
  const local=`http://127.0.0.1:${port}`;
  const kitchen=mode!=='cashier';
  const lines=[mode==='shared'?'TeaTime 連携':`TeaTime ${mode==='kitchen'?'独立キッチン':'独立会計'}: ${local}/${kitchen?'kitchen':'cashier'}`,
    'PIN・ログインは不要です。', '', '【このPCで開くリンク】'];
  if(mode==='cashier'){
    lines.push(`注文・会計: ${local}/cashier`,'このPCは会計専用です。発行した番号を注文票に記入して、キッチンへ渡してください。');
  }else if(mode==='kitchen'){
    lines.push(`キッチン・お渡し: ${local}/kitchen`, `お客様向け番号表示: ${local}/display`, `音声・音量の準備: ${local}/display?setup=1`);
    lines.push('このPCは独立キッチンです。注文票の受付番号を手入力してください。');
  }else{
    lines.push(`注文・会計: ${local}/cashier`, `キッチン・お渡し: ${local}/kitchen`, `お客様向け番号表示・音声準備: ${local}/display?setup=1`);
    lines.push('このPCが親機です。データを保存し、各端末の注文・提供状況を共有します。');
  }
  if(mode==='shared'){
    lines.push('', '【別の端末で開くリンク（接続先候補）】');
    const seen=new Set();
    for(const [name,addresses] of Object.entries(interfaces))for(const a of addresses??[]){
      if(a.family!=='IPv4'||a.internal||seen.has(a.address))continue;
      seen.add(a.address);
      const remote=`http://${a.address}:${port}`;
      lines.push(`接続名: ${name}（${a.address}）`, `  端末用入口: ${remote}/portal`, `  注文・会計: ${remote}/cashier`, `  キッチン・お渡し: ${remote}/kitchen`, `  お客様向け番号表示・音声準備: ${remote}/display?setup=1`);
    }
    if(!seen.size)lines.push('接続先候補がありません。Wi-Fi・テザリング・有線LANの接続状態を確認してください。');
    else{
      if(seen.size>1)lines.push('複数の候補は、このPCに複数のネットワーク接続があるためです。');
      lines.push('接続する端末と同じテザリング／Wi-Fi／有線LANの候補を使ってください。', '端末用入口で「接続できました」を確認し、会計・キッチン・番号表示のボタンから進めます。');
    }
    lines.push('127.0.0.1はこのPC専用です。別の端末ではサーバーを起動せず、担当する画面を開いてください。');
  }
  return lines;
}
