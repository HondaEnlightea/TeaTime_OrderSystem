export const announcementText=number=>`受け付け番号${number}のお客様`;
export function chooseJapaneseVoice(voices,saved='') {
  const japanese=voices.filter(v=>v.lang.toLowerCase().startsWith('ja'));
  return japanese.find(v=>v.voiceURI===saved)||japanese.find(v=>/google/i.test(v.name))||japanese.find(v=>v.localService)||japanese[0];
}
// Soft attack, audible chime, then a pause before the short announcement.
export function createCallAudio({getVoice=()=>undefined, getLevels=()=>({voice:.85,chime:.85}), contextFactory=()=>new (window.AudioContext||window.webkitAudioContext)(),
  synthesis=window.speechSynthesis, utteranceFactory=text=>new SpeechSynthesisUtterance(text), pause=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  let context;
  async function unlock() {
    context??=contextFactory();
    if(context.state!=='running')await context.resume();
    if(context.state!=='running')throw new Error('チャイムを再生できません。画面の音声準備をやり直してください。');
    synthesis.resume();
  }
  function speak(text) {
    return new Promise((resolve,reject)=>{
      const utterance=utteranceFactory(text);utterance.lang='ja-JP';utterance.rate=.92;utterance.volume=Math.max(0,Math.min(1,getLevels().voice));
      const voice=getVoice();if(voice)utterance.voice=voice;
      const timer=setTimeout(()=>{synthesis.cancel();reject(new Error('読み上げが完了しませんでした。'));},25000);
      utterance.onend=()=>{clearTimeout(timer);resolve();};
      utterance.onerror=()=>{clearTimeout(timer);reject(new Error('音声を再生できませんでした。'));};
      synthesis.speak(utterance);
    });
  }
  async function chime() {
    if(!context||context.state!=='running')throw new Error('チャイムの音声接続が切れました。');
    const level=Math.max(0,Math.min(1,getLevels().chime));
    if(level===0){await pause(350);return;}
    const start=context.currentTime+.03;
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('チャイムを再生できませんでした。')),5000);
      [523.25,659.25].forEach((frequency,index)=>{
        const oscillator=context.createOscillator(),gain=context.createGain(),at=start+index*.24;
        oscillator.type='sine';oscillator.frequency.setValueAtTime(frequency,at);
        gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(.45*level,at+.035);gain.gain.exponentialRampToValueAtTime(.001,at+.25);
        oscillator.connect(gain);gain.connect(context.destination);oscillator.start(at);oscillator.stop(at+.27);
        oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();if(index===1){clearTimeout(timer);resolve();}};
      });
    });
    await pause(350);
  }
  return {unlock, cancel:()=>synthesis.cancel(),
    async announce(text,{beforeSpeech=async()=>true}={}) {
      await chime();
      if(await beforeSpeech()) { await speak(text);return true; }
      return false;
    }
  };
}
