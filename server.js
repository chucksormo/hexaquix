const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const GRID_RADIUS = 8;
const MAX_PLAYERS = 50;
const SHRINK_INTERVAL = 30;
const SHRINK_WARN = 5;
const DUEL_TIMEOUT = 6000;
const MISSILE_TIME = 10; // seconds for missile to reach target
const SPAWN_TIME = 10;   // seconds for spawn selection
const CATS = ['science','history','geography','entertainment','sports',
              'music','food','space','technology','animals'];
const HEX_DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];

const QA = {
  science:[1,1,1,2,2,1,1,1,1,2], history:[2,1,2,1,2,1,2,1,1,1],
  geography:[1,1,1,1,1,2,1,1,2,1], entertainment:[1,1,1,1,1,1,1,1,1,0],
  sports:[2,1,1,2,1,2,1,2,2,1], music:[2,1,1,2,0,2,1,1,2,1],
  food:[1,1,1,1,1,1,1,2,1,1], space:[1,2,1,1,1,1,1,2,2,1],
  technology:[1,1,2,1,1,1,1,1,1,1], animals:[1,1,1,1,1,1,2,1,1,1],
};

/* ════════════════════ HTTP ════════════════════ */
const httpServer = http.createServer((req, res) => {
  let p = req.url.split('?')[0]; if (p === '/') p = '/index.html';
  const fp = path.join(__dirname, p), ext = path.extname(fp);
  const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png'};
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {'Content-Type': mime[ext]||'application/octet-stream'}); res.end(data);
  });
});

/* ════════════════════ HEX ════════════════════ */
const hk = (q,r) => q+','+r;
function hd(q1,r1,q2,r2){const a=q1-q2,b=r1-r2;return Math.max(Math.abs(a),Math.abs(b),Math.abs(a+b))}

function generateGrid(){
  const R=GRID_RADIUS, hm=new Map(), hexes=[];
  for(let q=-R;q<=R;q++) for(let r=Math.max(-R,-q-R);r<=Math.min(R,-q+R);r++){
    const h={q,r,c:null};hexes.push(h);hm.set(hk(q,r),h);
  }
  const nc=hexes.filter(h=>!(h.q===0&&h.r===0));
  nc.sort((a,b)=>{const da=hd(a.q,a.r,0,0),db=hd(b.q,b.r,0,0);return da-db||Math.atan2(Math.sqrt(3)*(a.r+a.q*.5),1.5*a.q)-Math.atan2(Math.sqrt(3)*(b.r+b.q*.5),1.5*b.q)});
  const cc={};CATS.forEach(c=>cc[c]=0);
  nc.forEach(h=>{
    const used=new Set();HEX_DIRS.forEach(d=>{const n=hm.get(hk(h.q+d[0],h.r+d[1]));if(n&&n.c)used.add(n.c)});
    let av=CATS.filter(c=>!used.has(c));if(!av.length)av=[...CATS];
    av.sort((a,b)=>cc[a]-cc[b]);const mn=cc[av[0]],best=av.filter(c=>cc[c]===mn);
    h.c=best[Math.random()*best.length|0];cc[h.c]++;
  });
  return hexes;
}

function generateLoot(grid){
  const loot={};
  grid.filter(h=>!(h.q===0&&h.r===0)).forEach(h=>{
    if(Math.random()<0.18) loot[hk(h.q,h.r)]='destroy';
  });
  return loot;
}

/* ════════════════════ WS ════════════════════ */
const wss = new WebSocketServer({server:httpServer});
const rooms = new Map();
function send(ws,o){if(ws.readyState===1)ws.send(JSON.stringify(o))}
function broadcastRoom(room,msg){room.players.forEach(p=>send(p.ws,msg))}
function broadcastAlive(room,msg){room.players.filter(p=>p.alive!==false).forEach(p=>send(p.ws,msg))}
function genCode(){const ch='ABCDEFGHJKLMNPQRSTUVWXYZ';let c;do{c='';for(let i=0;i<4;i++)c+=ch[Math.random()*ch.length|0]}while(rooms.has(c));return c}
function getP(room,ws){return room.players.find(p=>p.ws===ws)}
function getPIdx(room,idx){return room.players.find(p=>p.idx===idx)}
function getPatHex(room,q,r){return room.players.find(p=>p.alive&&p.q===q&&p.r===r)}

function sendRoomUpdate(room){
  const pl=room.players.map(p=>({name:p.name,idx:p.idx,ready:p.ready||false}));
  room.players.forEach(p=>send(p.ws,{type:'room_update',code:room.code,mode:room.mode,hostIdx:room.hostIdx,players:pl}));
}

function checkClassicStart(room){
  if(room.started||room.players.length<2||room.mode!=='classic')return;
  if(!room.players.every(p=>p.ready))return;
  startClassicGame(room);
}

/* ═══ START CLASSIC ═══ */
function startClassicGame(room){
  room.started=true;
  const grid=generateGrid();
  const edges=grid.filter(h=>hd(h.q,h.r,0,0)===GRID_RADIUS);
  const sorted=edges.map(h=>({q:h.q,r:h.r,a:Math.atan2(Math.sqrt(3)*(h.r+h.q*.5),1.5*h.q)})).sort((a,b)=>a.a-b.a);
  const step=sorted.length/room.players.length,off=Math.random()*step;
  const starts=room.players.map((_,i)=>{const idx=Math.floor(off+i*step)%sorted.length;return{q:sorted[idx].q,r:sorted[idx].r}});
  room.grid=grid;room.ended=false;
  room.aliveHexes=new Set();grid.forEach(h=>room.aliveHexes.add(hk(h.q,h.r)));
  const roster=room.players.map((p,i)=>({name:p.name,start:starts[i],idx:p.idx}));
  room.players.forEach((p,i)=>{
    p.q=starts[i].q;p.r=starts[i].r;p.alive=true;p.loot={destroy:0};
    send(p.ws,{type:'start',grid,you:starts[i],yourIndex:p.idx,players:roster,mode:'classic',lootHexes:{},shrinkInterval:SHRINK_INTERVAL});
  });
  console.log(`  🎮 Room ${room.code} [classic] started – ${room.players.length} players`);
}

/* ═══ START ROYALE – SPAWN PHASE ═══ */
function startRoyaleSpawnPhase(room){
  room.started=true;
  const grid=generateGrid();
  const lootHexes=generateLoot(grid);
  room.grid=grid;room.lootHexes=lootHexes;room.ended=false;room.duels={};room.missiles=[];
  room.safeRadius=GRID_RADIUS;
  room.aliveHexes=new Set();grid.forEach(h=>room.aliveHexes.add(hk(h.q,h.r)));
  room.spawnSelections={};// idx → {q,r}
  room.spawnPhase=true;
  room.aliveCount=room.players.length;
  room.players.forEach(p=>{p.alive=true;p.loot={destroy:0};p.q=0;p.r=0});

  const roster=room.players.map(p=>({name:p.name,idx:p.idx}));
  broadcastRoom(room,{type:'spawn_phase',grid,lootHexes,players:roster,spawnTime:SPAWN_TIME});

  room._spawnTimeout=setTimeout(()=>finalizeSpawns(room),SPAWN_TIME*1000);
  console.log(`  🎮 Room ${room.code} [royale] spawn phase – ${room.players.length} players`);
}

function finalizeSpawns(room){
  if(room.ended)return;
  room.spawnPhase=false;
  // Assign unselected players to random edge hexes
  const edges=room.grid.filter(h=>hd(h.q,h.r,0,0)===GRID_RADIUS);
  const taken=new Set(Object.values(room.spawnSelections).map(s=>hk(s.q,s.r)));
  const available=edges.filter(h=>!taken.has(hk(h.q,h.r)));
  room.players.forEach(p=>{
    if(room.spawnSelections[p.idx]){
      p.q=room.spawnSelections[p.idx].q;p.r=room.spawnSelections[p.idx].r;
    } else {
      const pick=available.length?available.splice(Math.random()*available.length|0,1)[0]:edges[Math.random()*edges.length|0];
      p.q=pick.q;p.r=pick.r;
    }
  });
  const roster=room.players.map(p=>({name:p.name,start:{q:p.q,r:p.r},idx:p.idx}));
  room.players.forEach(p=>{
    send(p.ws,{type:'start',grid:room.grid,you:{q:p.q,r:p.r},yourIndex:p.idx,players:roster,
      mode:'royale',lootHexes:room.lootHexes,shrinkInterval:SHRINK_INTERVAL});
  });
  startShrinkCycle(room);
}

/* ═══ SHRINK ═══ */
function startShrinkCycle(room){
  function cycle(){
    if(room.ended||room.safeRadius<=1)return;
    room._shrinkWarn=setTimeout(()=>{if(!room.ended)broadcastAlive(room,{type:'shrink_warning',newRadius:room.safeRadius-1})},(SHRINK_INTERVAL-SHRINK_WARN)*1000);
    room._shrinkDo=setTimeout(()=>{
      if(room.ended)return;room.safeRadius--;
      const falling=[];
      room.grid.forEach(h=>{if(hd(h.q,h.r,0,0)>room.safeRadius){const k=hk(h.q,h.r);if(room.aliveHexes.has(k)){room.aliveHexes.delete(k);falling.push({q:h.q,r:h.r})}}});
      const elim=[];
      room.players.filter(p=>p.alive).forEach(p=>{
        if(hd(p.q,p.r,0,0)>room.safeRadius){elim.push(p.idx);eliminatePlayer(room,p.ws,'Caught in the shrink!',null)}
      });
      broadcastAlive(room,{type:'shrink',newRadius:room.safeRadius,fallingHexes:falling,eliminated:elim});
      if(!room.ended)cycle();
    },SHRINK_INTERVAL*1000);
  }
  cycle();
}

/* ═══ ELIMINATION ═══ */
function eliminatePlayer(room,ws,reason,killerWs){
  const p=getP(room,ws);if(!p||!p.alive)return;
  p.alive=false;room.aliveCount--;
  if(killerWs){
    const killer=getP(room,killerWs);
    if(killer&&killer.alive){
      killer.loot.destroy=(killer.loot.destroy||0)+p.loot.destroy;p.loot.destroy=0;
      send(killerWs,{type:'loot_transfer',loot:killer.loot});
    }
  }
  send(ws,{type:'eliminated',reason,placement:room.aliveCount+1,total:room.players.length});
  broadcastRoom(room,{type:'player_eliminated',idx:p.idx,reason,aliveCount:room.aliveCount});
  checkRoyaleWinner(room);
}

function checkRoyaleWinner(room){
  if(room.ended)return;
  const alive=room.players.filter(p=>p.alive);
  if(alive.length<=1){
    room.ended=true;clearTimeout(room._shrinkWarn);clearTimeout(room._shrinkDo);
    if(alive.length===1)send(alive[0].ws,{type:'victory',reason:'Last one standing! 🏆'});
    broadcastRoom(room,{type:'royale_over',winnerIdx:alive[0]?.idx??-1,winnerName:alive[0]?.name??'Nobody'});
  }
}

/* ═══ DUELS ═══ */
function startDuel(room,attacker,defender,q,r){
  const key=hk(q,r);
  if(room.duels[key])return send(attacker.ws,{type:'move_rejected',msg:'Duel in progress!'});
  const cat=room.grid.find(h=>h.q===q&&h.r===r)?.c||CATS[Math.random()*CATS.length|0];
  const qIdx=Math.random()*10|0;
  room.duels[key]={p1:attacker.idx,p2:defender.idx,cat,qIdx,ans:{},
    timer:setTimeout(()=>duelTimeout(room,key),DUEL_TIMEOUT)};
  send(attacker.ws,{type:'duel_start',oppName:defender.name,oppIdx:defender.idx,cat,qIdx,hexQ:q,hexR:r});
  send(defender.ws,{type:'duel_start',oppName:attacker.name,oppIdx:attacker.idx,cat,qIdx,hexQ:q,hexR:r});
}

function duelTimeout(room,key){const d=room.duels[key];if(!d)return;if(d.ans[d.p1]===undefined)d.ans[d.p1]=-1;if(d.ans[d.p2]===undefined)d.ans[d.p2]=-1;evalDuel(room,key)}
function evalDuel(room,key){
  const d=room.duels[key];if(!d)return;
  const correct=QA[d.cat][d.qIdx],c1=d.ans[d.p1]===correct,c2=d.ans[d.p2]===correct;
  if((c1&&c2)||(!c1&&!c2)){d.qIdx=Math.random()*10|0;d.ans={};const p1=getPIdx(room,d.p1),p2=getPIdx(room,d.p2);if(p1)send(p1.ws,{type:'duel_next',cat:d.cat,qIdx:d.qIdx});if(p2)send(p2.ws,{type:'duel_next',cat:d.cat,qIdx:d.qIdx});d.timer=setTimeout(()=>duelTimeout(room,key),DUEL_TIMEOUT);return}
  const winIdx=c1?d.p1:d.p2,loseIdx=c1?d.p2:d.p1;
  delete room.duels[key];
  const winner=getPIdx(room,winIdx),loser=getPIdx(room,loseIdx);
  const[q,r]=key.split(',').map(Number);
  if(winner){winner.q=q;winner.r=r}
  if(loser)eliminatePlayer(room,loser.ws,'Lost duel to '+winner?.name,winner?.ws);
  if(winner)send(winner.ws,{type:'duel_result',won:true,q,r,loot:winner.loot});
  if(loser)send(loser.ws,{type:'duel_result',won:false});
  broadcastRoom(room,{type:'duel_ended',winnerIdx:winIdx,loserIdx:loseIdx,hexQ:q,hexR:r});
}

/* ═══ MISSILE ═══ */
function launchMissile(room, p, q, r){
  p.loot.destroy--;
  send(p.ws,{type:'item_used',item:'destroy',loot:p.loot});
  broadcastRoom(room,{type:'missile_launched',fromIdx:p.idx,fromQ:p.q,fromR:p.r,targetQ:q,targetR:r,time:MISSILE_TIME});
  // Schedule impact
  const missileId=Date.now()+'_'+p.idx;
  const timer=setTimeout(()=>{
    room.missiles=room.missiles.filter(m=>m.id!==missileId);
    if(room.ended)return;
    const tk=hk(q,r);
    if(!room.aliveHexes.has(tk)){broadcastRoom(room,{type:'missile_fizzle',targetQ:q,targetR:r});return}
    room.aliveHexes.delete(tk);
    const victim=getPatHex(room,q,r);
    if(victim)eliminatePlayer(room,victim.ws,'Hit by '+p.name+"'s missile! 💣",p.ws);
    broadcastRoom(room,{type:'missile_impact',targetQ:q,targetR:r,byIdx:p.idx});
  },MISSILE_TIME*1000);
  room.missiles.push({id:missileId,timer});
}

/* ═══ ROOM MANAGEMENT ═══ */
function leaveRoom(ws){
  const room=ws.room;if(!room)return;ws.room=null;
  room.players=room.players.filter(p=>p.ws!==ws);
  if(!room.players.length){
    rooms.delete(room.code);clearTimeout(room._shrinkWarn);clearTimeout(room._shrinkDo);clearTimeout(room._spawnTimeout);
    if(room.missiles)room.missiles.forEach(m=>clearTimeout(m.timer));
    return;
  }
  if(!room.started){
    room.players.forEach((p,i)=>{p.idx=i;p.ws.pidx=i});room.hostIdx=0;
    sendRoomUpdate(room);
  } else if(!room.ended){
    broadcastRoom(room,{type:'opp_left',idx:ws.pidx,name:ws.pname});
    if(room.mode==='royale'){room.aliveCount=room.players.filter(x=>x.alive).length;checkRoyaleWinner(room)}
    else if(room.players.length===1){room.ended=true;send(room.players[0].ws,{type:'victory',reason:'All opponents left! 🏆'})}
  }
}

/* ═══ CONNECTION ═══ */
wss.on('connection',ws=>{
  ws.pname='Anon';ws.room=null;ws.pidx=-1;

  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw)}catch{return}
    switch(msg.type){

    case 'create_room':{
      if(ws.room)leaveRoom(ws);
      ws.pname=String(msg.name||'Anon').slice(0,16);
      const mode=msg.mode==='royale'?'royale':'classic';
      const code=genCode();
      const room={code,mode,hostIdx:0,players:[{ws,name:ws.pname,idx:0,ready:false,alive:true,q:0,r:0,loot:{destroy:0}}],
        started:false,ended:false,grid:null,lootHexes:{},safeRadius:GRID_RADIUS,aliveHexes:new Set(),duels:{},missiles:[],aliveCount:0,spawnPhase:false,spawnSelections:{}};
      rooms.set(code,room);ws.room=room;ws.pidx=0;
      send(ws,{type:'room_created',code,mode});sendRoomUpdate(room);
      break;
    }
    case 'join_room':{
      if(ws.room)leaveRoom(ws);
      ws.pname=String(msg.name||'Anon').slice(0,16);
      const code=String(msg.code||'').toUpperCase().trim();
      const room=rooms.get(code);
      if(!room){send(ws,{type:'room_error',msg:'Room not found!'});break}
      if(room.started){send(ws,{type:'room_error',msg:'Game already started!'});break}
      if(room.players.length>=MAX_PLAYERS){send(ws,{type:'room_error',msg:'Room is full!'});break}
      const idx=room.players.length;
      room.players.push({ws,name:ws.pname,idx,ready:false,alive:true,q:0,r:0,loot:{destroy:0}});
      ws.room=room;ws.pidx=idx;
      send(ws,{type:'room_joined',code,mode:room.mode});sendRoomUpdate(room);
      break;
    }
    case 'toggle_ready':{const room=ws.room;if(!room||room.started)break;const p=getP(room,ws);if(p){p.ready=!p.ready;sendRoomUpdate(room);checkClassicStart(room)}break}
    case 'start_game':{
      const room=ws.room;if(!room||room.started)break;
      if(ws.pidx!==room.hostIdx){send(ws,{type:'room_error',msg:'Only host can start!'});break}
      if(room.players.length<2){send(ws,{type:'room_error',msg:'Need at least 2 players!'});break}
      if(room.mode==='royale')startRoyaleSpawnPhase(room);
      else startClassicGame(room);
      break;
    }
    case 'leave_room':{leaveRoom(ws);break}

    /* ── Spawn selection ── */
    case 'select_spawn':{
      const room=ws.room;if(!room||!room.spawnPhase)break;
      const p=getP(room,ws);if(!p)break;
      const{q,r}=msg;
      // Must be edge hex
      if(hd(q,r,0,0)!==GRID_RADIUS){send(ws,{type:'spawn_error',msg:'Must pick an edge hex!'});break}
      // Check not taken
      const taken=Object.entries(room.spawnSelections).find(([_,s])=>s.q===q&&s.r===r);
      if(taken&&Number(taken[0])!==p.idx){send(ws,{type:'spawn_error',msg:'Already taken!'});break}
      room.spawnSelections[p.idx]={q,r};
      broadcastRoom(room,{type:'spawn_selected',idx:p.idx,q,r,name:p.name});
      break;
    }

    /* ── In-game ── */
    case 'move':{
      const room=ws.room;if(!room||!room.started||room.ended||room.spawnPhase)break;
      const p=getP(room,ws);if(!p||!p.alive)break;
      if(room.mode==='royale'){
        const tgt=hk(msg.q,msg.r);
        if(!room.aliveHexes.has(tgt)){send(ws,{type:'move_rejected',msg:'Hex is gone!'});break}
        if(room.duels[tgt]){send(ws,{type:'move_rejected',msg:'Duel in progress!'});break}
        const occ=getPatHex(room,msg.q,msg.r);
        if(occ&&occ!==p){startDuel(room,p,occ,msg.q,msg.r);break}
        p.q=msg.q;p.r=msg.r;
        room.players.filter(x=>x.ws!==ws).forEach(o=>send(o.ws,{type:'opp_move',idx:p.idx,q:msg.q,r:msg.r}));
        if(room.lootHexes[tgt]){const item=room.lootHexes[tgt];delete room.lootHexes[tgt];p.loot[item]=(p.loot[item]||0)+1;send(ws,{type:'loot_item',item,loot:p.loot});broadcastRoom(room,{type:'loot_taken',hexKey:tgt,byIdx:p.idx})}
      } else {
        const others=room.players.filter(x=>x.ws!==ws);
        if(msg.q===0&&msg.r===0){room.ended=true;send(ws,{type:'victory',reason:'You reached the center first! 🏆'});others.forEach(o=>send(o.ws,{type:'defeat',reason:`${ws.pname} reached the center!`}))}
        else others.forEach(o=>send(o.ws,{type:'opp_move',idx:ws.pidx,q:msg.q,r:msg.r}));
      }
      break;
    }
    case 'reset':{const room=ws.room;if(!room||!room.started||room.ended)break;room.players.filter(p=>p.ws!==ws).forEach(o=>send(o.ws,{type:'opp_reset',idx:ws.pidx,q:msg.q,r:msg.r}));break}
    case 'duel_answer':{
      const room=ws.room;if(!room)break;const p=getP(room,ws);if(!p)break;
      const de=Object.entries(room.duels).find(([_,d])=>d.p1===p.idx||d.p2===p.idx);if(!de)break;
      const[key,duel]=de;duel.ans[p.idx]=msg.answer;
      if(duel.ans[duel.p1]!==undefined&&duel.ans[duel.p2]!==undefined){clearTimeout(duel.timer);evalDuel(room,key)}
      break;
    }
    case 'use_item':{
      const room=ws.room;if(!room||room.mode!=='royale'||room.ended)break;
      const p=getP(room,ws);if(!p||!p.alive)break;
      if(msg.item==='destroy'){
        if(!p.loot.destroy||p.loot.destroy<=0){send(ws,{type:'item_error',msg:'No missiles!'});break}
        const{q,r}=msg.target||{};
        if(!room.aliveHexes.has(hk(q,r))){send(ws,{type:'item_error',msg:'Hex already gone!'});break}
        launchMissile(room,p,q,r);
      }
      break;
    }

    }// switch
  });
  ws.on('close',()=>leaveRoom(ws));
});

httpServer.listen(PORT,()=>{console.log(`\n  🔷  HexaQuiz Server\n  ➜  http://localhost:${PORT}\n`)});
