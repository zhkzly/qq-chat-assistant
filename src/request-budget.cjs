'use strict';
const {randomUUID}=require('node:crypto');

function scopedKey(scope) {
  const fields=['accountUid','accountUin','peerUid','peerUin'];
  if(!scope||fields.some(key=>typeof scope[key]!=='string'||!scope[key]))throw new Error('Invalid task scope');
  return JSON.stringify(fields.map(key=>scope[key]));
}
function fail(code,message){const error=new Error(message);error.code=code;return error;}
function count(value){return Number.isSafeInteger(value)&&value>=0?value:null;}

class TaskLedger {
  constructor(store) {
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS assistant_tasks(
      id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,input_digest TEXT,origin TEXT NOT NULL,
      request_limit INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error_code TEXT);
      CREATE INDEX IF NOT EXISTS assistant_tasks_scope ON assistant_tasks(scope_key,created_at);
      CREATE TABLE IF NOT EXISTS model_requests(
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL,sequence INTEGER NOT NULL,stage_id TEXT NOT NULL,
      purpose TEXT NOT NULL,input_bytes INTEGER NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,
      elapsed_ms INTEGER,http_status INTEGER,error_code TEXT,prompt_tokens INTEGER,
      completion_tokens INTEGER,total_tokens INTEGER,cached_tokens INTEGER,
      UNIQUE(task_id,sequence));`);
  }
  _row(scope,id) {
    const row=this.db.prepare('SELECT * FROM assistant_tasks WHERE id=?').get(id);
    if(!row||row.scope_key!==scopedKey(scope))throw fail('task_scope_mismatch','任务不存在或会话已改变 (scope mismatch)');
    return row;
  }
  create(scope,{id=randomUUID(),inputDigest,origin='user',limit=4}={}) {
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw fail('invalid_task_id','任务标识不正确');
    if(typeof inputDigest!=='string'||inputDigest.length>256)throw new Error('Task input fingerprint is required');
    const requestLimit=Math.max(1,Math.min(12,Number.isSafeInteger(limit)?limit:4));
    const existing=this.db.prepare('SELECT * FROM assistant_tasks WHERE id=?').get(id);
    if(existing){
      this._row(scope,id);
      if(existing.input_digest!==inputDigest)throw fail('idempotency_conflict','同一任务标识包含不同内容 (different input)');
      return new TaskBudget(this,scope,id,true);
    }
    const now=new Date().toISOString();
    this.db.prepare('INSERT INTO assistant_tasks(id,scope_key,input_digest,origin,request_limit,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,scopedKey(scope),inputDigest,origin,requestLimit,'running',now,now);
    return new TaskBudget(this,scope,id,false);
  }
  resume(scope,id) {
    const row=this._row(scope,id);
    if(['complete','cancelled'].includes(row.status))throw fail('task_finished','任务已经完成 (finished)');
    this.db.prepare("UPDATE assistant_tasks SET status='running',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
    return new TaskBudget(this,scope,id,true);
  }
  finish(scope,id,status,errorCode=null) {
    this._row(scope,id);
    if(!['complete','failed','cancelled','interrupted'].includes(status))throw new Error('Invalid task status');
    this.db.prepare('UPDATE assistant_tasks SET status=?,error_code=?,updated_at=? WHERE id=?')
      .run(status,errorCode&&/^[a-z0-9_]{1,100}$/.test(errorCode)?errorCode:null,new Date().toISOString(),id);
  }
  recoverInterrupted() {
    this.db.prepare("UPDATE assistant_tasks SET status='interrupted',error_code='process_interrupted',updated_at=? WHERE status='running'").run(new Date().toISOString());
  }
  redactInputs(scope) {
    this.db.prepare('UPDATE assistant_tasks SET input_digest=NULL WHERE scope_key=?').run(scopedKey(scope));
  }
  get(scope,id) {
    const row=this._row(scope,id);
    const requests=this.db.prepare('SELECT * FROM model_requests WHERE task_id=? ORDER BY sequence').all(id).map(r=>({
      id:r.id,sequence:r.sequence,stageId:r.stage_id,purpose:r.purpose,inputBytes:r.input_bytes,
      startedAt:r.started_at,finishedAt:r.finished_at,elapsedMs:r.elapsed_ms,httpStatus:r.http_status,errorCode:r.error_code,
      usage:{promptTokens:r.prompt_tokens,completionTokens:r.completion_tokens,totalTokens:r.total_tokens,cachedTokens:r.cached_tokens}
    }));
    const sum=field=>{const values=requests.map(r=>r.usage[field]).filter(v=>v!==null);return values.length?values.reduce((a,b)=>a+b,0):null;};
    return {taskId:id,origin:row.origin,status:row.status,limit:row.request_limit,attempts:row.attempts,
      remaining:Math.max(0,row.request_limit-row.attempts),createdAt:row.created_at,updatedAt:row.updated_at,errorCode:row.error_code,
      usage:{promptTokens:sum('promptTokens'),completionTokens:sum('completionTokens'),totalTokens:sum('totalTokens'),
        cachedTokens:sum('cachedTokens'),reportedAttempts:requests.filter(r=>r.usage.totalTokens!==null).length,
        unreportedAttempts:requests.filter(r=>r.usage.totalTokens===null).length},requests};
  }
  maintenanceWindow(scope,now=Date.now(),windowMs=600000) {
    const rows=this.db.prepare("SELECT r.started_at FROM model_requests r JOIN assistant_tasks t ON t.id=r.task_id WHERE t.scope_key=? AND t.origin='maintenance' AND r.started_at>=? ORDER BY r.started_at")
      .all(scopedKey(scope),new Date(now-windowMs).toISOString());
    return {requestsInWindow:rows.length,windowUntil:rows.length?Date.parse(rows[0].started_at)+windowMs:now};
  }
  recent(scope,limit=8) {
    return this.db.prepare('SELECT id FROM assistant_tasks WHERE scope_key=? ORDER BY created_at DESC LIMIT ?').all(scopedKey(scope),Math.max(1,Math.min(30,limit))).map(row=>this.get(scope,row.id));
  }
}
class TaskBudget {
  constructor(ledger,scope,id,reused){this.ledger=ledger;this.scope={...scope};this.id=id;this.reused=reused;}
  forStage(purpose){return new StageBudget(this,purpose);}
  snapshot(){return this.ledger.get(this.scope,this.id);}
}
class StageBudget {
  constructor(task,purpose){this.task=task;this.purpose=String(purpose||'unknown').replace(/[^a-z0-9_-]/gi,'_').slice(0,60);this.stageId=randomUUID();this.lastAttempt=null;}
  forStage(purpose){return this.task.forStage(purpose);}
  reserveAttempt({inputBytes=0}={}) {
    const {ledger,scope,id}=this.task;
    return ledger.store._atomic(()=>{
      const row=ledger._row(scope,id);
      if(row.status!=='running')throw fail('task_finished','任务已经完成或停止 (finished)');
      if(row.attempts>=row.request_limit)throw fail('request_budget_exhausted',`这次请求已达到 ${row.request_limit} 次模型调用上限，输入与已取得的资料已保留。`);
      const now=new Date().toISOString(),attemptId=randomUUID();
      ledger.db.prepare('UPDATE assistant_tasks SET attempts=attempts+1,updated_at=? WHERE id=?').run(now,id);
      ledger.db.prepare('INSERT INTO model_requests(id,task_id,sequence,stage_id,purpose,input_bytes,started_at) VALUES(?,?,?,?,?,?,?)')
        .run(attemptId,id,row.attempts+1,this.stageId,this.purpose,Math.max(0,Math.trunc(Number(inputBytes)||0)),now);
      this.lastAttempt=attemptId;return attemptId;
    });
  }
  finishAttempt(id,{status=null,errorCode=null}={}) {
    const {ledger}=this.task;
    const row=ledger.db.prepare('SELECT started_at FROM model_requests WHERE id=? AND task_id=?').get(id,this.task.id);
    if(!row)return;
    const safeCode=errorCode&&/^[a-z0-9_]{1,100}$/.test(errorCode)?errorCode:null;
    ledger.db.prepare('UPDATE model_requests SET finished_at=?,elapsed_ms=?,http_status=COALESCE(?,http_status),error_code=? WHERE id=? AND task_id=?')
      .run(new Date().toISOString(),Math.max(0,Date.now()-Date.parse(row.started_at)),Number.isInteger(status)?status:null,safeCode,id,this.task.id);
  }
  recordUsage(usage) {
    if(!this.lastAttempt||!usage||typeof usage!=='object')return;
    const input=count(usage.prompt_tokens??usage.input_tokens),output=count(usage.completion_tokens??usage.output_tokens);
    const total=count(usage.total_tokens)??(input!==null&&output!==null?input+output:null);
    const cached=count(usage.prompt_tokens_details?.cached_tokens??usage.input_tokens_details?.cached_tokens);
    this.task.ledger.db.prepare('UPDATE model_requests SET prompt_tokens=?,completion_tokens=?,total_tokens=?,cached_tokens=? WHERE id=? AND task_id=?')
      .run(input,output,total,cached,this.lastAttempt,this.task.id);
  }
}
module.exports={TaskLedger,TaskBudget,StageBudget};
