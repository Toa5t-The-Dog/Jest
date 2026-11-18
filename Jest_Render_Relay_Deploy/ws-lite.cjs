'use strict';
// Minimal RFC 6455 transport for the Jest room relay. Clients send masked JSON
// text frames; fragmented text messages and interleaved control frames are valid.
const crypto = require('node:crypto');
const {TextDecoder} = require('node:util');
const MAX_MESSAGE = 8192;
const MAX_FRAME = 8192;
const CLOSE_TIMEOUT_MS = 1000;

function sendFrame(socket, opcode, payload = Buffer.alloc(0)) {
 if (!socket.writable || socket.destroyed) return false;
 const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
 let head;
 if (bytes.length < 126) head = Buffer.from([0x80 | opcode, bytes.length]);
 else if (bytes.length <= 65535) head = Buffer.from([0x80 | opcode, 126, bytes.length >>> 8, bytes.length & 255]);
 else {head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(bytes.length), 2);}
 socket.write(Buffer.concat([head, bytes]));
 return true;
}
function closePayload(code) {const p = Buffer.alloc(2); p.writeUInt16BE(code); return p;}
function allowedCloseCode(code) {
 return [1000,1001,1002,1003,1007,1008,1009,1010,1011,1012,1013,1014].includes(code) || code >= 3000 && code <= 4999;
}
function acceptWebSocket(req, socket, head, onMessage, onClose) {
 const key = req.headers['sec-websocket-key'];
 if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' ||
     !/^[A-Za-z0-9+/]{22}==$/.test(key) || req.headers['sec-websocket-version'] !== '13') {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return null;
 }
 const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

 let pending = Buffer.alloc(0), fragments = [], fragmentedBytes = 0, fragmented = false;
 let closing = false, closed = false, closeSent = false, closeTimer = null;
 let closeDetails = {reasonCode:'REL-C100'};
 const finalize = () => {
  if (closed) return;
  closed = true;
  if (closeTimer) clearTimeout(closeTimer);
  onClose?.(closeDetails);
 };
 const sendClose = code => {if (!closeSent) {closeSent = true; sendFrame(socket, 8, closePayload(code));}};
 const beginClose = (code = 1000, reasonCode = 'REL-C200') => {
  if (closing || closed) return;
  closing = true;
  closeDetails = {reasonCode, closeCode:code};
  sendClose(code);
  // RFC 6455: give the peer time to acknowledge the Close frame. Destroy
  // only if it remains unresponsive. Do not drop the Close frame on the floor.
  closeTimer = setTimeout(() => {
   if (closed || socket.destroyed) return;
   socket.end();
   const fallback = setTimeout(() => {if (!socket.destroyed) socket.destroy();}, 300);
   fallback.unref?.();
  }, CLOSE_TIMEOUT_MS);
  closeTimer.unref?.();
 };
 const fail = (reasonCode, code = 1002) => {
  // Discard the rejected input so the peer's subsequent Close acknowledgment
  // isn't parsed as though it were part of the malformed frame.
  pending = Buffer.alloc(0); fragments = []; fragmentedBytes = 0; fragmented = false;
  beginClose(code, reasonCode);
 };
 const deliver = bytes => {
  let message;
  try {message = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch {return fail('REL-F422',1007);}
  try {onMessage(message);} catch (error) {
   console.error('Jest relay message handling error:', error?.message || String(error));
   sendFrame(socket, 1, JSON.stringify({type:'error',error:'Room message could not be processed'}));
  }
 };
 const parse = chunk => {
  if (closed || !chunk?.length) return;
  pending = pending.length ? Buffer.concat([pending,chunk]) : Buffer.from(chunk);
  // TCP chunks may hold many valid frames: validate each separately, not the
  // aggregate bytes in a coalesced read.
  while (pending.length >= 2 && !closed) {
   const a = pending[0], b = pending[1], fin = !!(a & 0x80), opcode = a & 15;
   if (a & 0x70) return fail('REL-F102'); // RSV bits, no extensions negotiated
   if (!(b & 0x80)) return fail('REL-F106'); // clients MUST mask frames
   if (![0,1,8,9,10].includes(opcode)) return fail('REL-F101');
   const control = opcode >= 8;
   if (control && (!fin || (b & 0x7f) > 125)) return fail('REL-F105');
   let size = b & 127, offset = 2;
   if (size === 126) {if (pending.length < 4) break; size = pending.readUInt16BE(2); offset = 4;}
   if (size === 127) {
    if (pending.length < 10) break;
    const bigSize = pending.readBigUInt64BE(2);
    if (bigSize >> 63n) return fail('REL-F105');
    if (bigSize > BigInt(MAX_FRAME)) return fail('REL-F413',1009);
    size = Number(bigSize); offset = 10;
   }
   if (size > MAX_FRAME) return fail('REL-F413',1009);
   if (control && size > 125) return fail('REL-F105');
   const total = offset + 4 + size;
   if (pending.length < total) break;
   const mask = pending.subarray(offset,offset + 4);
   const data = Buffer.from(pending.subarray(offset + 4,total));
   pending = pending.subarray(total);
   for (let i=0;i<size;i++) data[i] ^= mask[i & 3];

   if (opcode === 8) {
    if (size === 1) return fail('REL-F105');
    let peerCode = 1000;
    if (size >= 2) {
     peerCode = data.readUInt16BE(0);
     if (!allowedCloseCode(peerCode)) return fail('REL-F105');
     try {new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(2));}
     catch {return fail('REL-F422',1007);}
    }
    if (!closing) {closing = true; closeDetails = {reasonCode:'REL-C101',closeCode:peerCode};}
    sendClose(size >= 2 ? peerCode : 1000);
    socket.end();
    return;
   }
   if (closing) continue;
   if (opcode === 9) {sendFrame(socket,10,data);continue;}
   if (opcode === 10) continue;
   if (opcode === 0) {
    if (!fragmented) return fail('REL-F103');
    fragmentedBytes += size;
    if (fragmentedBytes > MAX_MESSAGE) return fail('REL-F413',1009);
    fragments.push(data);
    if (fin) {fragmented = false; const complete = Buffer.concat(fragments,fragmentedBytes);fragments=[];fragmentedBytes=0;deliver(complete);}
    continue;
   }
   // Text data frame (opcode 1).
   if (fragmented) return fail('REL-F104');
   if (fin) {deliver(data);continue;}
   fragmented = true; fragmentedBytes = size; fragments = [data];
  }
  // Only a single partial frame may remain. A complete-message size limit is
  // separately maintained across continuation frames.
  if (!closing && pending.length > MAX_FRAME + 14) fail('REL-F413',1009);
 };
 socket.on('data',parse);
 socket.on('close',finalize);
 socket.on('error',()=>{if (!closing) closeDetails = {reasonCode:'REL-C102'};finalize();});
 // The HTTP upgrade 'head' may already contain a WebSocket message. Parse on
 // the next tick so relay.cjs has installed client.send before onMessage runs.
 if (head?.length) process.nextTick(()=>parse(head));
 return {
  send(obj) {if (!closing && !closed) sendFrame(socket,1,JSON.stringify(obj));},
  close() {beginClose(1000,'REL-C200');},
  get closed() {return closing || closed;}
 };
}
module.exports = {acceptWebSocket};
