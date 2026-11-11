'use strict';
// Public rendezvous/relay service. Routes only bounded per-seat messages in memory,
// not authoritative game state, full decks, host private hands, saves, or admin credentials.
// Deploy over HTTPS/WSS on a single instance (rooms are held in memory).
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {acceptWebSocket}=require('./ws-lite.cjs');
const PORT=Number(process.env.PORT||4180);
// Render must listen on 0.0.0.0; local runs remain loopback-only by default.
const HOST=process.env.HOST||(process.env.RENDER?'0.0.0.0':'127.0.0.1');
const rooms=new Map(),visitors=new Map();
const ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_ROOMS=100,ROOM_IDLE_LIFETIME=6*3600*1000;
function code(){let s;do{s=Array.from(crypto.randomBytes(6),b=>ALPHABET[b%ALPHABET.length]).join('')}while(rooms.has(s));return s}
function recent(ip){let t=visitors.get(ip);const now=Date.now();if(!t||now>t.reset){t={count:0,reset:now+60000};visitors.set(ip,t)}return ++t.count<=30}
function allowsMessage(client){
 const now=Date.now();
 if(!client.rate||now>=client.rate.until)client.rate={until:now+10000,count:0};
 return ++client.rate.count<=400; // generous limit even for rapid state updates
}
function leave(client){
 if(!client.room)return;
 const room=client.room;client.room=null;
 if(client.role==='host'){
  rooms.delete(room.code);
  if(room.guest){room.guest.send({type:'hostLeft'});room.guest.room=null;room.guest.role=null}room.guestTicket=null;
 }else if(client.role==='guest'){
  if(room.guest===client)room.guest=null;
  // On a dropped socket, keep the seat reserved for the same browser.
  // Explicit Leave clears the reservation; refresh/reconnect does not.
  if(client.explicitLeave){room.guestTicket=null;room.guestName=null;}
  room.host.send({type:'guestLeft'});
 }
 client.role=null;
}
function handle(client,message){
 if(!message||typeof message!=='object'||Array.isArray(message))return client.send({type:'error',error:'Invalid message'});
 const type=message.type;
 if(type==='create'){
  if(!recent(client.ip))return client.send({type:'error',error:'Too many room requests. Try again later.'});
  if(client.room)return client.send({type:'error',error:'Leave your existing room first'});
  if(rooms.size>=MAX_ROOMS)return client.send({type:'error',error:'Lobby service is full'});
  const room={code:code(),host:client,guest:null,guestTicket:null,guestName:null,created:Date.now(),lastActivity:Date.now()};rooms.set(room.code,room);
  client.role='host';client.room=room;return client.send({type:'created',code:room.code});
 }
 if(type==='join'){
  if(client.room)return client.send({type:'error',error:'Already in a room'});
  if(!recent(client.ip))return client.send({type:'error',error:'Too many attempts. Try again later.'});
  const room=rooms.get(String(message.code||'').trim().toUpperCase());
  if(!room)return client.send({type:'error',error:'Room not found'});
  if(room.guest)return client.send({type:'error',error:'Room is already full'});
  const provided=typeof message.reconnectToken==='string'?message.reconnectToken:'';
  if(room.guestTicket){
   const expected=Buffer.from(room.guestTicket,'hex');
   if(!/^[a-f0-9]{64}$/.test(provided)||
       !crypto.timingSafeEqual(expected,Buffer.from(provided,'hex')))
    return client.send({type:'error',error:'Room seat reserved for the original friend'});
  }
  if(!room.guestTicket)room.guestTicket=crypto.randomBytes(32).toString('hex');
  client.role='guest';client.room=room;room.guest=client;client.explicitLeave=false;
  const name=room.guestName||String(message.name||'Friend').slice(0,30).replace(/[<>\x00-\x1f]/g,'')||'Friend';
  room.guestName=name;
  room.host.send({type:'guestJoined',name});
  return client.send({type:'joined',code:room.code,name,reconnectToken:room.guestTicket});
 }
 if(type==='leave'){
  client.explicitLeave=true;leave(client);return client.send({type:'left'});
 }
 if(!client.room)return client.send({type:'error',error:'Join a room first'});
 client.room.lastActivity=Date.now();
 if(['toGuest','toHost'].includes(type)&&!allowsMessage(client))return client.send({type:'error',error:'Too many match messages'});
 if(client.role==='guest'&&type==='ready'){
  const ready=message.ready===true;client.room.host.send({type:'guestReady',ready});return client.send({type:'readySet',ready});
 }
 if(client.role==='host'&&type==='toGuest'){
  // Relay opaque, bounded gameplay payloads, never authoritative match data.
  // Only the host can send guest views; the relay does not store them.
  if(!client.room.guest)return client.send({type:'error',error:'No guest connected'});
  if(!message.payload||typeof message.payload!=='object'||Array.isArray(message.payload))return client.send({type:'error',error:'Invalid payload'});
  if(Buffer.byteLength(JSON.stringify(message.payload),'utf8')>5600)return client.send({type:'error',error:'Payload too large'});
  return client.room.guest.send({type:'hostMessage',payload:message.payload});
 }
 if(client.role==='guest'&&type==='toHost'){
  // The room association, not any client-provided player ID, identifies seat 1.
  // Host must still validate decision ID, action shape and whose turn it is.
  const payload=message.payload;
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||
     !['matchAction','requestState'].includes(payload.kind)||
     Buffer.byteLength(JSON.stringify(payload),'utf8')>1000)
    return client.send({type:'error',error:'Invalid game message'});
  return client.room.host.send({type:'guestMessage',payload});
 }
 // A real, active host sends periodic application keepalives over WSS.
 // Render counts inbound WebSocket traffic as activity on its free tier.
 if(client.role==='host'&&type==='ping')return client.send({type:'pong'});
 client.send({type:'error',error:'Unknown lobby message'});
}
const server=http.createServer((req,res)=>{
 const uri=new URL(req.url,'http://localhost');
 if(req.method!=='GET'){res.writeHead(405);return res.end()}
 if(uri.pathname==='/health')return(res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}),res.end(JSON.stringify({ok:true,service:'jest-room-relay'})));
 if(uri.pathname==='/match-ui.js'||uri.pathname==='/guest-client.js'){
  res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  return res.end(fs.readFileSync(path.join(__dirname,uri.pathname==='/match-ui.js'?'match-ui.js':'guest-client.js')));
 }
 if(uri.pathname==='/'||uri.pathname==='/join'){
  const page=fs.readFileSync(path.join(__dirname,'guest.html'));
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});return res.end(page);
 }
 res.writeHead(404);res.end('Not found');
});
server.on('upgrade',(req,socket,head)=>{
 if(new URL(req.url,'http://localhost').pathname!=='/socket')return socket.destroy();
 const origin=req.headers.origin;
 if(origin){try{const url=new URL(origin);if(url.host!==req.headers.host)return socket.destroy()}catch{return socket.destroy()}}
 // Render terminates TLS at its load balancer and supplies X-Forwarded-For.
 // Prefer the forwarded client address only in a Render-managed environment.
 const forwarded=process.env.RENDER?String(req.headers['x-forwarded-for']||'').split(',')[0].trim():'';
 const client={role:null,room:null,ip:forwarded||req.socket.remoteAddress,send:null};
 const ws=acceptWebSocket(req,socket,head,msg=>handle(client,msg),()=>leave(client));
 if(ws)client.send=obj=>ws.send(obj);
});
const cleanup=setInterval(()=>{
 const now=Date.now();for(const room of rooms.values())if(now-room.lastActivity>ROOM_IDLE_LIFETIME){room.host.send({type:'expired'});room.host.room=null;room.host.role=null;if(room.guest){room.guest.send({type:'expired'});room.guest.room=null;room.guest.role=null}rooms.delete(room.code)}
 for(const [ip,v]of visitors)if(now>v.reset)visitors.delete(ip);
},60000);cleanup.unref();
server.listen(PORT,HOST,()=>console.log(`Jest multiplayer relay listening on ${HOST}:${PORT} (Render WSS via the public service URL)`));
function shutdown(signal){
 for(const room of rooms.values()){try{room.host.send({type:'hostShutdown'});room.guest?.send({type:'hostShutdown'})}catch{}}
 server.close(()=>process.exit(0));
 setTimeout(()=>process.exit(0),2000).unref();
}
if(require.main===module){process.once('SIGTERM',()=>shutdown('SIGTERM'));process.once('SIGINT',()=>shutdown('SIGINT'))};
module.exports={server,rooms};
