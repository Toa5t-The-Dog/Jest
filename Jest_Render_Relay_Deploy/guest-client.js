'use strict';
// Friend browser client. The room code is an invitation; the private reconnect
// token stays in sessionStorage and is never added to links or logs.
(()=>{
 const $=id=>document.getElementById(id);
 const status=s=>{$('status').textContent=s};
 let ws=null,ready=false,manualLeave=false,attempts=0,retryTimer=null,activeCode='',activeName='';
 const render=window.FriendMatchUI?.mount($('matchPanel'),(decisionId,action)=>{
  if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'toHost',payload:{kind:'matchAction',decisionId,action}}));
 });
 const clearRetry=()=>{if(retryTimer){clearTimeout(retryTimer);retryTimer=null}};
 function tokenFor(code){
  try{const item=JSON.parse(sessionStorage.getItem('jest.friend-reconnect')||'null');
   if(item?.code===code&&/^[a-f0-9]{64}$/.test(item.reconnectToken))return item.reconnectToken;
  }catch{}return null;
 }
 function connect(){
  clearRetry();if(manualLeave||!activeCode)return;
  const url=new URL('/socket',location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';
  const socket=new WebSocket(url);ws=socket;
  status(attempts?'Reconnecting to Rival room…':'Connecting to Rival room…');$('join').disabled=true;
  socket.onopen=()=>socket.send(JSON.stringify({type:'join',code:activeCode,name:activeName,reconnectToken:tokenFor(activeCode)}));
  socket.onmessage=e=>{
   let m;try{m=JSON.parse(e.data)}catch{return}
   if(ws!==socket)return;
   if(m.type==='joined'){
    attempts=0;clearRetry();
    if(m.reconnectToken)sessionStorage.setItem('jest.friend-reconnect',JSON.stringify({code:m.code,reconnectToken:m.reconnectToken}));
    $('form').style.display='none';$('connected').style.display='block';$('who').textContent='Connected to room '+m.code;
    status('Waiting for host to start a Rival match.');
    if(ready)socket.send(JSON.stringify({type:'ready',ready:true}));
    socket.send(JSON.stringify({type:'toHost',payload:{kind:'requestState'}}));
   }else if(m.type==='hostMessage'){
    if(m.payload?.kind==='matchState')render?.(m.payload.state);
    else if(m.payload?.kind==='actionError')status(m.payload.error);
   }else if(m.type==='readySet'){
    ready=m.ready===true;$('ready').textContent=ready?'Not Ready':'Ready';
    status(ready?'Ready — waiting for host.':'Waiting for host.');
   }else if(m.type==='error'){
    status(m.error||'Room request failed.');
    // Once a relay has restarted, its in-memory room codes have expired.
    // Do not retry an invalid or reserved code indefinitely.
    if(/room not found|reserved|full|too many/i.test(String(m.error||''))){
     manualLeave=true;ready=false;clearRetry();$('connected').style.display='none';$('form').style.display='block';
     $('join').disabled=false;socket.close();
    }
   }else if(['hostLeft','expired','hostShutdown'].includes(m.type)){
    manualLeave=true;ready=false;clearRetry();render?.(null);
    status('The host or room is no longer available. Ask for a new room code.');
    $('connected').style.display='none';$('form').style.display='block';$('join').disabled=false;socket.close();
   }
  };
  socket.onerror=()=>{if(ws===socket)status('Connection interrupted. Checking whether the room is still available…')};
  socket.onclose=()=>{
   if(ws!==socket||manualLeave)return;
   render?.(null);
   attempts++;
   if(attempts>8){status('Cannot reconnect. Ask your Rival to make a new room.');$('connected').style.display='none';$('form').style.display='block';$('join').disabled=false;return}
   const delay=Math.min(1000*2**(attempts-1),15000);
   status('Connection lost. Reconnecting automatically…');
   retryTimer=setTimeout(connect,delay);
  };
 }
 function join(){
  manualLeave=true;clearRetry();ws?.close();
  activeCode=$('code').value.trim().toUpperCase();activeName=$('name').value.trim().slice(0,30);
  ready=false;attempts=0;manualLeave=false;
  if(!/^[A-Z0-9]{6}$/.test(activeCode)){status('Enter a six-character room code.');return}
  connect();
 }
 $('form').addEventListener('submit',e=>{e.preventDefault();join()});
 $('ready').addEventListener('click',()=>{
  if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ready',ready:!ready}));
 });
 $('leave').addEventListener('click',()=>{
  manualLeave=true;clearRetry();sessionStorage.removeItem('jest.friend-reconnect');
  if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'leave'}));
  ws?.close();ready=false;activeCode='';$('connected').style.display='none';$('form').style.display='block';
  $('join').disabled=false;status('Left room.');render?.(null);
 });
 const initial=new URLSearchParams(location.search).get('code');
 if(initial){
  $('code').value=initial.toUpperCase().slice(0,6);
  // A refresh automatically restores the same browser's reserved seat.
  if(tokenFor($('code').value))join();
 }
})();
