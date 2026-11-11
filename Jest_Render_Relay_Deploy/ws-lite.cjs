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
 const close=()=>{if(closed)return;closed=true;onClose?.()};
 const fail=()=>{sendFrame(socket,8,Buffer.from([0x03,0xEA]));socket.destroy();close()};
 const parse=chunk=>{
  if(closed)return;
  pending=Buffer.concat([pending,chunk]);
  if(pending.length>MAX_FRAME+32)return fail();
  while(pending.length>=2){
   const a=pending[0],b=pending[1],opcode=a&15;
   if(!(a&0x80)||! (b&0x80)||a&0x70)return fail();
   let size=b&127,offset=2;
   if(size===127)return fail();
   if(size===126){if(pending.length<4)return;size=pending.readUInt16BE(2);offset=4;}
   if(size>MAX_FRAME)return fail();
   if(pending.length<offset+4+size)return;
   const mask=pending.subarray(offset,offset+4),data=Buffer.from(pending.subarray(offset+4,offset+4+size));
   pending=pending.subarray(offset+4+size);
   for(let i=0;i<data.length;i++)data[i]^=mask[i&3];
   if(opcode===8){sendFrame(socket,8);socket.end();close();return}
   if(opcode===9){sendFrame(socket,10,data);continue}
   if(opcode===10)continue;
   if(opcode!==1)return fail();
   try{onMessage(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)))}catch{fail();return}
  }
 };
 socket.on('data',parse);socket.on('close',close);socket.on('error',close);
 if(head?.length)parse(head);
 return {send(obj){sendFrame(socket,1,JSON.stringify(obj))},close(){sendFrame(socket,8);socket.end()},get closed(){return closed}};
}
module.exports={acceptWebSocket};
