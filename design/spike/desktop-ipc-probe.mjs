// Read-only by default. --send-test only writes to the explicitly named READY test.
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import fs from 'node:fs';
const socket=net.connect('\\\\.\\pipe\\codex-ipc');
let clientId='initializing-client',buf=Buffer.alloc(0);
const pending=new Map();
let snapshot;
function send(m){const data=Buffer.from(JSON.stringify(m));const h=Buffer.alloc(4);h.writeUInt32LE(data.length);socket.write(Buffer.concat([h,data]));}
function call(method,params,version=0,targetClientId){const requestId=randomUUID();return new Promise((resolve,reject)=>{pending.set(requestId,resolve);send({type:'request',requestId,sourceClientId:clientId,version,method,params,targetClientId,timeoutMs:4000});setTimeout(()=>{if(pending.delete(requestId))reject(new Error('timeout '+method));},6000).unref();});}
socket.on('data',d=>{buf=Buffer.concat([buf,d]);while(buf.length>=4&&buf.length>=4+buf.readUInt32LE(0)){const len=buf.readUInt32LE(0),m=JSON.parse(buf.subarray(4,4+len));buf=buf.subarray(4+len);if(m.type==='response'){pending.get(m.requestId)?.(m);pending.delete(m.requestId);}else if(m.type==='client-discovery-request')send({type:'client-discovery-response',requestId:m.requestId,response:{canHandle:false}});else if(m.type==='broadcast'){console.log('BROADCAST',m.method,m.params?.conversationId??'',m.params?.change?.type??'');if(m.params?.conversationId===process.argv[2]&&m.params?.change?.type==='snapshot'){snapshot=m.params.change.conversationState;if(process.argv.includes('--save-test-snapshot'))fs.writeFileSync('design/spike/scratch/ipc-test-snapshot.json',JSON.stringify(snapshot,null,2));}}}});
try{
await new Promise((r,j)=>{socket.once('connect',r);socket.once('error',j);});
const init=await call('initialize',{clientType:'agentlink-probe'});console.log('INIT',JSON.stringify(init));clientId=init.result?.clientId;
if(clientId&&process.argv[2]){
const conversationId=process.argv[2];const owner=await call('thread-owner-discovery',{hostId:'local',conversationId},1);console.log('OWNER',JSON.stringify(owner));
if(owner.resultType==='success'){
send({type:'broadcast',sourceClientId:clientId,targetClientIds:[owner.handledByClientId],method:'thread-stream-following-changed',version:1,params:{hostId:'local',conversationId,following:true}});
await delay(4000);
if(process.argv.includes('--send-test')||process.argv.includes('--approval-test')||process.argv.includes('--interrupt-test')){
if(snapshot?.title!=='回复 READY')throw new Error('Not the authorized READY test thread');
const entities=Object.values(snapshot.turnHistory?.history?.entitiesByKey??{});
const previous=entities[0]?.params;
if(!previous)throw new Error('Missing test turn params');
const request={...previous,input:[{type:'text',text:'AgentLink 原会话接管验证：这是外部客户端通过桌面 IPC 发来的指令。不要使用任何工具或修改文件。请只回复 AGENTLINK_DESKTOP_TAKEOVER_OK。',text_elements:[]}],clientUserMessageId:randomUUID()};
delete request.additionalContext;
const approvalTest=process.argv.includes('--approval-test');
const interruptTest=process.argv.includes('--interrupt-test');
if(approvalTest){request.input=[{type:'text',text:'AgentLink 审批验证：请调用 shell 执行 cmd /c echo AGENTLINK_DESKTOP_APPROVAL_OK，不要修改任何文件。如需审批请发起审批。',text_elements:[]}];request.approvalPolicy='untrusted';request.permissions=':read-only';request.sandboxPolicy={type:'readOnly'};}
if(interruptTest)request.input=[{type:'text',text:'AgentLink 中断测试：不要调用工具，不要修改文件。请用长篇文字解释从一数到一百的过程，测试客户端会中断本次回答。',text_elements:[]}];
const started=await call('thread-follower-start-turn',{conversationId,turnStart:{request,context:{inheritThreadSettings:false}}},2,owner.handledByClientId);
console.log('SEND_RESULT',JSON.stringify(started));
if(interruptTest){await delay(1000);console.log('INTERRUPT_RESULT',JSON.stringify(await call('thread-follower-interrupt-turn',{conversationId,mode:'user-stop',expectedTurnId:started.result?.result?.turn?.id},4,owner.handledByClientId)));}
if(approvalTest){
for(let n=0;n<40;n++){
send({type:'broadcast',sourceClientId:clientId,targetClientIds:[owner.handledByClientId],method:'thread-stream-following-changed',version:1,params:{hostId:'local',conversationId,following:true}});
await delay(1000);
const req=snapshot?.requests?.find(r=>JSON.stringify(r).includes('requestApproval'));
if(req){console.log('APPROVAL_REQUEST',JSON.stringify(req));console.log('APPROVAL_RESULT',JSON.stringify(await call('thread-follower-command-approval-decision',{conversationId,requestId:req.id,decision:'accept'},1,owner.handledByClientId)));break;}
}
}
await delay(15000);
send({type:'broadcast',sourceClientId:clientId,targetClientIds:[owner.handledByClientId],method:'thread-stream-following-changed',version:1,params:{hostId:'local',conversationId,following:true}});
await delay(2000);
console.log('TEST_RESULT',JSON.stringify({id:snapshot?.id,forkedFromId:snapshot?.forkedFromId,approvalPolicy:snapshot?.latestThreadSettings?.approvalPolicy,turns:Object.values(snapshot?.turnHistory?.history?.entitiesByKey??{}).map(t=>({id:t.turnId,status:t.status,items:t.items?.filter(i=>i.type==='agentMessage'||i.type==='commandExecution').map(i=>({type:i.type,text:i.text,status:i.status,output:i.aggregatedOutput}))}))}));
}
send({type:'broadcast',sourceClientId:clientId,targetClientIds:[owner.handledByClientId],method:'thread-stream-following-changed',version:1,params:{hostId:'local',conversationId,following:false}});
}}
}catch(e){console.error(e.message);process.exitCode=1;}finally{socket.destroy();}
