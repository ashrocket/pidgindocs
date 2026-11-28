import { assignmentCatalogs } from "./i18n";

export const AUDIO_REPLY_CSS = `
.agent-reply{margin-top:1rem;border-top:1px solid var(--line,#dedad5);padding-top:.8rem}.agent-reply summary{cursor:pointer;font-weight:600;min-height:40px}.agent-reply label{display:block;margin:.7rem 0 .25rem}.agent-reply textarea,.agent-reply select{width:100%;font:inherit;border:1px solid var(--line,#aaa);border-radius:8px;padding:.6rem;background:var(--paper,white);color:inherit}.agent-reply textarea{min-height:6rem}.agent-reply button{font:inherit;min-height:44px;border:1px solid var(--line,#aaa);border-radius:8px;padding:.5rem .8rem;cursor:pointer;background:var(--paper,white);color:inherit}.agent-reply button:disabled{opacity:.5;cursor:default}.agent-reply-controls{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.8rem}.agent-reply-status{font-size:.9rem}.agent-reply-item{padding:.8rem 0;border-top:1px solid var(--line,#dedad5)}.agent-reply-item p{white-space:pre-wrap;overflow-wrap:anywhere}.agent-reply small{display:block;color:var(--muted,#625d59)}.agent-reply :focus-visible{outline:2px solid var(--accent,#746052);outline-offset:2px}.agent-reply audio{width:100%;margin-top:.6rem}
`;

/** Installs a reusable composer; all user content is assigned with textContent. */
export function audioReplyScript(base = ""): string {
  return `window.AudioReplyConfig=${JSON.stringify({base,catalogs:assignmentCatalogs}).replace(/</g,"\\u003c")};\n` + String.raw`
(function(){
  'use strict';
  var config=window.AudioReplyConfig;
  function t(key){var lang=(document.documentElement.lang||'en').split('-')[0];return (config.catalogs[lang]||config.catalogs.en)[key]||key;}
  function el(tag,text){var node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;}
  function button(text){var node=el('button',t(text));node.type='button';return node;}
  function api(path,init){return fetch(config.base+path,Object.assign({credentials:'same-origin',headers:{Accept:'application/json'}},init||{})).then(function(r){return r.json().then(function(b){if(!r.ok||!b.ok){var error=new Error('request');error.status=r.status;throw error;}return b.data;});});}
  window.AudioReplies={mount:function(container,id,player){
    var box=el('details');box.className='agent-reply';box.appendChild(el('summary',t('Reply to your agent')));
    var form=el('form'),text=el('textarea'),agents=el('select'),target=el('select'),uid='reply-'+crypto.randomUUID();
    function label(control,key,parent){control.id=uid+'-'+key.replace(/\s/g,'-');var l=el('label',t(key));l.htmlFor=control.id;(parent||form).append(l,control);return l;}
    text.maxLength=20000;label(text,'Your reply');
    agents.appendChild(new Option(t('Next available agent'),''));label(agents,'Agent');
    [['auto','Where available'],['local','On my Mac'],['cloud','In the cloud'],['interactive','In a connected chat']].forEach(function(x){target.appendChild(new Option(t(x[1]),x[0]));});label(target,'Run this work');
    var connections=el('select'),connectionInfo=el('small'),connectionSection=el('div'),connectionList=[];
    label(connections,'Project connection',connectionSection);connectionSection.appendChild(connectionInfo);form.appendChild(connectionSection);
    function selectConnections(selected){connections.replaceChildren(new Option(t('Choose a project connection'),''));connectionList.filter(function(c){return c.target===target.value;}).forEach(function(c){connections.appendChild(new Option(c.name,c.id));});connections.value=selected||'';connectionSection.hidden=!['cloud','local'].includes(target.value);showConnection();}
    function showConnection(){var c=connectionList.find(function(c){return c.id===connections.value;});connectionInfo.textContent=c?[c.execution_ref,c.context_notes||''].join(' · '):t('This connection belongs to your account. Select the environment or folder that has the right project context.');}
    target.onchange=function(){selectConnections();};connections.onchange=showConnection;selectConnections();
    var setup=el('details'),setupBody=el('div');setup.appendChild(el('summary',t('Connect a project')));setup.appendChild(setupBody);
    var setupName=el('input'),setupTarget=el('select'),setupRef=el('input'),setupContext=el('textarea'),saveConnection=button('Save connection');setupName.type='text';setupRef.type='text';
    setupName.maxLength=100;setupRef.maxLength=500;setupContext.maxLength=6000;
    setupTarget.append(new Option(t('In the cloud'),'cloud'),new Option(t('On my Mac'),'local'));
    setupBody.appendChild(el('small',t('This connection belongs to your account. Select the environment or folder that has the right project context.')));
    label(setupName,'Connection name',setupBody);label(setupTarget,'Run this work',setupBody);setupTarget.id+='-setup';setupTarget.previousElementSibling.htmlFor=setupTarget.id;
    var refLabel=label(setupRef,'Cloud environment ID',setupBody);setupTarget.onchange=function(){refLabel.textContent=t(setupTarget.value==='cloud'?'Cloud environment ID':'Local project folder');};
    label(setupContext,'Project context',setupBody);setupBody.appendChild(el('small',t('The environment supplies the repository. Your reply includes the overview transcript and playback position.')));
    var codexLink=el('a',t('Open Codex'));codexLink.href='https://chatgpt.com/codex';codexLink.target='_blank';codexLink.rel='noopener';setupBody.append(codexLink,saveConnection);form.appendChild(setup);
    saveConnection.onclick=async function(){saveConnection.disabled=true;try{var data=await api('/api/assignments/connections',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:setupName.value,target:setupTarget.value,execution_ref:setupRef.value,context_notes:setupContext.value})});connectionList=connectionList.filter(function(c){return c.id!==data.connection.id;});connectionList.push(data.connection);target.value=data.connection.target;selectConnections(data.connection.id);setup.open=false;say('Connection saved');}catch(error){say('Connection could not be saved. Check the fields and try again.');}finally{saveConnection.disabled=false;}};
    var controls=el('div');controls.className='agent-reply-controls';
    var record=button('Record a reply'),remove=button('Remove recording'),send=button('Send reply');send.type='submit';remove.hidden=true;
    controls.append(record,remove,send);form.appendChild(controls);
    var hint=el('small',t('Your reply stays saved until a capable agent picks it up.'));form.appendChild(hint);
    form.appendChild(el('small',t('A connected runner must be available to submit work. Otherwise your reply stays saved.')));
    var preview=el('audio');preview.controls=true;preview.hidden=true;form.appendChild(preview);
    var status=el('p');status.className='agent-reply-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    var history=el('div'),more=button('Show more replies');more.hidden=true;box.append(form,status,history,more);container.appendChild(box);
    var recorder=null,stream=null,blob=null,blobUrl=null,stopTimer=null,pending=null,sending=false,recording=false,position=0,cursor=null,poll=null;
    function say(key){status.textContent=t(key);}
    function lock(value){text.disabled=value;agents.disabled=value;target.disabled=value;connections.disabled=value;saveConnection.disabled=value;record.disabled=value;remove.disabled=value;}
    function clearRecording(){blob=null;preview.pause();preview.removeAttribute('src');preview.hidden=true;remove.hidden=true;if(blobUrl)URL.revokeObjectURL(blobUrl);blobUrl=null;}
    function stop(){clearTimeout(stopTimer);if(recorder&&recorder.state!=='inactive')recorder.stop();if(stream)stream.getTracks().forEach(function(track){track.stop();});stream=null;}
    remove.onclick=function(){clearRecording();};
    record.onclick=async function(){
      if(recording){stop();return;}
      record.disabled=true;
      try{
        if(!navigator.mediaDevices||!window.MediaRecorder)throw new Error('unavailable');
        stream=await navigator.mediaDevices.getUserMedia({audio:true});
        if(!box.isConnected||!box.open){stop();record.disabled=false;return;}
        clearRecording();position=player&&Number.isFinite(player.currentTime)?player.currentTime:0;if(player)player.pause();
        var mime=['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'].find(function(x){return MediaRecorder.isTypeSupported(x);});
        recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);var chunks=[],size=0,tooLarge=false;
        recorder.ondataavailable=function(event){if(event.data.size){size+=event.data.size;if(size>10485760){tooLarge=true;stop();}else chunks.push(event.data);}};
        recorder.onerror=function(){stop();say('Microphone unavailable. You can type your reply.');};
        recorder.onstop=function(){recording=false;send.disabled=false;record.disabled=false;record.textContent=t('Record a reply');
          if(tooLarge){say('Recording is too large. Record a shorter reply.');return;}
          blob=new Blob(chunks,{type:recorder.mimeType||'audio/webm'});if(!blob.size){blob=null;return;}
          blobUrl=URL.createObjectURL(blob);preview.src=blobUrl;preview.hidden=false;remove.hidden=false;say('Recording ready. You can add text before sending.');};
        recorder.start(1000);recording=true;send.disabled=true;record.disabled=false;record.textContent=t('Stop recording');say('Recording… Stop when you have finished.');stopTimer=setTimeout(stop,120000);
      }catch(error){stop();record.disabled=false;say('Microphone unavailable. You can type your reply.');}
    };
    function row(task){
      var article=el('article');article.className='agent-reply-item';article.dataset.assignment=task.id;
      var states={queued:'Waiting for an agent',claimed:'Agent is working',dispatched:'Sent to a session',completed:'Completed',cancelled:'Cancelled'};
      article.appendChild(el('strong',t(task.status==='queued'&&!task.text&&task.voice_url?'Waiting for an agent that can use audio':states[task.status]||'Waiting for an agent')));
      if(task.connection_name)article.appendChild(el('small',task.connection_name));
      var body=el('p',task.text||t('Voice reply'));body.setAttribute('data-duva-content','');article.appendChild(body);
      if(task.reason)article.appendChild(el('small',task.reason));
      if(task.voice_url){var voice=el('audio');voice.controls=true;voice.preload='none';voice.src=config.base+task.voice_url;article.appendChild(voice);}
      if(task.result){var result=el('p',task.result);result.setAttribute('data-duva-content','');article.appendChild(result);}
      return article;
    }
    function upsert(task){var old=Array.from(history.children).find(function(x){return x.dataset.assignment===task.id;}),signature=JSON.stringify(task);if(old&&old.dataset.signature===signature)return;if(old&&Array.from(old.querySelectorAll('audio')).some(function(audio){return !audio.paused;}))return;var fresh=row(task);fresh.dataset.signature=signature;if(old)old.replaceWith(fresh);else history.appendChild(fresh);}
    async function refresh(append){
      try{var page=await api('/api/audio/'+encodeURIComponent(id)+'/replies'+(append&&cursor?'?after='+cursor:''));page.items.forEach(upsert);cursor=page.next_cursor;more.hidden=!cursor;}
      catch(error){say('Replies could not be loaded. Reopen this panel to retry.');}
    }
    more.onclick=function(){refresh(true);};
    form.onsubmit=async function(event){event.preventDefault();if(sending||recording)return;
      if(!pending){if(!text.value.trim()&&!blob){say('Type a reply or record your voice.');return;}
        if(['cloud','local'].includes(target.value)&&!connections.value){say('Choose a project connection');connections.focus();return;}
        pending={client_id:crypto.randomUUID(),text:text.value.trim(),agent_id:agents.value,target:target.value,connection_id:['cloud','local'].includes(target.value)?connections.value:'',playback_seconds:blob?position:(player&&Number.isFinite(player.currentTime)?player.currentTime:0),voice:blob};}
      sending=true;lock(true);send.disabled=true;send.textContent=t('Sending reply…');
      try{var body=new FormData();Object.keys(pending).forEach(function(key){if(key==='voice'){if(pending.voice)body.set('voice',pending.voice,'reply');}else body.set(key,String(pending[key]));});
        var data=await api('/api/audio/'+encodeURIComponent(id)+'/replies',{method:'POST',body:body});upsert(data.assignment);pending=null;text.value='';clearRecording();lock(false);send.textContent=t('Send reply');say('Saved for your agent');
      }catch(error){if(error.status>=400&&error.status<500&&![408,409,429].includes(error.status)){pending=null;lock(false);send.textContent=t('Send reply');say('Reply was not accepted. Check your reply and connection, then try again.');}else{send.textContent=t('Retry sending');say('Sending could not be confirmed. Retry to check the same reply.');}}
      finally{sending=false;send.disabled=false;}
    };
    box.addEventListener('toggle',function(){
      if(!box.open){stop();clearInterval(poll);return;}
      refresh(false);api('/api/assignments/agents').then(function(data){var selected=agents.value;agents.replaceChildren(new Option(t('Next available agent'),''));data.agents.forEach(function(a){agents.appendChild(new Option(a.name,a.id));});agents.value=selected;}).catch(function(){say('Agent choices could not be loaded. Reopen this panel to retry.');});
      api('/api/assignments/connections').then(function(data){connectionList=data.connections;selectConnections(connections.value);}).catch(function(){say('Connections could not be loaded. Reopen this panel to retry.');});
      clearInterval(poll);poll=setInterval(function(){if(!box.isConnected||!box.open){clearInterval(poll);stop();return;}if(!document.hidden)refresh(false);},10000);
    });
    window.addEventListener('pagehide',function(){clearInterval(poll);stop();if(blobUrl)URL.revokeObjectURL(blobUrl);},{once:true});
    return box;
  }};
})();
`;
}
