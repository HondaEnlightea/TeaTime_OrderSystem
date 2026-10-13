import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallAudio,chooseJapaneseVoice,announcementText } from '../public/audio.js';

function fixture() {
  const events=[],oscillators=[],peaks=[],utterances=[];
  const levels={voice:.6,chime:.9};
  const context={state:'suspended',currentTime:0,destination:{},async resume(){this.state='running';events.push('unlock');},
    createOscillator(){const o={frequency:{setValueAtTime(){}},connect(){},start(){},stop(){},disconnect(){}};oscillators.push(o);return o;},
    createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(value){peaks.push(value);},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}};
  const selectedVoice={name:'日本語音声B'};
  const synthesis={resume(){},cancel(){},speak(u){utterances.push(u);events.push(`speak:${u.text}`);assert.equal(u.voice,selectedVoice);queueMicrotask(()=>u.onend());}};
  const audio=createCallAudio({getVoice:()=>selectedVoice,getLevels:()=>levels,contextFactory:()=>context,synthesis,utteranceFactory:text=>({text}),pause:async ms=>{assert.equal(ms,350);events.push('pause');}});
  return {events,oscillators,audio,peaks,utterances,levels};
}
test('音声の有効化時は無音。チャイムの完了と間の後に選択した声で読み上げる',async()=>{
  const {audio,events,oscillators}=fixture();await audio.unlock();assert.deepEqual(events,['unlock']);
  const announcement=audio.announce('123番');assert.equal(oscillators.length,2);assert.deepEqual(events,['unlock']);
  oscillators[0].onended();assert.deepEqual(events,['unlock']);
  oscillators[1].onended();await announcement;
  assert.deepEqual(events,['unlock','pause','speak:123番']);
});
test('チャイム中に提供済みになった番号は読み上げない',async()=>{
  const {audio,events,oscillators}=fixture();await audio.unlock();
  const announcement=audio.announce('123番',{beforeSpeech:async()=>false});oscillators[0].onended();oscillators[1].onended();
  assert.equal(await announcement,false);assert.deepEqual(events,['unlock','pause']);
});
test('音声の接続が切れた状態では突然読み上げを始めない',async()=>{
  const {audio,events}=fixture();await assert.rejects(()=>audio.announce('123番'),/チャイムの音声接続/);assert.deepEqual(events,[]);
});
test('Google日本語を優先し、手動選択と未搭載時の代替音声を尊重する',()=>{
  const local={name:'Microsoft Haruka',lang:'ja-JP',voiceURI:'local',localService:true},google={name:'Google 日本語',lang:'ja-JP',voiceURI:'google',localService:false},english={name:'Google US English',lang:'en-US',voiceURI:'en'};
  assert.equal(chooseJapaneseVoice([local,english,google]),google);
  assert.equal(chooseJapaneseVoice([local,google],'local'),local);
  assert.equal(chooseJapaneseVoice([local,english]),local);
  assert.equal(chooseJapaneseVoice([english]),undefined);
  assert.equal(announcementText(42),'受け付け番号42のお客様');
});
test('チャイムと声は別々の音量。チャイムを強めても声の設定を変えない',async()=>{
  const f=fixture();await f.audio.unlock();const run=f.audio.announce(announcementText(9));f.oscillators.forEach(o=>o.onended());await run;
  assert.deepEqual(f.peaks,[.405,.405]);assert.equal(f.utterances[0].volume,.6);
  f.levels.chime=0;f.levels.voice=.2;await f.audio.announce(announcementText(10));assert.equal(f.oscillators.length,2);assert.equal(f.utterances[1].volume,.2);
});
