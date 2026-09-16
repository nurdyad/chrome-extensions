import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../linear-trigger-server.mjs',import.meta.url),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
function harness(count){
 let queryLimit,issueFetches=0,mutations=0;
 const deps={SQL_RECONCILE_MAX_ROWS:2,SQL_RECONCILE_QUERY_TIMEOUT_MS:1000,SQL_RECONCILE_PAUSED_BOT_JOBS_SQL:'query',
 runSqlQueryWithConnectionRetry:async(_,args)=>{queryLimit=args[0];return {rows:Array.from({length:count},()=>({job_type:'docman_import'}))};},
 sanitizeSqlReconcileDashboardRow:x=>x,SQL_RECONCILE_ENABLED:true,ensureLinearConfig(){},isSqlLookupConfigured:()=>true,
 nowIso:()=>new Date().toISOString(),resolveLinearTeam:async()=>({id:'team'}),resolveLinearDoneStateId:async()=> 'done',
 buildSqlReconcileLiveIndex:()=>({}),fetchSqlReconcileOpenBotIssues:async()=>{issueFetches++;return [];},
 moveLinearIssueToState:async()=>{mutations++;},sanitizeSingleLine:x=>String(x)};
 const body=section('async function collectSqlReconcileDashboardRows','function buildSqlReconcileLiveIndex')+
 section('function buildSqlReconcileSummary','async function finalizeInProcessBotJobsRun');
 const run=new Function(...Object.keys(deps),body+'return runSqlReconcileBotIssues;')(...Object.values(deps));
 return {run,stats:()=>({queryLimit,issueFetches,mutations})};
}
for(const dryRun of [false,true]) test(`truncated scan stops before fetching or mutating issues (dryRun=${dryRun})`,async()=>{
 const h=harness(3),r=await h.run({dryRun});
 assert.equal(r.scan_truncated,true);assert.equal(r.errors.length,1);assert.match(r.errors[0].message,/scan limit/);
 assert.match(r.summary.lines.join(' '),/incomplete/);assert.equal(r.issues_preview_done.length,0);
 assert.deepEqual(h.stats(),{queryLimit:3,issueFetches:0,mutations:0});
});
for(const count of [0,1,2]) test(`complete scan of ${count} rows continues`,async()=>{
 const h=harness(count),r=await h.run();assert.equal(r.scan_truncated,false);assert.equal(r.errors.length,0);assert.equal(h.stats().issueFetches,1);
});
