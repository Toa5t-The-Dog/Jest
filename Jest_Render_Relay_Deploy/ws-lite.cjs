'use strict';
// Minimal RFC6455 transport for the lobby relay; text JSON only, no dependencies.
const crypto=require('node:crypto');
const MAX_FRAME=8192;
function sendFrame(socket,opcode,payload=Buffer.alloc(0)){
 if(!socket.writable)return;
 const bytes=Buffer.isBuffer(payload)?payload:Buffer.from(payload);
 const head=bytes.length<126?Buffer.from([0x80|opcode,bytes.length]):Buffer.from([0x80|opcode,126,bytes.length>>>8,bytes.length&255]);
 socket.write(Buffer.concat([head,bytes]));
}
function acceptWebSocket(req,socket,head,onMessage,onClose){
 const key=req.headers['sec-websocket-key'];
 if(req.headers.upgrade?.toLowerCase()!=='websocket'||typeof key!=='string'||! /^[A-Za-z0-9+/]{22}==$/.test(key)||req.headers['sec-websocket-version']!=='13'){
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');return null;
 }
 const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
 let pending=Buffer.alloc(0),closed=false;
 const close=details=>{if(closed)return;closed=true;onClose?.(details||{reasonCode:'REL-C100'})};
 const fail=reasonCode=>{sendFrame(socket,8,Buffer.from([0x03,0xEA]));socket.destroy();close({reasonCode:reasonCode||'REL-F101',closeCode:1002})};
 const parse=chunk=>{
  if(closed)return;
  pending=Buffer.concat([pending,chunk]);
  // TCP data is not aligned to WebSocket frames: a single data event can
  // contain several individually valid frames. Validate each frame's size
  // instead of rejecting the combined byte count before parsing.
  while(pending.length>=2){
   const a=pending[0],b=pending[1],opcode=a&15;
   if(!(a&0x80)||! (b&0x80)||a&0x70)return fail('REL-F101');
   let size=b&127,offset=2;
   if(size===127)return fail('REL-F413');
   if(size===126){if(pending.length<4)return;size=pending.readUInt16BE(2);offset=4;}
   if(size>MAX_FRAME)return fail('REL-F413');
   if(pending.length<offset+4+size)return;
   const mask=pending.subarray(offset,offset+4),data=Buffer.from(pending.subarray(offset+4,offset+4+size));
   pending=pending.subarray(offset+4+size);
   for(let i=0;i<data.length;i++)data[i]^=mask[i&3];
   if(opcode===8){const closeCode=data.length>=2?data.readUInt16BE(0):1000;sendFrame(socket,8);socket.end();close({reasonCode:'REL-C101',closeCode});return}
   if(opcode===9){sendFrame(socket,10,data);continue}
   if(opcode===10)continue;
   if(opcode!==1)return fail('REL-F101');
   let message;
   try{message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data))}
   catch{fail('REL-F422');return}
   // An application error is not an invalid WebSocket frame. Report it so
   // the client can recover, but don't evict the host/guest from their room.
   try{onMessage(message)}catch(error){
    console.error('Jest relay message handling error:',error?.message||String(error));
    sendFrame(socket,1,JSON.stringify({type:'error',error:'Room message could not be processed'}));
   }
  }
  // A partial frame should never exceed this bounded memory allowance.
  // In particular, do not apply this limit to coalesced *complete* frames.
  if(pending.length>MAX_FRAME+32)return fail('REL-F413');
 };
 socket.on('data',parse);socket.on('close',()=>close({reasonCode:'REL-C100'}));socket.on('error',()=>close({reasonCode:'REL-C102'}));
 if(head?.length)parse(head);
 return {send(obj){sendFrame(socket,1,JSON.stringify(obj))},close(){sendFrame(socket,8);socket.end()},get closed(){return closed}};
}
module.exports={acceptWebSocket};
