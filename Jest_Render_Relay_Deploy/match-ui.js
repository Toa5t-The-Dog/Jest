'use strict';
// Shared client-only renderer. It receives ONE seat's filtered projection.
// Never contains the opposing hand or either deck's unrevealed order.
(()=>{
 function mount(root,onAction){
  if(!root)return ()=>{};
  const create=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(cls)e.className=cls;return e};
  return function render(state){
   root.replaceChildren();if(!state){root.hidden=true;return}root.hidden=false;
   root.append(create('h4',`Friend Match · Battle ${state.battle}`));
   root.append(create('p',state.note,'mp-muted'));
   root.append(create('p',`You: ${state.chips[state.seat]} chips · Friend: ${state.chips[1-state.seat]} chips · Bank: ${state.bank}`));
   if(state.lastBattle)root.append(create('p',`Last battle: ${state.lastBattle.scores.join(' vs ')} · chip transfer to host ${state.lastBattle.chipTransferToHost>=0?'+':''}${state.lastBattle.chipTransferToHost}`,'mp-muted'));
   const publicJesters=state.jesters||[[],[]];
   root.append(create('p',`Your Jesters: ${publicJesters[state.seat]?.join(', ')||'None'} · Friend's Jesters: ${publicJesters[1-state.seat]?.join(', ')||'None'} (selected base abilities active; others pending)`,'mp-muted'));
   root.append(create('p',`Your Trick cards (${state.hand?.length||0}/5) · Friend has ${state.rivalHandCount||0} hidden Trick cards`,'mp-muted'));
   const act=(label,action)=>{const b=create('button',label);b.type='button';b.className='mp-action';b.addEventListener('click',()=>onAction(state.decisionId,action));root.append(b);};
   const hand=create('div',undefined,'mp-hand');
   const cardButton=(container,label,action)=>{
    const b=create('button',label,'mp-action');b.type='button';
    b.addEventListener('click',()=>onAction(state.decisionId,action));container.append(b);
   };
   for(const card of state.hand||[]){
    const item=create('div',undefined,'mp-owned-card');
    item.append(create('span',`${card.name} (${card.cost} chips)${card.abilityAvailable?'':' · Ability not active in this prototype'}`));hand.append(item);
    if(!state.canAct||state.phase==='shop')continue;
    const afterRoll=state.phase==='reroll'||state.phase==='score';
    const beforeRoll=state.phase==='roll';
    if(card.id==='heal')cardButton(item,'Use Gain 3 Chips',{type:'playHeal',index:card.index});
    if(card.id==='handBounty')cardButton(item,'Use Hand Count Chips',{type:'playHandBounty',index:card.index});
    if(card.id==='extra'&&beforeRoll)cardButton(item,'Use Extra Die',{type:'playExtra',index:card.index});
    if(card.id==='all'&&afterRoll)cardButton(item,'Reroll all scoring dice',{type:'playAll',index:card.index});
    if(card.id==='one'&&afterRoll){
     for(let i=0;i<state.dice.length;i++)cardButton(item,`Reroll die ${i+1} (${state.dice[i]})`,{type:'playOne',index:card.index,die:i});
    }
    if(card.id==='set'&&afterRoll){
     const label=create('label','Choose die / face: ','mp-muted');
     const die=create('select');const face=create('select');
     for(let i=0;i<state.dice.length;i++){const o=create('option',`Die ${i+1} (${state.dice[i]})`);o.value=String(i);die.append(o);}
     for(let n=1;n<=6;n++){const o=create('option',String(n));o.value=String(n);face.append(o);}
     label.append(die,face);item.append(label);
     const btn=create('button','Set selected die','mp-action');btn.type='button';
     btn.addEventListener('click',()=>onAction(state.decisionId,{type:'playSet',index:card.index,die:Number(die.value),face:Number(face.value)}));item.append(btn);
    }
    if(card.id==='tradeUp'){
     for(const target of state.hand||[]){if(target.index===card.index)continue;
      cardButton(item,`Discard ${target.name} (copy ${target.index+1}) · draw ${target.cost}`,
       {type:'playTradeUp',index:card.index,discardIndex:target.index});
     }
    }
    if(card.id==='strip'&&beforeRoll){
     cardButton(item,'Draw up to 2 Tricks',{type:'playStrip',index:card.index,mode:'draw'});
     cardButton(item,'Rival discards up to 2 randomly',{type:'playStrip',index:card.index,mode:'discard'});
    }
    if(card.id==='shopSweep'&&beforeRoll)cardButton(item,'Draw up to 2 Tricks',{type:'playShopSweep',index:card.index});
    if(card.id==='jesterStop'&&beforeRoll){
     cardButton(item,'Stop rival Jesters this battle',{type:'playJesterStop',index:card.index,mode:'jester'});
     cardButton(item,'Stop rival Tricks this battle',{type:'playJesterStop',index:card.index,mode:'trick'});
    }
   }
   root.append(hand);
   if(state.phase==='done'){
    root.append(create('h4',state.winner==='draw'?'Draw':state.winner===state.seat?'You won!':'Your friend won!'));return;
   }
   if(state.phase==='afterBattle'){
    root.append(create('h4',`After Battle ${state.battle} · Trick decisions`));
    if(!state.canAct){root.append(create('p','Waiting for your friend’s after-battle decisions…'));return;}
    for(const card of state.afterChoices||[]){
     if(card==='burn'){
      act('Both players gain up to 2 chips from bank',{type:'afterPlay',card:'burn',mode:'gain'});
      act('Both players lose up to 2 chips to bank',{type:'afterPlay',card:'burn',mode:'lose'});
     }else act(card==='draw'?'Use Trick 2/3: draw one card':card==='steal'?'Steal one chip': 'Use Jester Scout', {type:'afterPlay',card});
    }
    act('Finish after-battle decisions',{type:'afterPass'});return;
   }
   if(state.phase==='scout'){
    root.append(create('h4','Private Jester Scout offer'));
    if(state.canAct&&state.scoutOffer){const offer=state.scoutOffer;
     root.append(create('p',`${offer.name} · ${offer.price} chips`));
     if(offer.canBuy)act(`Buy ${offer.name}`,{type:'scoutBuy'});
     act('Decline Jester',{type:'scoutDecline'});
    }else root.append(create('p','Waiting for your friend’s private Jester offer…'));
    return;
   }
   if(state.phase==='shop'){
    const s=state.shop;root.append(create('h4',`Shop ${s.visit} · ${s.kind==='trick'?'Tricks':'Jesters'} (stage ${s.stage}/${s.stages})`));
    root.append(create('p',`Your private offers: ${s.offers.length}; friend's offers: ${s.rivalOfferCount}. You have ${s.purchasesLeft} purchase${s.purchasesLeft===1?'':'s'} remaining.`,'mp-muted'));
    if(!state.canAct){root.append(create('p','Waiting for your friend to finish shopping…'));return;}
    for(const offer of s.offers)act(`Buy ${offer.name} — ${offer.price} chips${offer.abilityAvailable?'':' (ability pending)'}`,{type:'buy',index:offer.index});
    if(s.kind==='trick'&&state.hand?.length){
     root.append(create('p','Discard a Trick to make room if your hand is full.','mp-muted'));
     for(const card of state.hand)act(`Discard ${card.name} (copy ${card.index+1})`,{type:'discard',index:card.index});
    }
    act('Finish shopping',{type:'pass'});return;
   }
   root.append(create('p',state.canAct?'Your turn.':'Waiting for your friend…'));
   if(state.dice?.length){
    const row=create('div',undefined,'mp-dice');const checks=[];
    for(let i=0;i<state.dice.length;i++){
     const label=create('label',undefined,'mp-die');const check=create('input');check.type='checkbox';check.checked=false;
     check.disabled=!state.canAct||!(['reroll','score'].includes(state.phase))||
      (state.phase==='score'&&!state.canGreedReroll)||
      (state.phase==='reroll'&&state.normalRerollUsed&&!state.canGreedReroll);
     label.append(check,create('span',String(state.dice[i])));row.append(label);checks.push(check);
    }
    root.append(row);root.append(create('p',`White Trick die: ${state.trickDie} (4: bank chip; 5–6: draw a Trick after scoring)`,'mp-muted'));
    if(state.canAct&&state.phase==='reroll'&&!state.normalRerollUsed){const b=create('button','Normal reroll · unchecked dice');b.type='button';b.className='mp-action';b.addEventListener('click',()=>onAction(state.decisionId,{type:'reroll',hold:checks.flatMap((x,i)=>x.checked?[i]:[])}));root.append(b);}
    if(state.canAct&&state.canGreedReroll){const b=create('button','Greed extra reroll · pay 1 chip');b.type='button';b.className='mp-action';b.addEventListener('click',()=>onAction(state.decisionId,{type:'greedReroll',hold:checks.flatMap((x,i)=>x.checked?[i]:[])}));root.append(b);}
   }
   if(!state.canAct)return;
   if(state.publicEvents?.length){const events=create('div',undefined,'mp-muted');events.append(create('p','Recent public effects:'));
    for(const event of state.publicEvents.slice(-4))events.append(create('p',`Player ${event.seat+1}: ${event.card?event.card+' — ':''}${event.effect}`));root.append(events);}
   if(state.phase==='roll')act('Roll Dice',{type:'roll'});
   else if(state.phase==='reroll')act(state.rerolls===0?'Keep roll · +4 bonus':'Keep roll',{type:'keep'});
   else if(state.phase==='score'){
    root.append(create('h4','Choose your scoring set'));
    for(const choice of state.choices||[])act(`${choice.name}: ${choice.total} points · ${choice.dice.join(', ')}`,{type:'score',id:choice.id});
   }
  };
 }
 window.FriendMatchUI={mount};
})();
