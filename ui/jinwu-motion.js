'use strict';
// 金乌入场：赤金焰羽三足神乌自天外飞来，落于扶桑，再展翅振飞向日。
// 每帧由时间 t 纯函数算出（seek 可逐帧检查），不依赖 CSS 关键帧。
(() => {
  // 时间轴：先飞入落枝 ENTER 毫秒，再进入栖枝→起飞故事；内部用故事时间 t（入场段为负）
  const ENTER = 1100, STORY = 4200, duration = ENTER + STORY;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let template, loading, active, generation = 0;
  const mix = (a, b, t) => a + (b - a) * t;
  const ease = (a, b, t) => { const x = Math.max(0, Math.min(1, (t-a)/(b-a))); return x*x*(3-2*x); };
  const p = (x, y) => ({x,y});
  const lerp = (a,b,t) => p(mix(a.x,b.x,t),mix(a.y,b.y,t));
  const add = (a,x,y) => p(a.x+x,a.y+y);
  const xy = a => `${a.x.toFixed(2)},${a.y.toFixed(2)}`;
  const rad = d => d*Math.PI/180;
  // 角度按数学方向（0°=向右，逆时针为正，屏幕 y 向下）
  const dir = (deg, len) => p(Math.cos(rad(deg))*len, -Math.sin(rad(deg))*len);
  const hash = i => { const s = Math.sin(i*127.1+311.7)*43758.5453; return s - Math.floor(s); };
  function node(tag, attrs={}) {
    const el=document.createElementNS('http://www.w3.org/2000/svg',tag);
    for(const [key,value] of Object.entries(attrs)) el.setAttribute(key,value);
    return el;
  }
  // 扇翅相位：1=双翼高举（如参考图），-1=下扑到底
  const LAUNCH = 1000, BEAT = 560;
  function flap(t) {
    if(t<0){ // 飞入：连续扑翼，落枝前双翼高举刹车，再收到栖枝姿态
      const beat=-Math.cos(2*Math.PI*(t+ENTER)/430);
      return mix(mix(beat,1,ease(-460,-220,t)),.62,ease(-160,0,t));
    }
    if(t<620) return .62+Math.sin(t/150)*.08;                 // 栖枝：高举双翼轻颤
    if(t<LAUNCH) return mix(.62,1,ease(620,LAUNCH,t));        // 蓄势：再抬到顶
    if(t<LAUNCH+280) return mix(1,-1,ease(LAUNCH,LAUNCH+280,t)); // 起飞第一记重扑
    const u=(t-LAUNCH-280)/BEAT, amp=1-.3*ease(3300,4200,t);
    return -Math.cos(2*Math.PI*(u+.06*Math.sin(2*Math.PI*u)))*amp+.12*ease(3300,4200,t);
  }
  function poseAt(t) {
    if(t<0){ // 从左上天外滑翔俯冲而来，减速、仰身刹车后落枝
      const k=Math.pow(1-(t+ENTER)/ENTER,2.2), brake=ease(-380,-60,t), fly=1-ease(-200,0,t);
      return {x:-1000*k, y:-300*Math.pow(k,1.3)-flap(t-90)*6*(1-brake),
        pitch:mix(8,-16,brake)*(1-ease(-120,0,t))+flap(t-60)*2.2*(1-brake),
        scale:1, crouch:0, lift:0, air:0, fly};
    }
    const land=Math.exp(-Math.pow((t-110)/150,2))*.9;          // 落枝一沉，卸掉冲力
    const crouch=Math.max(land,ease(620,LAUNCH,t)*(1-ease(LAUNCH,LAUNCH+160,t)));
    const lift=ease(LAUNCH,LAUNCH+320,t), air=ease(LAUNCH+200,STORY,t);
    const bob=-flap(t-90)*5*lift;                              // 每次下扑身体被托起
    return {
      x:262*Math.pow(air,1.25),
      y:7*crouch-30*lift-150*air+bob+(t<LAUNCH?Math.sin(t/210)*1.2:0),
      pitch:5*crouch-14*lift-8*air+flap(t-60)*2.2*lift,
      scale:1-.2*air, crouch, lift, air, fly:0,
    };
  }
  // 焰羽：根部宽、尖端带一个回卷的火舌
  function flameFeather(base, tipDir, len, width, curl) {
    const tip=add(base,tipDir.x*len,tipDir.y*len), n=p(-tipDir.y*width,tipDir.x*width);
    const a=add(base,n.x,n.y), b=add(base,-n.x,-n.y);
    const c1=add(lerp(base,tip,.45),n.x*1.15+curl*.4*n.y,n.y*1.15-curl*.4*n.x);
    const c2=add(lerp(base,tip,.82),n.x*.35+curl*n.y*.9,n.y*.35-curl*n.x*.9);
    const c3=add(lerp(base,tip,.6),-n.x*.9,-n.y*.9);
    return `M${xy(a)}C${xy(c1)} ${xy(c2)} ${xy(tip)}Q${xy(c3)} ${xy(b)}Z`;
  }
  const unit = deg => dir(deg,1);
  const angOf = (a,b) => Math.atan2(-(b.y-a.y),b.x-a.x)*180/Math.PI;
  // 沿折线（肩-肘-腕-手）按弧长取点，并给出该处骨段方向
  function along(pts,s){
    const lens=pts.slice(1).map((q,i)=>Math.hypot(q.x-pts[i].x,q.y-pts[i].y)), total=lens.reduce((x,y)=>x+y,0);
    let d=Math.max(0,Math.min(1,s))*total;
    for(let i=0;i<lens.length;i++){ if(d<=lens[i]||i===lens.length-1) return {pt:lerp(pts[i],pts[i+1],Math.min(1,d/(lens[i]||1))),ang:angOf(pts[i],pts[i+1])}; d-=lens[i]; }
  }
  const feather = (fill, stroke, op=.55, w=.8) => node('path',{fill:`url(#${fill})`,stroke,'stroke-opacity':op,'stroke-width':w,'stroke-linejoin':'round'});
  // 覆羽三排：大覆羽（深橙、长）→ 中覆羽（金）→ 小覆羽（浅金、鳞片状），逐排向翼前缘收短
  const COVERT_ROWS=[
    {n:10,end:.94,off:20,len:36,w:8.5,fill:'covertMid',stroke:'#3a0408',op:.8},
    {n:9,end:.86,off:9,len:25,w:7.5,fill:'covertGold',stroke:'#7a2a08',op:.75},
    {n:8,end:.66,off:1,len:15,w:6,fill:'covertPale',stroke:'#c06a1a',op:.7},
  ];
  function makeWing(group, far) {
    group.replaceChildren();
    const scale=(far?.9:1)*1.34, lagBase=far?45:0;
    const shade=far?node('g',{opacity:.78}):group; if(far) group.append(shade);
    const cover=node('path',{class:'wing-cover',fill:'url(#flameDeep)',stroke:'#ff9a4a','stroke-opacity':.35,'stroke-width':1.2,'stroke-linejoin':'round'});
    // 飞羽背后一排暗红衬羽，从羽缝里透出来，形成层次
    const underP=Array.from({length:9},()=>feather('flameDeep','#ff6a3a',.5));
    const underS=Array.from({length:8},()=>feather('flameDeep','#ff6a3a',.45));
    const primaries=Array.from({length:10},()=>{const el=feather('flameWing','#fff2b0',.7,.9);el.setAttribute('class','primary-feather');return el;});
    const secondaries=Array.from({length:9},()=>{const el=feather('flameWing','#5a1008',.55,.9);el.setAttribute('class','primary-feather');return el;});
    const rows=COVERT_ROWS.map(r=>({...r,els:Array.from({length:r.n},()=>feather(r.fill,r.stroke,r.op,.9))}));
    const shafts=node('path',{fill:'none',stroke:'#fff4c8','stroke-width':.8,'stroke-linecap':'round',opacity:.5});
    const leading=node('path',{fill:'none',stroke:'#ffe9a8','stroke-width':2.4,'stroke-linecap':'round',opacity:.88});
    shade.append(...underP,...primaries.slice().reverse(),...underS,...secondaries,shafts,cover,...rows.flatMap(r=>r.els),leading);
    return t=>{
      const time=t-lagBase, f=flap(time), s=(f+1)/2;
      const fh=flap(time-55), fp=i=>flap(time-85-i*9);
      const a1=mix(212,108,s)+(far?16:0), a2=a1+mix(22,16,(fh+1)/2), a3=a2+mix(28,10,(fh+1)/2);
      // 翼面朝后：臂在水平线上方时羽毛向逆时针（后上）展开，下方时顺时针
      const back=deg=>Math.sin(rad(deg));
      const span=(.82+.18*Math.abs(Math.sin(rad(a1))))*scale;
      const sh=p(0,0), el=add(sh,...Object.values(dir(a1,46*span))), wr=add(el,...Object.values(dir(a2,58*span))), hand=add(wr,...Object.values(dir(a3,46*span)));
      let shaft='';
      const pFeather=(u,i,k)=>{
        const base=lerp(wr,hand,u*.95), fl=Math.sin(t/85+i*1.7)*.12, lag=(fp(i)-f)*14;
        return {base,d:a3+back(a3)*mix(68,2,u)+lag,len:mix(66,108,u)*scale*k,w:mix(9,7,u)*scale,curl:(.5+fl)*(1+u)};
      };
      primaries.forEach((el2,i)=>{
        const q=pFeather(i/9,i,1), tipDir=unit(q.d);
        el2.setAttribute('d',flameFeather(q.base,tipDir,q.len,q.w,q.curl));
        shaft+=`M${xy(q.base)}L${xy(add(q.base,tipDir.x*q.len*.72,tipDir.y*q.len*.72))}`;
      });
      underP.forEach((el2,i)=>{
        const q=pFeather((i+.5)/9,i,.93);
        el2.setAttribute('d',flameFeather(q.base,unit(q.d+back(a3)*6),q.len,q.w*1.1,q.curl*.7));
      });
      const sFeather=(u,i)=>({base:lerp(el,wr,.06+u*.94),d:a2+back(a2)*mix(100,76,u)+(fp(i+4)-f)*10,len:mix(44,66,u)*scale,curl:.35+Math.sin(t/95+i)*.1});
      secondaries.forEach((el2,i)=>{
        const q=sFeather(i/8,i), tipDir=unit(q.d);
        el2.setAttribute('d',flameFeather(q.base,tipDir,q.len,8.5*scale,q.curl));
        shaft+=`M${xy(q.base)}L${xy(add(q.base,tipDir.x*q.len*.65,tipDir.y*q.len*.65))}`;
      });
      underS.forEach((el2,i)=>{
        const q=sFeather((i+.5)/8,i);
        el2.setAttribute('d',flameFeather(q.base,unit(q.d+back(a2)*5),q.len*.92,9*scale,q.curl*.6));
      });
      shafts.setAttribute('d',shaft);
      const inner=add(el,...Object.values(dir(a2+back(a2)*100,38*scale))), outer=add(wr,...Object.values(dir(a2+back(a2)*80,48*scale)));
      cover.setAttribute('d',`M${xy(add(sh,-8,10))}L${xy(sh)}Q${xy(lerp(sh,el,.5))} ${xy(el)}L${xy(wr)}Q${xy(lerp(wr,outer,.5))} ${xy(outer)}L${xy(inner)}Q${xy(lerp(inner,sh,.5))} ${xy(add(sh,-8,10))}Z`);
      const arm=[sh,el,wr,hand];
      rows.forEach((r,k)=>r.els.forEach((c,i)=>{
        const u=i/(r.n-1), at=along(arm,.04+u*(r.end-.04)), d=at.ang+back(at.ang)*mix(98,84,u)+Math.sin(t/110+i+k*2)*2;
        const tip=unit(d), root=add(at.pt,tip.x*r.off*scale,tip.y*r.off*scale);
        c.setAttribute('d',flameFeather(root,tip,r.len*scale*mix(1,.82,u),r.w*scale,.25+k*.05));
      }));
      leading.setAttribute('d',`M${xy(sh)}Q${xy(el)} ${xy(wr)}T${xy(lerp(wr,hand,.9))}`);
      group.setAttribute('transform',`rotate(${(f*2).toFixed(2)})`);
    };
  }
  // 飘带：一串点跟随锚点，越靠尾端相位越滞后——火焰尾羽、蓝色冠带共用
  function ribbon(t, base, angle, len, segs, wave, lagMs, phase) {
    const pts=[base];
    for(let i=1;i<=segs;i++){
      const u=i/segs, sway=Math.sin((t-u*lagMs)/260+phase+u*2.4)*wave*u + flap(t-u*lagMs)*wave*.5*u;
      pts.push(add(pts[i-1],...Object.values(dir(angle+sway,len/segs))));
    }
    return pts;
  }
  const smooth = pts => 'M' + pts.map(xy).join('L');
  function ribbonPath(pts,w0,w1){
    // 两侧偏移成一条由粗到细的带子
    const L=[],R=[];
    pts.forEach((q,i)=>{const a=pts[Math.max(0,i-1)],b=pts[Math.min(pts.length-1,i+1)],dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1,w=mix(w0,w1,i/(pts.length-1));
      L.push(p(q.x-dy/d*w,q.y+dx/d*w));R.push(p(q.x+dy/d*w,q.y-dx/d*w));});
    return `M${xy(L[0])}${L.slice(1).map(q=>'L'+xy(q)).join('')}${R.reverse().map(q=>'L'+xy(q)).join('')}Z`;
  }
  const BIRD_ORIGIN=p(470,318), BIRD_SCALE=.86;
  const RAYS=24;
  function toScene(pose,local){
    const r=rad(pose.pitch),k=pose.scale;
    return p(BIRD_ORIGIN.x+BIRD_SCALE*(pose.x+k*(local.x*Math.cos(r)-local.y*Math.sin(r))),
             BIRD_ORIGIN.y+BIRD_SCALE*(pose.y+k*(local.x*Math.sin(r)+local.y*Math.cos(r))));
  }
  function toLocal(pose,scene){
    const r=-rad(pose.pitch),k=pose.scale,dx=(scene.x-BIRD_ORIGIN.x)/BIRD_SCALE-pose.x,dy=(scene.y-BIRD_ORIGIN.y)/BIRD_SCALE-pose.y;
    return p((dx*Math.cos(r)-dy*Math.sin(r))/k,(dx*Math.sin(r)+dy*Math.cos(r))/k);
  }
  function rig(scene) {
    scene.dataset.rigged='true';
    const flight=scene.querySelector('.bird-flight');
    const far=makeWing(scene.querySelector('.wing-left'),true), near=makeWing(scene.querySelector('.wing-right'),false);
    const torso=scene.querySelector('.bird-torso'), head=scene.querySelector('.bird-head'), eye=scene.querySelector('.bird-eye');
    // 尾羽扇三层：后排暗红长羽 → 中排金羽 → 尾上覆羽
    const tail=scene.querySelector('.tail');tail.replaceChildren();
    const tailBack=Array.from({length:7},()=>feather('flameDeep','#ff6a3a',.5,1));
    const tailFeathers=Array.from({length:5},()=>{const el=node('path',{class:'tail-feather',fill:'url(#flameTail)',stroke:'#ffd27a','stroke-opacity':.5,'stroke-width':1});return el;});
    const tailCoverts=Array.from({length:6},()=>feather('covertMid','#3a0408',.75,.9));
    tail.append(...tailBack,...tailFeathers,...tailCoverts);
    // 体羽：躯干上铺鳞状小羽，从尾端往前画，前排压后排
    const scalesG=scene.querySelector('.body-scales');scalesG.replaceChildren();
    for(let r=0;r<6;r++)for(let c=0;c<9;c++){
      const x=-84+c*16+(r%2)*8, y=-40+r*16;
      scalesG.prepend(node('path',{d:flameFeather(p(x+10,y),unit(205),17,7,.2),fill:`url(#${(r+c)%3?'covertGold':'flameTail'})`,stroke:'#7a2208','stroke-opacity':.7,'stroke-width':.8,opacity:.92}));
    }
    // 颈后蓑羽：从后脑垂向背部的两层长羽
    const hacklesG=scene.querySelector('.hackles');hacklesG.replaceChildren();
    const hackles=Array.from({length:11},(_,i)=>{const el=feather(i<5?'covertMid':'covertGold',i<5?'#3a0408':'#7a2a08',.7);hacklesG.append(el);return el;});
    // 火焰长尾：三条飘带，末端各坠一团火球（参考图）
    const ribbons=scene.querySelector('.tail-ribbons');ribbons.replaceChildren();
    const tails=[{a:200,len:240,w:13,ph:0},{a:214,len:310,w:17,ph:1.7},{a:228,len:280,w:15,ph:3.1},{a:242,len:220,w:12,ph:4.4},{a:190,len:180,w:10,ph:5.6}].map(cfg=>{
      const band=node('path',{fill:'url(#flameRibbon)',opacity:.95}),core=node('path',{fill:'none',stroke:'#ffe9a0','stroke-width':1.6,'stroke-linecap':'round',opacity:.7});
      const ball=node('circle',{r:13,fill:'url(#orb)'}),lick=node('path',{fill:'url(#ember)',opacity:.9});
      ribbons.append(band,core,ball,lick);return {...cfg,band,core,ball,lick};
    });
    // 头顶焰冠 + 蓝色冠带
    const crest=scene.querySelector('.crest');crest.replaceChildren();
    const plumes=Array.from({length:10},(_,i)=>{const el=node('path',{fill:`url(#${i<5?'covertMid':'flameTail'})`,stroke:'#fff0b0','stroke-opacity':.5,'stroke-width':.8});crest.append(el);return el;});
    const streamers=scene.querySelector('.streamers');streamers.replaceChildren();
    const blues=[0,1].map(()=>{const el=node('path',{fill:'url(#streamer)',opacity:.9});streamers.append(el);return el;});
    // 三足
    const legs=scene.querySelector('.talons');legs.replaceChildren();
    legs.setAttribute('fill','none');legs.setAttribute('stroke-linecap','round');legs.setAttribute('stroke-linejoin','round');
    const feet=[p(-14,46),p(2,50),p(18,46)].map((hip,i)=>{
      const leg=node('path',{class:'bird-leg',stroke:'#d88a22','stroke-width':5.5}),toes=node('path',{class:'bird-toes',stroke:'#ffd36a','stroke-width':3.2});
      legs.append(leg,toes);return {hip,i,leg,toes,perch:p(452+i*20,[403,402,402][i])};
    });
    // 火星：一部分在树冠一带上升，一部分在起飞后从尾部洒落
    const embersG=scene.querySelector('.embers');embersG.replaceChildren();
    const embers=Array.from({length:46},(_,i)=>{const el=node('circle',{fill:'url(#ember)',r:0});embersG.append(el);return {el,i,trail:i>=18};});
    const shadow=scene.querySelector('.perch-shadow');
    const cordsG=scene.querySelector('.cords');cordsG.replaceChildren();
    const cords=[{b:p(-20,-30),a:150,len:230,ph:.8},{b:p(10,30),a:225,len:260,ph:2.6}].map(c=>{
      const line=node('path',{fill:'none',stroke:'#b8221e','stroke-width':1.8,'stroke-linecap':'round',opacity:.9});cordsG.append(line);
      const beads=[4,8,12].map(()=>{const el=node('circle',{r:3.6,fill:'#40c8bf',stroke:'#e9fff9','stroke-width':.8});cordsG.append(el);return el;});
      return {...c,line,beads};
    });
    // 日冕：长短相间的光芒，绕神乌缓转，像太阳本体在背后燃烧
    const auraRays=scene.querySelector('.aura-rays');auraRays.replaceChildren();
    const rays=Array.from({length:RAYS},(_,i)=>{const el=node('path',{fill:'url(#ray)'});auraRays.append(el);return {el,i,long:i%2===0};});
    const aura=scene.querySelector('.bird-aura'),auraGlow=scene.querySelector('.aura-glow'),ring=scene.querySelector('.aura-ring'),ring2=scene.querySelector('.aura-ring2'),flare=scene.querySelector('.sun-flare');
    return T=>{
      const t=T-ENTER, pose=poseAt(t);
      flight.setAttribute('transform',`translate(${pose.x.toFixed(2)} ${pose.y.toFixed(2)}) rotate(${pose.pitch.toFixed(2)}) scale(${pose.scale.toFixed(4)})`);
      // 光环：栖枝时含光，起飞一刻迸发，之后随振翅脉动
      const burst=Math.exp(-Math.pow((t-LAUNCH-120)/260,2)), glowK=.35+.4*ease(500,LAUNCH,t)+.25*pose.air+.5*burst+.06*flap(t-40)*pose.lift;
      aura.setAttribute('transform',`translate(${pose.x.toFixed(2)} ${pose.y.toFixed(2)}) scale(${pose.scale.toFixed(4)})`);
      aura.setAttribute('opacity',Math.min(1,glowK).toFixed(3));
      auraGlow.setAttribute('r',(170+40*burst+Math.sin(t/180)*6).toFixed(2));
      ring.setAttribute('r',(96+60*burst+Math.sin(t/260)*3).toFixed(2));ring.setAttribute('stroke-opacity',(.55-.35*burst).toFixed(3));
      ring2.setAttribute('transform',`rotate(${(-t/40).toFixed(2)} 10 -20)`);
      const spin=t/55;
      rays.forEach(({el,i,long})=>{
        const a=i*360/RAYS+spin, flick=.85+.15*Math.sin(t/90+i*2.3), r0=104, r1=r0+(long?110:62)*flick*(1+.6*burst), w=long?7:4;
        const d=unit(a), n=p(-d.y,d.x);
        el.setAttribute('d',`M${xy(add(p(0,0),d.x*r0+n.x*w,d.y*r0+n.y*w))}L${xy(p(d.x*r1,d.y*r1))}L${xy(add(p(0,0),d.x*r0-n.x*w,d.y*r0-n.y*w))}Z`);
      });
      flare.setAttribute('opacity',(.9*ease(3200,4200,t)).toFixed(3));
      far(t);near(t);
      const breath=Math.sin(t/230);
      torso.setAttribute('transform',`translate(0 ${(pose.crouch*4).toFixed(2)}) scale(${(1+breath*.008).toFixed(4)} ${(1+breath*.014-pose.crouch*.03).toFixed(4)})`);
      // 头：栖枝时左右顾盼，起飞后昂首向日
      const look=Math.sin(t/330)*4*(1-Math.max(pose.lift,pose.fly))-pose.crouch*6+pose.lift*4-ease(2400,3800,t)*4;
      head.setAttribute('transform',`rotate(${look.toFixed(2)} 36 -30) translate(${(pose.crouch*3).toFixed(2)} ${(Math.sin(t/240)*.8+pose.crouch*3).toFixed(2)})`);
      const blink=Math.max(Math.exp(-Math.pow((t-320)/40,2)),Math.exp(-Math.pow((t-2700)/42,2)));
      eye.setAttribute('transform',`translate(82 -81) scale(1 ${(1-.92*blink).toFixed(3)}) translate(-82 81)`);
      plumes.forEach((el,i)=>{
        const k=i%5, back=i<5, base=p((back?24:34)+k*5,(back?-84:-90)+k*2),pts=ribbon(t,base,mix(back?140:158,back?176:186,k/4)-pose.lift*14,mix(back?54:36,back?36:24,k/4),5,9,160+i*30,i*1.3);
        el.setAttribute('d',ribbonPath(pts,mix(back?7:5.5,back?5:4,k/4),.6));
      });
      hackles.forEach((el,i)=>{
        const front=i>=5, k=front?(i-5)/5:i/4, root=front?p(mix(52,30,k),mix(-78,-40,k)):p(mix(44,20,k),mix(-82,-46,k));
        const d=mix(front?218:206,front?246:238,k)-pose.lift*10+Math.sin(t/140+i)*3+flap(t-120-i*15)*3*pose.lift;
        el.setAttribute('d',flameFeather(root,unit(d),(front?34:46)*mix(1,.8,k),front?6:7.5,.35));
      });
      blues.forEach((el,i)=>{
        const pts=ribbon(t,p(74,-78+i*4),i?196:186,i?118:150,8,10,220,i*2+.5);
        el.setAttribute('d',ribbonPath(pts,2.2,.4));
      });
      const spread=mix(14,22,pose.lift);
      tailBack.forEach((el,i)=>{
        const d=196+(i-3)*spread*.55-flap(t-190-i*30)*5;
        el.setAttribute('d',flameFeather(p(i*2-8,i*2-6),unit(d),mix(92,126,1-Math.abs(i-3)/3),12,.5+Math.sin(t/110+i)*.15));
      });
      tailFeathers.forEach((el,i)=>{
        const d=196+(i-2)*spread*.6-flap(t-150-i*30)*4;
        el.setAttribute('d',flameFeather(p(i*3-4,i*2-3),unit(d),mix(70,104,1-Math.abs(i-2)/2),11,.4+Math.sin(t/100+i)*.15));
      });
      tailCoverts.forEach((el,i)=>{
        const d=198+(i-2.5)*spread*.5-flap(t-120-i*20)*3;
        el.setAttribute('d',flameFeather(p(i*3+4,i*2-2),unit(d),mix(34,46,1-Math.abs(i-2.5)/2.5),8,.3));
      });
      tails.forEach((c,k)=>{
        const pts=ribbon(t,p(-74,26),c.a+pose.air*14,c.len,14,34,620,c.ph);
        c.band.setAttribute('d',ribbonPath(pts,c.w,1.4));
        c.core.setAttribute('d',smooth(pts.slice(0,-1)));
        const end=pts[pts.length-1],pulse=1+Math.sin(t/70+k*2)*.12;
        c.ball.setAttribute('cx',end.x.toFixed(2));c.ball.setAttribute('cy',end.y.toFixed(2));c.ball.setAttribute('r',(13*pulse).toFixed(2));
        const prev=pts[pts.length-2],dx=end.x-prev.x,dy=end.y-prev.y,dl=Math.hypot(dx,dy)||1;
        c.lick.setAttribute('d',flameFeather(end,p(-dx/dl,-dy/dl),26*pulse,9,.8));
      });
      feet.forEach(({hip,i,leg,toes,perch})=>{
        const release=Math.max(ease(LAUNCH+40+i*30,LAUNCH+520+i*40,t),1-ease(-320+i*30,-40,t)); // 飞入时收爪，落枝前探爪
        const planted=toLocal(pose,perch), tucked=add(hip,-22-i*3,24+i*2);
        const foot=lerp(planted,tucked,release), knee=add(lerp(hip,foot,.5),9-release*4,-3+release*6);
        leg.setAttribute('d',`M${xy(hip)}Q${xy(knee)} ${xy(foot)}`);
        const g=1-release*.7, sp=mix(1,.45,release);
        toes.setAttribute('d',`M${xy(foot)}l${(12*sp).toFixed(2)},${(3*g+2).toFixed(2)}M${xy(foot)}l${(4*sp).toFixed(2)},${(9*g+1).toFixed(2)}M${xy(foot)}l${(-9*sp).toFixed(2)},${(4*g+2).toFixed(2)}`);
      });
      embers.forEach(({el,i,trail})=>{
        const period=trail?1300:2600, offset=hash(i)*period, age=((t+offset)%period)/period;
        let x,y,r,o;
        if(trail){
          const born=t-age*period;
          if(born<50-ENTER||(born>-150&&born<LAUNCH+150)){el.setAttribute('r',0);return;} // 栖枝时不拖火尾
          const src=toScene(poseAt(born),p(-70-hash(i+9)*40,20+hash(i+5)*30));
          x=src.x-age*(30+hash(i+3)*50); y=src.y+age*(60+hash(i+7)*70); r=(1.2+hash(i+1)*2.8)*(1-age); o=1-age;
        } else {
          x=60+hash(i+2)*560+Math.sin(t/400+i)*10; y=470-age*(240+hash(i+4)*120); r=(1+hash(i+6)*2.2)*Math.sin(Math.PI*age); o=.85*Math.sin(Math.PI*age);
        }
        el.setAttribute('cx',x.toFixed(2));el.setAttribute('cy',y.toFixed(2));el.setAttribute('r',Math.max(0,r).toFixed(2));el.setAttribute('opacity',o.toFixed(2));
      });
      cords.forEach(c=>{
        const pts=ribbon(t,c.b,c.a+pose.air*12,c.len,14,40,700,c.ph);
        c.line.setAttribute('d',smooth(pts));
        c.beads.forEach((el,k)=>{const q=pts[[4,8,12][k]];el.setAttribute('cx',q.x.toFixed(2));el.setAttribute('cy',q.y.toFixed(2));});
      });
      shadow.setAttribute('rx',(56-pose.lift*20-pose.air*30).toFixed(2));shadow.setAttribute('opacity',((.45-pose.lift*.15-pose.air*.28)*(1-pose.fly)).toFixed(2));
      scene.dataset.motionTime=String(Math.round(T));
    };
  }
  async function sceneTemplate(container) {
    if(template)return template;
    const embedded=container.querySelector('#jinwuMotionScene:not([data-rigged])');
    if(embedded){template=embedded.cloneNode(true);return template;}
    if(!loading)loading=(async()=>{
      const response=await fetch('/static/jinwu-scene.svg');if(!response.ok)throw new Error('金乌入场场景加载失败');
      const svg=new DOMParser().parseFromString(await response.text(),'image/svg+xml').documentElement;
      if(svg.localName!=='svg'||svg.querySelector('parsererror'))throw new Error('金乌入场场景格式错误');
      template=svg;return svg;
    })();
    try{return await loading;}finally{loading=null;}
  }
  function cancelFrames(){if(active){cancelAnimationFrame(active.frame);active.frame=0;}}
  function stop(){generation++;cancelFrames();if(active)for(const animation of active.scene.getAnimations({subtree:true}))animation.pause();}
  function seek(ms){if(!active)return false;cancelFrames();active.draw(Math.max(0,Math.min(duration,ms)));return true;}
  async function mount(container){
    if(!container)return null;
    cancelFrames();const version=++generation;await sceneTemplate(container);if(version!==generation)return null;
    const scene=document.importNode(template,true);scene.style.cssText='width:100%;height:100%;display:block';scene.setAttribute('focusable','false');container.replaceChildren(scene);
    const draw=rig(scene);active={container,scene,draw,frame:0};
    if(reduced.matches){draw(duration);return scene;}
    draw(0);const start=performance.now();
    const animate=now=>{
      if(version!==generation||!scene.isConnected)return;
      const t=Math.min(duration,now-start);draw(t);
      if(t<duration)active.frame=requestAnimationFrame(animate);else active.frame=0;
    };
    active.frame=requestAnimationFrame(animate);return scene;
  }
  reduced.addEventListener('change',()=>{if(reduced.matches)seek(duration);});
  window.xiheJinwuMotion={mount,replay:()=>active?mount(active.container):Promise.resolve(null),stop,seek,duration};
})();
