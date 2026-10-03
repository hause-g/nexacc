/* Ônix Orbit: isolated, decorative renderer. No API, financial state or demo controls. */
(()=>{'use strict';
const canvas=document.getElementById('oxOrbit'),scene=document.getElementById('oxScene');
const tab=document.getElementById('aba-aovivo'),button=document.getElementById('oxMotion');
const focusButton=document.getElementById('oxFocus'),note=document.getElementById('oxMotionNote');
const fallback=document.getElementById('oxFallback');
if(!canvas||!scene||!tab||!button||!focusButton||!note||!fallback)return;
const artwork=document.getElementById('agentumArtwork'),artImage=document.getElementById('agentumArtImage');
const preference=window.matchMedia('(prefers-reduced-motion: reduce)'),key='orion.onix.motion.v1';
let explicit=null;try{const s=localStorage.getItem(key);if(s==='on'||s==='off')explicit=s==='on';}catch{}
let enabled=explicit===null?!preference.matches:explicit,focus=false,raf=0,prev=0,lastFrame=0;
let time=0,mx=0,my=0,tx=0,ty=0,dirty=true,visible=true,render;
function active(){return !document.hidden&&tab.classList.contains('ativa')&&visible;}
function playing(){return enabled&&!focus;}
function syncControls(){
  const play=playing();button.textContent=play?'Ⅱ':'▶';button.setAttribute('aria-pressed',String(play));
  const label=artwork?(play?'Pausar movimento da arte':'Ativar movimento da arte'):(play?'Pausar animação dos anéis':'Ativar animação dos anéis');button.setAttribute('aria-label',label);button.title=label;
  focusButton.setAttribute('aria-pressed',String(focus));note.textContent=play?'NEXACC · 3D':'NEXACC · PAUSADO';
  scene.dataset.motion=play?'on':'off';
}
function stop(){if(raf)cancelAnimationFrame(raf);raf=0;prev=0;}
function wake(){dirty=true;if(!active()){stop();return;}if(!raf)raf=requestAnimationFrame(frame);}
function frame(now){
  raf=0;if(!active()){prev=0;return;}
  if(playing()&&now-lastFrame<33){raf=requestAnimationFrame(frame);return;}
  const dt=Math.min((now-(prev||now))/1000,.08);prev=now;lastFrame=now;
  if(playing()){time+=dt;mx+=(tx-mx)*.1;my+=(ty-my)*.1;dirty=true;}
  if(dirty){dirty=false;render(time,mx,my);}
  if(playing())raf=requestAnimationFrame(frame);else prev=0;
}
function useFallback(){
  canvas.hidden=true;fallback.hidden=false;scene.dataset.renderer='css';
  const rings=fallback.querySelectorAll('i');
  render=(t)=>{rings[0].style.transform=`rotateX(56deg) rotateY(${32+t*15}deg)`;rings[1].style.transform=`rotateX(${-20+t*9}deg) rotateY(66deg)`;rings[2].style.transform=`rotateX(72deg) rotateZ(${t*8}deg)`;};
}
function setupArtwork(){
  canvas.hidden=true;fallback.hidden=true;scene.dataset.renderer='artwork';
  render=(t,x,y)=>{artwork.style.transform=`translate3d(${x*9}px,${Math.sin(t*.45)*3+y*9}px,0) rotate(${Math.sin(t*.23)*.45}deg)`;};
  if(artImage)artImage.addEventListener('error',()=>{artwork.style.display='none';useFallback();wake();},{once:true});
}
function setupWebGL(){
const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false});
if(!gl)throw Error('WebGL unavailable');
const vert='attribute vec3 p;attribute vec3 n;uniform mat4 model;uniform mat4 vp;varying vec3 N;varying vec3 W;void main(){vec4 w=model*vec4(p,1.);W=w.xyz;N=normalize(mat3(model)*n);gl_Position=vp*w;}';
const frag='precision mediump float;varying vec3 N;varying vec3 W;uniform vec3 base;uniform vec3 eye;uniform float metal;void main(){vec3 nn=normalize(N);vec3 V=normalize(eye-W);vec3 L=normalize(vec3(-2.5,4.0,5.0)-W);vec3 L2=normalize(vec3(3.0,1.0,-2.0)-W);float d=max(dot(nn,L),0.);float sp=pow(max(dot(nn,normalize(L+V)),0.),80.);float sp2=pow(max(dot(nn,normalize(L2+V)),0.),45.);float rim=pow(1.-max(dot(nn,V),0.),3.);vec3 R=reflect(-V,nn);float stripe=pow(max(0.,sin(R.y*5.0+R.x*2.0)),14.);vec3 c=base*(.16+.62*d+.18*max(dot(nn,L2),0.));c+=vec3(1.,.79,.44)*stripe*metal*.7;c+=vec3(1.,.94,.77)*sp*1.4;c+=vec3(1.,.59,.22)*sp2*.6;c+=base*rim*.7;gl_FragColor=vec4(c,1.);}';
function shader(type,src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,vert));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,frag));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('WebGL link');gl.useProgram(program);
const loc={p:gl.getAttribLocation(program,'p'),n:gl.getAttribLocation(program,'n'),model:gl.getUniformLocation(program,'model'),vp:gl.getUniformLocation(program,'vp'),base:gl.getUniformLocation(program,'base'),eye:gl.getUniformLocation(program,'eye'),metal:gl.getUniformLocation(program,'metal')};
const I=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function mul(a,b){const o=new Array(16).fill(0);for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)o[c*4+r]+=a[k*4+r]*b[c*4+k];return o;}
function rx(t){const a=I(),c=Math.cos(t),s=Math.sin(t);a[5]=c;a[6]=s;a[9]=-s;a[10]=c;return a;}
function ry(t){const a=I(),c=Math.cos(t),s=Math.sin(t);a[0]=c;a[2]=-s;a[8]=s;a[10]=c;return a;}
function rz(t){const a=I(),c=Math.cos(t),s=Math.sin(t);a[0]=c;a[1]=s;a[4]=-s;a[5]=c;return a;}
function trans(x,y,z){const a=I();a[12]=x;a[13]=y;a[14]=z;return a;}
function scale(x,y,z){const a=I();a[0]=x;a[5]=y;a[10]=z;return a;}
function norm(a){const l=Math.hypot(...a)||1;return a.map(x=>x/l);}function sub(a,b){return a.map((v,i)=>v-b[i]);}function cross(a,b){return[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}function dot(a,b){return a.reduce((s,v,i)=>s+v*b[i],0);}
const eye=[0,1.4,6.6],target=[0,-.12,0];function view(){const z=norm(sub(eye,target)),x=norm(cross([0,1,0],z)),y=cross(z,x);return[x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1];}
function proj(aspect){const f=1/Math.tan(.64/2),near=.1,far=30;return[f/aspect,0,0,0,0,f,0,0,0,0,(far+near)/(near-far),-1,0,0,2*far*near/(near-far),0];}
function mesh(data){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);return {buffer:b,count:data.length/6};}
function torus(R,r,uN=130,vN=14){const data=[];function v(u,vv){const a=u/uN*Math.PI*2,b=vv/vN*Math.PI*2,c=Math.cos(b),s=Math.sin(b),ca=Math.cos(a),sa=Math.sin(a);return [(R+r*c)*ca,r*s,(R+r*c)*sa,c*ca,s,c*sa];}for(let u=0;u<uN;u++)for(let v0=0;v0<vN;v0++){const a=v(u,v0),b=v(u+1,v0),c=v(u+1,v0+1),d=v(u,v0+1);data.push(...a,...b,...c,...a,...c,...d);}return mesh(data);}
function ico(){const t=(1+Math.sqrt(5))/2,v=[[-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],[0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],[t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]].map(norm),faces=[[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]],data=[];faces.forEach(f=>{const [a,b,c]=f.map(i=>v[i]),n=norm(cross(sub(b,a),sub(c,a)));for(const p of [a,b,c])data.push(...p,...n);});return mesh(data);}
const ring=torus(1.38,.068),thin=torus(1.7,.012),baseRing=torus(1.5,.018),core=ico();
gl.enable(gl.DEPTH_TEST);gl.clearColor(0,0,0,0);gl.uniform3fv(loc.eye,eye);
function draw(m,mat,color,metal){gl.bindBuffer(gl.ARRAY_BUFFER,m.buffer);gl.enableVertexAttribArray(loc.p);gl.enableVertexAttribArray(loc.n);gl.vertexAttribPointer(loc.p,3,gl.FLOAT,false,24,0);gl.vertexAttribPointer(loc.n,3,gl.FLOAT,false,24,12);gl.uniformMatrix4fv(loc.model,false,new Float32Array(mat));gl.uniform3fv(loc.base,color);gl.uniform1f(loc.metal,metal);gl.drawArrays(gl.TRIANGLES,0,m.count);}

render=(time,mx,my)=>{
const rect=scene.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,1.6);
const w=Math.max(1,Math.round(rect.width*dpr)),h=Math.max(1,Math.round(rect.height*dpr));
if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
gl.viewport(0,0,w,h);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
gl.uniformMatrix4fv(loc.vp,false,new Float32Array(mul(proj(w/h),view())));
const group=mul(trans(.10,.02+Math.sin(time*.5)*.045,0),mul(ry(mx+time*.24),rx(my)));
const gold=[.76,.47,.17],lightGold=[.95,.67,.29];
draw(baseRing,mul(trans(.1,-1.28,0),scale(1.15,1,1.15)),[.48,.30,.12],1);
draw(baseRing,mul(trans(.1,-1.30,0),scale(1.35,1,1.35)),[.30,.20,.09],1);
draw(ring,mul(group,mul(rz(.8),rx(.42+time*.06))),lightGold,1);
draw(ring,mul(group,mul(rz(-.73),rx(1.08))),gold,1);
draw(ring,mul(group,mul(rx(.15),ry(time*.18))),lightGold,1);
draw(thin,mul(group,mul(rz(.14),rx(.22))),[.55,.35,.14],1);
draw(core,mul(group,mul(ry(-time*.28),scale(.61,.61,.61))),[.095,.12,.13],.7);
draw(core,mul(group,mul(trans(1.38,0,0),scale(.085,.085,.085))),lightGold,1);
};
canvas.hidden=false;fallback.hidden=true;scene.dataset.renderer='webgl';
}
try{if(artwork)setupArtwork();else setupWebGL();}catch{useFallback();}
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();useFallback();wake();});
canvas.addEventListener('webglcontextrestored',()=>{try{if(artwork)setupArtwork();else setupWebGL();}catch{useFallback();}wake();});
button.addEventListener('click',()=>{enabled=!playing();focus=false;explicit=enabled;try{localStorage.setItem(key,enabled?'on':'off');}catch{}syncControls();wake();});
focusButton.addEventListener('click',()=>{focus=!focus;syncControls();wake();});
preference.addEventListener('change',()=>{if(explicit===null){enabled=!preference.matches;syncControls();wake();}});
scene.addEventListener('pointermove',e=>{if(!playing()||e.pointerType==='touch')return;const r=scene.getBoundingClientRect();tx=((e.clientX-r.left)/r.width-.5)*.4;ty=((e.clientY-r.top)/r.height-.5)*.25;});
scene.addEventListener('pointerleave',()=>{tx=ty=0;});
new MutationObserver(wake).observe(tab,{attributes:true,attributeFilter:['class']});
new ResizeObserver(wake).observe(scene);
new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;wake();},{threshold:0}).observe(scene);
document.addEventListener('visibilitychange',wake);
window.addEventListener('pagehide',stop);
window.addEventListener('pageshow',wake);
syncControls();wake();
})();
