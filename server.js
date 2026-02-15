const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const GRID_RADIUS = 5;
const MAX_PLAYERS = 50;
const SPAWN_TIME = 10000;
const MOVE_TIME = 10000;
const QUESTION_TIME = 10000;
const DUEL_TIME = 10000;
const RESULT_TIME = 2500;
const SHRINK_EVERY = 3;
const RACE_STEPS = 10;
const RACE_QUESTION_TIME = 10000;

const anthropic = new Anthropic.default();
const HEX_DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
const hk = (q,r) => q+','+r;
function hd(q1,r1,q2,r2){const a=q1-q2,b=r1-r2;return Math.max(Math.abs(a),Math.abs(b),Math.abs(a+b))}

/* ═══ HTTP ═══ */
const httpServer = http.createServer((req, res) => {
  let p = req.url.split('?')[0]; if (p === '/') p = '/index.html';
  const fp = path.join(__dirname, p), ext = path.extname(fp);
  const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json'};
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {'Content-Type':mime[ext]||'application/octet-stream','Cache-Control':'no-cache,no-store,must-revalidate'});
    res.end(data);
  });
});

/* ═══ GRID ═══ */
function generateGrid(){
  const R=GRID_RADIUS,cats=['a','b','c','d','e'],hm=new Map(),hexes=[];
  for(let q=-R;q<=R;q++) for(let r=Math.max(-R,-q-R);r<=Math.min(R,-q+R);r++){
    const h={q,r,c:null};hexes.push(h);hm.set(hk(q,r),h);
  }
  const nc=hexes.filter(h=>!(h.q===0&&h.r===0));
  nc.sort((a,b)=>hd(a.q,a.r,0,0)-hd(b.q,b.r,0,0));
  const cc={};cats.forEach(c=>cc[c]=0);
  nc.forEach(h=>{
    const used=new Set();HEX_DIRS.forEach(d=>{const n=hm.get(hk(h.q+d[0],h.r+d[1]));if(n&&n.c)used.add(n.c)});
    let av=cats.filter(c=>!used.has(c));if(!av.length)av=[...cats];
    av.sort((a,b)=>cc[a]-cc[b]);const mn=cc[av[0]],best=av.filter(c=>cc[c]===mn);
    h.c=best[Math.random()*best.length|0];cc[h.c]++;
  });
  return hexes;
}

/* ═══ ANTHROPIC QUIZ GENERATION ═══ */
async function generateQuiz(theme){
  const isNorwegian = /[æøåÆØÅ]/.test(theme) || /norsk|norweg|norge/i.test(theme);
  const lang = isNorwegian ? 'Norwegian' : 'the same language as the theme';
  const prompt = `Generate at least 50 fun multiple-choice quiz questions about: "${theme}".
Write all questions and answers in ${lang}.
Return ONLY valid JSON, no markdown, no code fences, no explanation before or after.
Format: {"questions":[{"q":"Question?","options":["A","B","C","D"],"correct":0}]}
"correct" = 0-based index of right answer. Each question must have exactly 4 options.
Make questions fun, varied difficulty, entertaining. You MUST return at least 50 questions.`;

  console.log(`  🧠 Generating quiz for theme: "${theme}"...`);
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 12000,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content[0].text.trim();
  const jsonStr = text.replace(/^```json?\n?/,'').replace(/\n?```$/,'').trim();
  const data = JSON.parse(jsonStr);
  // Accept 35+ questions (we need 35 for turns + some for duels)
  const qs = data.questions || [];
  console.log(`  ✅ Generated ${qs.length} questions`);
  if (qs.length < 35) throw new Error('Not enough questions: got ' + qs.length);
  // Pad to 50 if needed by cycling
  while (qs.length < 50) qs.push(qs[qs.length % 35]);
  return qs;
}

/* ═══ WEBSOCKET ═══ */
const wss = new WebSocketServer({server:httpServer});
const rooms = new Map();
function send(ws,o){if(ws.readyState===1)ws.send(JSON.stringify(o))}
function bc(room,msg){room.players.forEach(p=>send(p.ws,msg))}
function bcAlive(room,msg){room.players.filter(p=>p.alive).forEach(p=>send(p.ws,msg))}
function genCode(){const ch='ABCDEFGHJKLMNPQRSTUVWXYZ';let c;do{c='';for(let i=0;i<4;i++)c+=ch[Math.random()*ch.length|0]}while(rooms.has(c));return c}
function getP(room,ws){return room.players.find(p=>p.ws===ws)}

function sendRoomUpdate(room){
  const pl=room.players.map(p=>({name:p.name,idx:p.idx}));
  bc(room,{type:'room_update',code:room.code,mode:room.mode,hostIdx:room.hostIdx,players:pl,theme:room.theme});
}

/* ═══ GAME FLOW ═══ */

// 1. Host starts → generate quiz → spawn phase → game loop
async function startGame(room){
  room.started=true;
  bc(room,{type:'generating_quiz',theme:room.theme});
  try {
    room.questions = await generateQuiz(room.theme);
  } catch(e){
    console.error('Quiz generation failed:',e.message);
    room.started=false;
    bc(room,{type:'room_error',msg:'Quiz generation failed! Try a different theme.'});
    return;
  }
  room.turnQuestions = room.questions.slice(0,35);
  room.duelQuestions = room.questions.slice(35);
  room.duelQIdx = 0;
  room.grid = generateGrid();
  room.ended=false;
  room.turn=0;
  room.safeRadius=GRID_RADIUS;
  room.aliveHexes=new Set();
  room.grid.forEach(h=>room.aliveHexes.add(hk(h.q,h.r)));
  room.aliveCount=room.players.length;
  room.spawnSelections={};
  room.players.forEach(p=>{p.alive=true;p.q=0;p.r=0;p.pendingMove=null;p.lastAnswer=null});
  room._inQuestion=false;room._resolved=false;

  const roster=room.players.map(p=>({name:p.name,idx:p.idx}));
  bc(room,{type:'spawn_phase',grid:room.grid,players:roster,spawnTime:SPAWN_TIME/1000});

  room._spawnTimer=setTimeout(()=>finalizeSpawns(room),SPAWN_TIME);
  console.log(`  🎮 Room ${room.code} – quiz generated, spawn phase`);
}

function finalizeSpawns(room){
  if(room.ended)return;
  const edges=room.grid.filter(h=>hd(h.q,h.r,0,0)===GRID_RADIUS);
  const taken=new Set(Object.values(room.spawnSelections).map(s=>hk(s.q,s.r)));
  const avail=edges.filter(h=>!taken.has(hk(h.q,h.r)));
  room.players.forEach(p=>{
    if(room.spawnSelections[p.idx]){p.q=room.spawnSelections[p.idx].q;p.r=room.spawnSelections[p.idx].r}
    else{const pick=avail.length?avail.splice(Math.random()*avail.length|0,1)[0]:edges[Math.random()*edges.length|0];p.q=pick.q;p.r=pick.r}
  });
  const roster=room.players.map(p=>({name:p.name,idx:p.idx,q:p.q,r:p.r}));
  bc(room,{type:'game_start',players:roster});
  setTimeout(()=>startTurn(room),1500);
}

// ── TURN LOOP ──
function startTurn(room){
  if(room.ended)return;
  room.turn++;
  room.players.forEach(p=>{p.pendingMove=null;p.lastAnswer=null;p._moveLocked=false});
  // Move phase
  const alive=room.players.filter(p=>p.alive);
  alive.forEach(p=>{
    const adj=HEX_DIRS.map(d=>({q:p.q+d[0],r:p.r+d[1]})).filter(h=>room.aliveHexes.has(hk(h.q,h.r)));
    const si=room.turn%SHRINK_EVERY===0?SHRINK_EVERY:SHRINK_EVERY-(room.turn%SHRINK_EVERY);
    send(p.ws,{type:'move_phase',turn:room.turn,time:MOVE_TIME/1000,adjacent:adj,aliveCount:room.aliveCount,shrinkIn:si});
  });
  room._moveTimer=setTimeout(()=>endMovePhase(room),MOVE_TIME);
  room._movesReceived=0;
  room._moveTarget=alive.length;
}

function checkAllMoved(room){
  if(room._movesReceived>=room._moveTarget){
    clearTimeout(room._moveTimer);
    endMovePhase(room);
  }
}

function endMovePhase(room){
  if(room.ended||room._inQuestion)return;
  room._inQuestion=true;
  // Question phase
  const qIdx=Math.min(room.turn-1, room.turnQuestions.length-1);
  const q=room.turnQuestions[qIdx % room.turnQuestions.length];
  room._currentQ=q;
  room._answers={};
  room._answersReceived=0;
  const alive=room.players.filter(p=>p.alive);
  room._answerTarget=alive.length;
  // Send question WITHOUT correct answer
  alive.forEach(p=>send(p.ws,{type:'question_phase',q:q.q,options:q.options,time:QUESTION_TIME/1000,turn:room.turn}));
  room._questionTimer=setTimeout(()=>resolveAnswers(room),QUESTION_TIME);
}

function checkAllAnswered(room){
  if(room._answersReceived>=room._answerTarget){
    clearTimeout(room._questionTimer);
    resolveAnswers(room);
  }
}

function resolveAnswers(room){
  if(room.ended||room._resolved)return;
  room._resolved=true;
  const q=room._currentQ;
  const correct=q.correct;
  const results=[];
  const movedTo={}; // hk → [player indices]

  room.players.filter(p=>p.alive).forEach(p=>{
    const ans=room._answers[p.idx];
    const gotRight=ans===correct;
    const move=p.pendingMove;
    let newQ=p.q,newR=p.r,moved=false;
    if(gotRight&&move){newQ=move.q;newR=move.r;moved=true}
    results.push({idx:p.idx,name:p.name,correct:gotRight,moved,fromQ:p.q,fromR:p.r,toQ:newQ,toR:newR,answer:ans});
    if(moved){p.q=newQ;p.r=newR}
    const key=hk(p.q,p.r);
    if(!movedTo[key])movedTo[key]=[];
    movedTo[key].push(p.idx);
  });

  // Find duels (2+ players on same hex)
  const duels=[];
  for(const[key,idxs] of Object.entries(movedTo)){
    if(idxs.length>=2)duels.push({key,players:idxs});
  }

  bc(room,{type:'resolve',results,correctAnswer:correct,turn:room.turn});

  if(duels.length>0){
    setTimeout(()=>runDuels(room,duels),1500);
  } else {
    setTimeout(()=>postResolve(room),RESULT_TIME);
  }
}

// ── DUELS ──
function runDuels(room,duels){
  if(room.ended)return;
  room._activeDuels=duels.length;
  duels.forEach(duel=>{
    // Take pairs; if 3+, eliminate all but last two
    while(duel.players.length>2){
      const unlucky=duel.players.splice(Math.random()*duel.players.length|0,1)[0];
      eliminatePlayer(room,unlucky,'Caught in a multi-duel pile-up!');
    }
    const[i1,i2]=duel.players;
    const p1=room.players.find(p=>p.idx===i1),p2=room.players.find(p=>p.idx===i2);
    if(!p1||!p2||!p1.alive||!p2.alive){room._activeDuels--;checkDuelsDone(room);return}
    startSingleDuel(room,p1,p2,duel.key);
  });
}

function startSingleDuel(room,p1,p2,hexKey){
  const q=room.duelQuestions[room.duelQIdx % room.duelQuestions.length];
  room.duelQIdx++;
  const duel={p1:p1.idx,p2:p2.idx,q,ans:{},hexKey,
    timer:setTimeout(()=>duelTimeout(room,hexKey),DUEL_TIME)};
  if(!room._duelMap)room._duelMap={};
  room._duelMap[hexKey]=duel;
  send(p1.ws,{type:'duel_start',oppName:p2.name,oppIdx:p2.idx,q:q.q,options:q.options,time:DUEL_TIME/1000});
  send(p2.ws,{type:'duel_start',oppName:p1.name,oppIdx:p1.idx,q:q.q,options:q.options,time:DUEL_TIME/1000});
  bc(room,{type:'duel_broadcast',idx1:p1.idx,idx2:p2.idx,names:[p1.name,p2.name]});
}

function duelTimeout(room,hexKey){
  const d=room._duelMap?.[hexKey];if(!d)return;
  if(d.ans[d.p1]===undefined)d.ans[d.p1]=-1;
  if(d.ans[d.p2]===undefined)d.ans[d.p2]=-1;
  evalDuel(room,hexKey);
}

function evalDuel(room,hexKey){
  const d=room._duelMap?.[hexKey];if(!d)return;
  const correct=d.q.correct;
  const c1=d.ans[d.p1]===correct,c2=d.ans[d.p2]===correct;
  if((c1&&c2)||(!c1&&!c2)){
    // Tie → next question
    const q=room.duelQuestions[room.duelQIdx % room.duelQuestions.length];
    room.duelQIdx++;d.q=q;d.ans={};
    const p1=room.players.find(p=>p.idx===d.p1),p2=room.players.find(p=>p.idx===d.p2);
    if(p1)send(p1.ws,{type:'duel_next',q:q.q,options:q.options,time:DUEL_TIME/1000,correctWas:correct});
    if(p2)send(p2.ws,{type:'duel_next',q:q.q,options:q.options,time:DUEL_TIME/1000,correctWas:correct});
    d.timer=setTimeout(()=>duelTimeout(room,hexKey),DUEL_TIME);
    return;
  }
  clearTimeout(d.timer);
  const winIdx=c1?d.p1:d.p2,loseIdx=c1?d.p2:d.p1;
  delete room._duelMap[hexKey];
  const winner=room.players.find(p=>p.idx===winIdx),loser=room.players.find(p=>p.idx===loseIdx);
  eliminatePlayer(room,loseIdx,'Lost duel to '+winner?.name);
  send(winner?.ws,{type:'duel_result',won:true,correctAnswer:d.q.correct});
  send(loser?.ws,{type:'duel_result',won:false,correctAnswer:d.q.correct});
  bc(room,{type:'duel_ended',winnerIdx:winIdx,loserIdx:loseIdx});
  room._activeDuels--;
  checkDuelsDone(room);
}

function checkDuelsDone(room){
  if(room._activeDuels<=0){
    room._duelMap={};
    setTimeout(()=>postResolve(room),RESULT_TIME);
  }
}

// ── POST RESOLVE ──
function postResolve(room){
  if(room.ended)return;
  // Shrink check
  if(room.turn % SHRINK_EVERY === 0){
    room.safeRadius--;
    const falling=[];
    room.grid.forEach(h=>{
      if(hd(h.q,h.r,0,0)>room.safeRadius){const k=hk(h.q,h.r);if(room.aliveHexes.has(k)){room.aliveHexes.delete(k);falling.push({q:h.q,r:h.r})}}
    });
    const elim=[];
    room.players.filter(p=>p.alive).forEach(p=>{
      if(hd(p.q,p.r,0,0)>room.safeRadius){elim.push(p.idx);eliminatePlayer(room,p.idx,'Caught in the shrink!')}
    });
    bc(room,{type:'shrink',newRadius:room.safeRadius,fallingHexes:falling,eliminated:elim});
    if(room.ended)return;
    setTimeout(()=>{room._inQuestion=false;room._resolved=false;startTurn(room)},2000);
  } else {
    room._inQuestion=false;room._resolved=false;
    startTurn(room);
  }
}

// ── ELIMINATION ──
function eliminatePlayer(room,idx,reason){
  const p=typeof idx==='number'?room.players.find(x=>x.idx===idx):room.players.find(x=>x.ws===idx);
  if(!p||!p.alive)return;
  p.alive=false;room.aliveCount--;
  send(p.ws,{type:'eliminated',reason,placement:room.aliveCount+1,total:room.players.length});
  bc(room,{type:'player_eliminated',idx:p.idx,reason,aliveCount:room.aliveCount});
  checkWin(room);
}

function checkWin(room){
  if(room.ended)return;
  const alive=room.players.filter(p=>p.alive);
  if(alive.length<=1){
    room.ended=true;
    clearTimeout(room._moveTimer);clearTimeout(room._questionTimer);clearTimeout(room._spawnTimer);
    if(room._duelMap)Object.values(room._duelMap).forEach(d=>clearTimeout(d.timer));
    if(alive.length===1)send(alive[0].ws,{type:'victory',reason:'Last one standing! 🏆'});
    bc(room,{type:'game_over',winnerIdx:alive[0]?.idx??-1,winnerName:alive[0]?.name??'Nobody'});
    console.log(`  🏆 Room ${room.code}: ${alive[0]?.name||'Nobody'} wins!`);
  }
}

/* ═══════════════════════════════════════════════════════════════
   RACE MODE
   ═══════════════════════════════════════════════════════════════ */
async function startRaceGame(room){
  room.started=true;
  bc(room,{type:'generating_quiz',theme:room.theme});
  try{room.questions=await generateQuiz(room.theme)}catch(e){
    console.error('Quiz gen failed:',e.message);room.started=false;
    bc(room,{type:'room_error',msg:'Quiz generation failed! Try a different theme.'});return;
  }
  room.raceQuestions=room.questions.slice(0,40);
  room.duelQuestions=room.questions.slice(40);
  room.duelQIdx=0;
  room.raceQIdx=0;
  room.ended=false;
  room._duelMap={};room._activeDuels=0;
  room.players.forEach(p=>{p.alive=true;p.pos=0;});

  const roster=room.players.map(p=>({name:p.name,idx:p.idx}));
  bc(room,{type:'race_start',players:roster,steps:RACE_STEPS});
  setTimeout(()=>raceNextQuestion(room),2000);
  console.log(`  🏁 Room ${room.code} [race] started – ${room.players.length} players`);
}

function raceNextQuestion(room){
  if(room.ended)return;
  const q=room.raceQuestions[room.raceQIdx%room.raceQuestions.length];
  room.raceQIdx++;
  room._currentQ=q;
  room._answers={};room._answersReceived=0;
  const alive=room.players.filter(p=>p.alive);
  room._answerTarget=alive.length;
  alive.forEach(p=>send(p.ws,{type:'race_question',q:q.q,options:q.options,time:RACE_QUESTION_TIME/1000,qNum:room.raceQIdx}));
  room._questionTimer=setTimeout(()=>resolveRace(room),RACE_QUESTION_TIME);
}

function resolveRace(room){
  if(room.ended||room._raceResolved)return;
  room._raceResolved=true;
  const q=room._currentQ;
  const correct=q.correct;
  const results=[];
  const atFinish=[];

  room.players.filter(p=>p.alive).forEach(p=>{
    const ans=room._answers[p.idx];
    const gotRight=ans===correct;
    const oldPos=p.pos;
    if(gotRight)p.pos=Math.min(RACE_STEPS,p.pos+1);
    else if(ans!==undefined)p.pos=Math.max(0,p.pos-1); // wrong = back. no answer = stay
    results.push({idx:p.idx,name:p.name,correct:gotRight,answered:ans!==undefined,oldPos,newPos:p.pos});
    if(p.pos>=RACE_STEPS)atFinish.push(p.idx);
  });

  bc(room,{type:'race_resolve',results,correctAnswer:correct,qNum:room.raceQIdx});

  if(atFinish.length===1){
    // Single winner!
    room.ended=true;
    const w=room.players.find(p=>p.idx===atFinish[0]);
    send(w.ws,{type:'victory',reason:'🏆 First to the finish!'});
    bc(room,{type:'game_over',winnerIdx:w.idx,winnerName:w.name});
    console.log(`  🏆 Room ${room.code} race: ${w.name} wins!`);
  } else if(atFinish.length>1){
    // Tie at finish → duel
    setTimeout(()=>raceFinishDuel(room,atFinish),2000);
  } else {
    // Continue
    room._raceResolved=false;
    setTimeout(()=>raceNextQuestion(room),3000);
  }
}

function raceFinishDuel(room,tiedIdxs){
  if(room.ended)return;
  // If more than 2, pair them; extras wait
  room._activeDuels=0;room._duelMap={};
  while(tiedIdxs.length>=2){
    const i1=tiedIdxs.shift(),i2=tiedIdxs.shift();
    const p1=room.players.find(p=>p.idx===i1),p2=room.players.find(p=>p.idx===i2);
    if(!p1||!p2)continue;
    room._activeDuels++;
    const duelKey='race_'+i1+'_'+i2;
    const q=room.duelQuestions[room.duelQIdx%room.duelQuestions.length];room.duelQIdx++;
    room._duelMap[duelKey]={p1:i1,p2:i2,q,ans:{},hexKey:duelKey,
      timer:setTimeout(()=>duelTimeout(room,duelKey),DUEL_TIME)};
    send(p1.ws,{type:'duel_start',oppName:p2.name,oppIdx:p2.idx,q:q.q,options:q.options,time:DUEL_TIME/1000});
    send(p2.ws,{type:'duel_start',oppName:p1.name,oppIdx:p1.idx,q:q.q,options:q.options,time:DUEL_TIME/1000});
    bc(room,{type:'duel_broadcast',idx1:i1,idx2:i2,names:[p1.name,p2.name]});
  }
  // Leftover odd player stays at finish
  if(room._activeDuels===0){
    // Everyone dueled, check remaining at finish
    const stillAtFinish=room.players.filter(p=>p.alive&&p.pos>=RACE_STEPS);
    if(stillAtFinish.length===1){
      room.ended=true;
      send(stillAtFinish[0].ws,{type:'victory',reason:'🏆 Won the finish duel!'});
      bc(room,{type:'game_over',winnerIdx:stillAtFinish[0].idx,winnerName:stillAtFinish[0].name});
    } else {
      room._raceResolved=false;
      setTimeout(()=>raceNextQuestion(room),2000);
    }
  }
}

// Override checkDuelsDone for race mode duels
const _origCheckDuelsDone=checkDuelsDone;
checkDuelsDone=function(room){
  if(room.mode==='race'&&room._activeDuels<=0){
    room._duelMap={};
    // After race duels, loser gets sent back to step 9
    // Check if single winner at finish
    const atFinish=room.players.filter(p=>p.alive&&p.pos>=RACE_STEPS);
    if(atFinish.length===1){
      room.ended=true;
      send(atFinish[0].ws,{type:'victory',reason:'🏆 Won the finish duel!'});
      bc(room,{type:'game_over',winnerIdx:atFinish[0].idx,winnerName:atFinish[0].name});
    } else if(atFinish.length>1){
      setTimeout(()=>raceFinishDuel(room,atFinish.map(p=>p.idx)),2000);
    } else {
      room._raceResolved=false;
      setTimeout(()=>raceNextQuestion(room),2000);
    }
    return;
  }
  _origCheckDuelsDone(room);
};

// Override eliminatePlayer for race — loser goes back to step 9
const _origElim=eliminatePlayer;
eliminatePlayer=function(room,idx,reason){
  if(room.mode==='race'){
    const p=typeof idx==='number'?room.players.find(x=>x.idx===idx):null;
    if(p){p.pos=RACE_STEPS-1;send(p.ws,{type:'race_duel_lost',pos:p.pos});
      bc(room,{type:'race_pos_update',idx:p.idx,pos:p.pos,reason:'Lost duel – back to step '+(RACE_STEPS-1)});
    }
    return;
  }
  _origElim(room,idx,reason);
};

/* ═══ ROOM MANAGEMENT ═══ */
function leaveRoom(ws){
  const room=ws.room;if(!room)return;ws.room=null;
  const wasIdx=ws.pidx;
  room.players=room.players.filter(p=>p.ws!==ws);
  if(!room.players.length){
    rooms.delete(room.code);
    clearTimeout(room._moveTimer);clearTimeout(room._questionTimer);clearTimeout(room._spawnTimer);
    if(room._duelMap)Object.values(room._duelMap).forEach(d=>clearTimeout(d.timer));
    return;
  }
  if(!room.started){
    room.players.forEach((p,i)=>{p.idx=i;p.ws.pidx=i});room.hostIdx=0;
    sendRoomUpdate(room);
  } else if(!room.ended){
    bc(room,{type:'player_left',idx:wasIdx,name:ws.pname});
    room.aliveCount=room.players.filter(x=>x.alive).length;
    checkWin(room);
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
      const theme=String(msg.theme||'General Knowledge').slice(0,80);
      const mode=msg.mode==='race'?'race':'royale';
      const code=genCode();
      const room={code,theme,mode,hostIdx:0,
        players:[{ws,name:ws.pname,idx:0,alive:true,q:0,r:0,pendingMove:null,lastAnswer:null}],
        started:false,ended:false,grid:null,questions:null,turnQuestions:null,duelQuestions:null,
        turn:0,safeRadius:GRID_RADIUS,aliveHexes:new Set(),aliveCount:0,spawnSelections:{},
        _duelMap:{},_activeDuels:0};
      rooms.set(code,room);ws.room=room;ws.pidx=0;
      send(ws,{type:'room_created',code});sendRoomUpdate(room);
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
      room.players.push({ws,name:ws.pname,idx,alive:true,q:0,r:0,pendingMove:null,lastAnswer:null});
      ws.room=room;ws.pidx=idx;
      send(ws,{type:'room_joined',code});sendRoomUpdate(room);
      break;
    }
    case 'set_theme':{
      const room=ws.room;if(!room||room.started||ws.pidx!==room.hostIdx)break;
      room.theme=String(msg.theme||'General Knowledge').slice(0,80);
      sendRoomUpdate(room);break;
    }
    case 'start_game':{
      const room=ws.room;if(!room||room.started)break;
      if(ws.pidx!==room.hostIdx){send(ws,{type:'room_error',msg:'Only host can start!'});break}
      if(room.players.length<2){send(ws,{type:'room_error',msg:'Need at least 2 players!'});break}
      if(room.mode==='race')startRaceGame(room);else startGame(room);
      break;
    }
    case 'leave_room':{leaveRoom(ws);break}

    case 'select_spawn':{
      const room=ws.room;if(!room||room.ended)break;
      const p=getP(room,ws);if(!p)break;
      const{q,r}=msg;
      if(hd(q,r,0,0)!==GRID_RADIUS){send(ws,{type:'spawn_error',msg:'Pick an edge hex!'});break}
      const taken=Object.entries(room.spawnSelections).find(([k,s])=>s.q===q&&s.r===r&&Number(k)!==p.idx);
      if(taken){send(ws,{type:'spawn_error',msg:'Already taken!'});break}
      room.spawnSelections[p.idx]={q,r};
      bc(room,{type:'spawn_selected',idx:p.idx,q,r,name:p.name});
      break;
    }

    case 'submit_move':{
      const room=ws.room;if(!room||!room.started||room.ended)break;
      const p=getP(room,ws);if(!p||!p.alive)break;
      if(p._moveLocked){send(ws,{type:'move_rejected'});break} // already locked
      const{q,r}=msg;
      if(q===p.q&&r===p.r){p.pendingMove=null;} // stay
      else if(hd(q,r,p.q,p.r)===1&&room.aliveHexes.has(hk(q,r))){p.pendingMove={q,r}}
      else{send(ws,{type:'move_rejected'});break}
      p._moveLocked=true;
      room._movesReceived++;
      send(ws,{type:'move_accepted'});
      bcAlive(room,{type:'player_locked',idx:p.idx,locked:room._movesReceived,total:room._moveTarget});
      checkAllMoved(room);
      break;
    }

    case 'submit_answer':{
      const room=ws.room;if(!room||!room.started||room.ended)break;
      const p=getP(room,ws);if(!p||!p.alive)break;
      if(room._answers[p.idx]!==undefined)break;
      room._answers[p.idx]=msg.answer;
      room._answersReceived++;
      bcAlive(room,{type:'answer_count',count:room._answersReceived,total:room._answerTarget});
      if(room.mode==='race'){
        if(room._answersReceived>=room._answerTarget){clearTimeout(room._questionTimer);resolveRace(room)}
      } else checkAllAnswered(room);
      break;
    }

    case 'duel_answer':{
      const room=ws.room;if(!room)break;
      const p=getP(room,ws);if(!p)break;
      const de=Object.entries(room._duelMap||{}).find(([_,d])=>d.p1===p.idx||d.p2===p.idx);
      if(!de)break;
      const[key,duel]=de;
      if(duel.ans[p.idx]!==undefined)break;
      duel.ans[p.idx]=msg.answer;
      if(duel.ans[duel.p1]!==undefined&&duel.ans[duel.p2]!==undefined){clearTimeout(duel.timer);evalDuel(room,key)}
      break;
    }

    }
  });
  ws.on('close',()=>leaveRoom(ws));
});

httpServer.listen(PORT,()=>{console.log(`\n  🔷 HexaQuiz Server\n  ➜  http://localhost:${PORT}\n`)});
