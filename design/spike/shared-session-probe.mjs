// Run with Windows Node and the desktop codex.exe path as argv[2].
// Only creates and controls its own test thread. Never forks or resumes user threads.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const endpoint=`ws://127.0.0.1:${process.argv[3]??14880}`;
const proc = spawn(process.argv[2], ['app-server', '--listen', endpoint], {stdio:['ignore','pipe','pipe']});
proc.on('exit',(code)=>console.log('SERVER_EXIT',code));
proc.on('error',e=>console.error('SERVER_ERROR',e.message));
let stderr = '';
proc.stderr.on('data', d => { stderr += d; });
const clients = [];
async function connect(label) {
  const ws = new WebSocket(endpoint);
  await new Promise((resolve,reject) => { const timer=setTimeout(()=>reject(new Error('connect timeout')),5000); ws.onopen=()=>{clearTimeout(timer);resolve();}; ws.onerror=()=>{clearTimeout(timer);reject(new Error('connect failed'));}; });
  let id=0; const pending=new Map(); const events=[];
  ws.onmessage = e => {
    const m=JSON.parse(e.data);
    if (m.method) { events.push(m); if(m.id !== undefined) console.log(label,'REQUEST',m.method); }
    else if(pending.has(m.id)) { const p=pending.get(m.id); pending.delete(m.id); m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result); }
  };
  const call=(method,params={})=>new Promise((resolve,reject)=>{
    const n=++id; pending.set(n,{resolve,reject}); ws.send(JSON.stringify({id:n,method,params}));
    setTimeout(()=>{if(pending.delete(n))reject(new Error('timeout '+method));},20000).unref();
  });
  const c={ws,call,events}; clients.push(c);
  await call('initialize',{clientInfo:{name:'agentlink_probe_'+label,version:'0.1.0'},capabilities:{experimentalApi:true}});
  ws.send(JSON.stringify({method:'initialized'})); return c;
}
try {
  await delay(2000);
  const a=await connect('desktop_simulated'), b=await connect('phone_simulated');
  const t=await a.call('thread/start',{cwd:'F:/project/AgentLink/design/spike/scratch',approvalPolicy:'untrusted',sandbox:'read-only'});
  const threadId=t.thread.id;
  console.log('CREATED',threadId);
  await a.call('turn/start',{threadId,input:[{type:'text',text:'Connectivity probe. Do not use tools. Reply exactly FIRST_OK.'}]});
  await delay(1500);
  const r=await b.call('thread/resume',{threadId});
  console.log('SAME_THREAD',r.thread.id===threadId);
  const turn=await b.call('turn/start',{threadId,input:[{type:'text',text:'This is a connectivity probe. Do not use any tools. Reply exactly AGENTLINK_SHARED_OK.'}]});
  console.log('PHONE_STARTED',turn.turn.id);
  for(let n=0;n<45;n++){if(b.events.some(e=>e.method==='turn/completed'))break;await delay(1000);}
  for(const [label,c] of [['desktop',a],['phone',b]]) console.log(label,JSON.stringify(c.events.filter(e=>e.params?.threadId===threadId).map(e=>({method:e.method,turnId:e.params.turnId,status:e.params.turn?.status,text:e.params.item?.text,delta:e.params.delta,error:e.params.error}))));
  if(!b.events.some(e=>e.method==='turn/completed')) await b.call('turn/interrupt',{threadId,turnId:turn.turn.id});
  a.events.length=0;b.events.length=0;
  const approvalTurn=await a.call('turn/start',{threadId,input:[{type:'text',text:'Connectivity approval probe: use the shell tool to run exactly cmd /c echo AGENTLINK_APPROVAL_OK. Do not modify files. If approval is needed request it.'}]});
  for(let n=0;n<40;n++){
    const request=b.events.find(e=>e.id!==undefined && /requestApproval/.test(e.method));
    if(request){
      console.log('PHONE_APPROVAL_REQUEST',request.method,'DESKTOP_ALSO',a.events.some(e=>e.method===request.method));
      b.ws.send(JSON.stringify({id:request.id,result:{decision:'accept'}}));
      console.log('PHONE_APPROVAL_ACCEPTED_SENT');break;
    }
    if(b.events.some(e=>e.method==='turn/completed'))break;
    await delay(1000);
  }
  await delay(3000);
  console.log('APPROVAL_EVENTS',JSON.stringify(b.events.filter(e=>/resolved|completed|Approval/.test(e.method)).map(e=>({method:e.method,type:e.params?.item?.type,status:e.params?.item?.status,output:e.params?.item?.aggregatedOutput}))));
  if(!b.events.some(e=>e.method==='turn/completed'))await b.call('turn/interrupt',{threadId,turnId:approvalTurn.turn.id});
  for(let n=0;n<20&&!b.events.some(e=>e.method==='turn/completed');n++)await delay(250);
  a.events.length=0;b.events.length=0;
  const last=await a.call('turn/start',{threadId,input:[{type:'text',text:'Do not use tools. Explain counting from one to one hundred in detail.'}]});
  await delay(750);
  await b.call('turn/interrupt',{threadId,turnId:last.turn.id});await delay(1000);
  console.log('PHONE_INTERRUPT',JSON.stringify([a,b].map(c=>c.events.filter(e=>e.method==='turn/completed').map(e=>e.params.turn.status))));
} catch(e) {console.error('PROBE_FAILED',e.message);console.error(stderr.slice(-1500));process.exitCode=1;}
finally {for(const c of clients)c.ws.close();proc.kill();setTimeout(()=>process.exit(process.exitCode??0),500);}
