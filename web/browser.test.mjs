import test from 'node:test';
import assert from 'node:assert/strict';
import { agentAllowed, allowedFile, redactTree, activity, validateReport } from './common.mjs';
test('Evidence containment rejects traversal, hidden files, credentials and binary files',()=>{
  const root='/srv/project';
  assert.equal(allowedFile(root,'reports/agents/worker/review.md'),root+'/reports/agents/worker/review.md');
  for(const path of ['../.aws/credentials','reports/agents/../../../.aws/credentials','reports/agents/.hidden/a.json','reports/agents/worker/deps/config.json','/etc/passwd','reports/agents/worker/model.bin','research-state.yaml/../.aws/config'])assert.equal(allowedFile(root,path),null,path);
});
test('Redaction preserves JSON structure and masks nested credentials',()=>{
  const source={terminal:'last line HF_TOKEN=hf_'+'a'.repeat(30),access_token:'secret',nested:[{text:'Bearer '+'x'.repeat(25)}],live:true};
  const out=redactTree(source);
  assert.equal(out.access_token,'[REDACTED]');assert.ok(!JSON.stringify(out).includes('a'.repeat(30)));assert.ok(!JSON.stringify(out).includes('x'.repeat(25)));assert.equal(out.live,true);assert.deepEqual(JSON.parse(JSON.stringify(out)),out);
});
test('Offline and waiting prompt cannot imply finished research',()=>{
  assert.equal(activity('Ask Codex to do anything',false,null).state,'offline');
  assert.equal(activity('Ask Codex to do anything',true,null).state,'idle');
  assert.equal(activity('unclear output',true,null).state,'unknown');
});
test('Structured status rejects unsupported claims and dependencies',()=>{
  const base={agent:'worker',status:'waiting',task:'Audit the latest run',summary:'Waiting for raw evidence',validation:[{name:'Runtime math',status:'pending'}]};
  assert.equal(validateReport(base),base);
  assert.throws(()=>validateReport({...base,status:'scientifically_proven'}));
  assert.throws(()=>validateReport({...base,dependsOn:['worker']}));
  assert.throws(()=>validateReport({...base,validation:[{name:'Runtime',status:'probably_pass'}]}));
});
test('Agent names are path-safe, and an allowlist narrows them when configured',()=>{
  const base={agent:'worker',status:'waiting',task:'t',summary:'s',validation:[]};
  for(const name of ['../escape','a/b','.hidden','',undefined,'x'.repeat(65)]){
    assert.equal(agentAllowed(name,{}),false);
    assert.throws(()=>validateReport({...base,agent:name},{}));
  }
  assert.equal(agentAllowed('any-agent_1',{}),true);
  const env={DAG_WEB_AGENTS:'one, two'};
  assert.equal(agentAllowed('two',env),true);
  assert.equal(agentAllowed('three',env),false);
  assert.throws(()=>validateReport(base,env));
  assert.equal(validateReport({...base,agent:'one',dependsOn:['two']},env).agent,'one');
  assert.throws(()=>validateReport({...base,agent:'one',dependsOn:['three']},env));
});
