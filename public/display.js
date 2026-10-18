import {createCallAudio,chooseJapaneseVoice,announcementText} from './audio.js';
const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function bootDisplay({app,api,id,toast}) {
  let state,voice,enabled=false,busy=false,page=0,highlight='',highlightTimer,consumer=id(),savedVoice='';
  let levels={voice:.85,chime:.85};
  try{savedVoice=localStorage.getItem('teatime-voice-v2')||'';const saved=JSON.parse(localStorage.getItem('teatime-volume-v2')||'null');if(saved)for(const k of ['voice','chime'])if(Number.isFinite(saved[k]))levels[k]=Math.max(0,Math.min(1,saved[k]));}catch{}
  const audio='speechSynthesis' in window?createCallAudio({getVoice:()=>voice,getLevels:()=>levels}):null;
  app.innerHTML=`<div class="display"><header class="display-header"><div class="display-brand">TeaTime <span>ティータイム同好会</span></div><span>受付番号をご確認ください。</span></header><main class="display-main"><section class="display-section preparing"><h1>ただいま準備中</h1><div id="waiting-grid"></div></section><section class="display-section ready"><div class="ready-heading"><h1>お受け取りいただけます</h1><p>控えの番号をご確認のうえ、受け取り口へお越しください。</p></div><div id="ready-grid"></div></section></main><footer class="display-footer"><span>お呼びした番号の控えをお持ちください。</span><div><span id="audio-indicator">音声停止中</span><button id="audio-toggle" aria-expanded="false" aria-controls="audio-panel">音量</button><span id="display-clock"></span></div></footer><aside id="audio-panel" class="audio-panel hidden" aria-label="呼び出し音声の調節"><div class="cart-title"><h2>呼び出し音声</h2><button id="audio-close" aria-label="音量パネルを閉じる">×</button></div><label class="field"><span>読み上げの声</span><select id="voice"></select></label><p id="voice-hint" class="hint"></p>${['chime','voice'].map(k=>`<label class="volume"><span>${k==='chime'?'チャイム':'読み上げ'} <output id="${k}-level">${Math.round(levels[k]*100)}%</output></span><input type="range" id="${k}-volume" min="0" max="100" value="${Math.round(levels[k]*100)}" aria-label="${k==='chime'?'チャイム':'読み上げ'}の音量"></label>`).join('')}<p class="note">BGMの音量は、BGMを再生するアプリ側で調節してください。</p><button id="audio-test" class="wide">チャイム＋声を試す</button><button id="audio-start" class="primary wide">音声呼び出しを開始</button><p id="audio-result" class="note" role="status">提供可能になった番号だけを呼び出します。</p></aside><div id="display-call" class="display-call hidden" role="status" aria-live="polite"></div></div>`;
  const el=id=>document.getElementById(id);
  function panel(open){el('audio-panel').classList.toggle('hidden',!open);el('audio-toggle').setAttribute('aria-expanded',String(open));}
  el('audio-toggle').onclick=()=>panel(el('audio-panel').classList.contains('hidden'));
  el('audio-close').onclick=()=>panel(false);
  panel(new URLSearchParams(location.search).has('setup'));
  function status(message){el('audio-result').textContent=message;el('audio-indicator').textContent=enabled?'音声呼出中':'音声停止中';el('audio-start').textContent=enabled?'音声呼び出しを停止':'音声呼び出しを開始';}
  function populate(){
    const voices=audio?speechSynthesis.getVoices().filter(v=>v.lang.toLowerCase().startsWith('ja')):[];
    voice=chooseJapaneseVoice(voices,savedVoice);
    el('voice').innerHTML=voices.length?voices.map((v,i)=>`<option value="${i}">${e(v.name)}</option>`).join(''):'<option>日本語音声がありません</option>';
    if(voice)el('voice').value=String(voices.indexOf(voice));
    el('voice-hint').textContent=voices.some(v=>/google/i.test(v.name))?'Googleの日本語音声を優先します。会場で再生を確認してください。':'このブラウザではGoogle音声を選べません。Google音声があるChrome、または表示されている声を使用してください。';
    el('voice').onchange=()=>{voice=voices[Number(el('voice').value)];savedVoice=voice.voiceURI;try{localStorage.setItem('teatime-voice-v2',savedVoice);}catch{}};
    el('audio-test').disabled=!voice||busy;el('audio-start').disabled=!voice||busy;
  }
  populate();if(audio)speechSynthesis.onvoiceschanged=populate;
  for(const k of ['voice','chime'])el(`${k}-volume`).oninput=()=>{levels[k]=Number(el(`${k}-volume`).value)/100;el(`${k}-level`).textContent=`${Math.round(levels[k]*100)}%`;try{localStorage.setItem('teatime-volume-v2',JSON.stringify(levels));}catch{}};
  el('audio-test').onclick=async()=>{
    if(busy||!audio)return;busy=true;populate();status('チャイム → 読み上げ中…');
    try{await audio.unlock();await audio.announce(announcementText(123));status('テスト完了。スピーカーからの音量を確認してください。');}catch(error){status(error.network?'音声を確認してください。必要な番号は口頭でお呼びください。':error.message);}finally{busy=false;populate();}
  };
  el('audio-start').onclick=async()=>{
    if(enabled){enabled=false;status('音声呼び出しを停止しました。');return;}
    try{
      await audio.unlock();
      await api('/api/audio/lease',{consumer});enabled=true;status('音声呼び出しを開始しました。');panel(false);
    }catch(error){status(error.message);}
  };
  function render(){
    if(!state)return;
    for(const s of ['waiting','ready']){
      const orders=state.orders.filter(o=>o.status===s),grid=el(`${s}-grid`),columns=s==='waiting'?(innerWidth<740?1:2):(innerWidth<740?2:3);
      const tileHeight=s==='waiting'?(innerWidth<740?56:72):(innerWidth<740?100:Math.max(112,Math.min(184,innerWidth*.115))+16);
      const rows=Math.max(1,Math.floor((innerHeight-grid.getBoundingClientRect().top-90)/tileHeight)),size=rows*columns,pages=Math.max(1,Math.ceil(orders.length/size));
      const index=orders.findIndex(o=>o.label===highlight),current=s==='ready'&&index>=0?Math.floor(index/size):page%pages;
      grid.innerHTML=orders.length?`<div class="number-grid">${orders.slice(current*size,(current+1)*size).map(o=>`<div class="number-tile ${o.label===highlight?'highlight':''}">${o.label}</div>`).join('')}</div>${pages>1?`<div class="page-count">${current+1} / ${pages} ページ · ${orders.length}組</div>`:''}`:`<div class="display-empty">${s==='ready'?'お茶ができあがりましたら<br>こちらに番号を表示します。':'お待ちの注文は<br>ありません。'}</div>`;
    }
    el('display-clock').textContent=new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'});
  }
  const tick=async()=>{try{state=await api('/api/public');render();}catch{}setTimeout(tick,1000);};tick();
  setInterval(()=>{page++;render();},10000);window.addEventListener('resize',render);
  setInterval(async()=>{if(enabled)try{await api('/api/audio/lease',{consumer});}catch(error){enabled=false;status(error.message);}},5000);
  const loop=async()=>{
    if(enabled&&!busy){
      try{
        const {call}=await api('/api/audio/claim',{consumer});
        if(call){
          busy=true;let spoken=false;
          try{
            state=await api('/api/public');
            const ready=()=>state.sessionId===call.session_id&&state.orders.some(o=>o.number===call.number&&o.status==='ready');
            if(ready()){
              highlight=call.label;render();const banner=el('display-call');banner.textContent=`${call.label}　お受け取りください`;banner.classList.remove('hidden');
              clearTimeout(highlightTimer);highlightTimer=setTimeout(()=>{highlight='';banner.classList.add('hidden');render();},8000);
              spoken=await audio.announce(announcementText(call.number),{beforeSpeech:async()=>{state=await api('/api/public');render();if(!ready()){highlight='';banner.classList.add('hidden');render();return false;}return true;}});
            }
          }catch(error){status(error.message);}
          finally{await api('/api/audio/finish',{id:call.id,consumer,success:spoken}).catch(()=>{});busy=false;}
        }
      }catch(error){if(error.status===409){enabled=false;status(error.message);}}
    }
    setTimeout(loop,1000);
  };loop();
}

