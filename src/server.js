import net from 'node:net';
import crypto from 'node:crypto';
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import pg from 'pg';
import ZKLib from 'node-zklib';
import { mountIntegrations } from './integrations.js';
import { mountEmployees, countryCode } from './employees.js';
import { localizedPage } from './i18n/index.js';
import { mountOrganization } from './organization.js';
import { mountDevicePush } from './device-push.js';
import { writeUser, deviceName, readsEnabled } from './zk-device.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const app=express(); const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
// Without a listener, an idle client dropped by PostgreSQL (restart, network) crashes the process; the pool replaces it.
pool.on('error',e=>console.error('PostgreSQL idle client error:',e.code||e.message));
const dir=path.dirname(fileURLToPath(import.meta.url));
if(!process.env.ADMIN_TOKEN||process.env.ADMIN_TOKEN.length<24||!process.env.DATABASE_URL){throw new Error('Set DATABASE_URL and a strong ADMIN_TOKEN in .env');}
// Username/password sign-in is optional: without ADMIN_USERNAME/ADMIN_PASSWORD, or with a weak
// password, it stays off and the admin token keeps working, so existing installations start unchanged.
const loginUser=process.env.ADMIN_USERNAME||'',loginPass=process.env.ADMIN_PASSWORD||'';
const signInProblem=!loginUser||!loginPass?'ADMIN_USERNAME/ADMIN_PASSWORD not set'
 :loginPass.length<12?'ADMIN_PASSWORD is shorter than 12 characters'
 :['REPLACE_WITH_A_STRONG_PASSWORD','CHANGE_ME'].includes(loginPass)?'ADMIN_PASSWORD is still the example placeholder':null;
if(signInProblem)console.warn('Username/password sign-in disabled: '+signInProblem+'. The admin token still works.');
app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:'64kb'}));
app.get('/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,db:'connected'});}catch{res.status(503).json({ok:false,db:'unavailable'});}});
// Constant-time comparison so response timing does not leak how much of a guessed token matched.
const adminToken=Buffer.from(process.env.ADMIN_TOKEN);
const tokenMatches=v=>{const b=Buffer.from(String(v??''));return b.length===adminToken.length&&crypto.timingSafeEqual(b,adminToken);};
// Username/password sign-in issues a random session token; the admin token itself never reaches the
// browser this way. Sessions live in memory only (a restart signs everyone out) and end after
// SESSION_IDLE without requests or SESSION_MAX in total, or on sign-out. Hashing both sides first
// gives equal-length buffers, so comparisons stay constant-time whatever the input length.
const digest=v=>crypto.createHash('sha256').update(String(v??'')).digest();
const sameSecret=(a,b)=>crypto.timingSafeEqual(digest(a),digest(b));
const SESSION_IDLE=30*60e3,SESSION_MAX=12*3600e3,MAX_SESSIONS=50;
const sessions=new Map(); // sha256(token) -> {created, seen}
function sessionValid(v){
 if(!v)return false;
 const k=digest(v).toString('hex'),s=sessions.get(k),now=Date.now();
 if(!s)return false;
 if(now-s.seen>SESSION_IDLE||now-s.created>SESSION_MAX){sessions.delete(k);return false;}
 s.seen=now;return true;
}
// Per client address: 5 failures within 15 minutes lock sign-in, for 1 minute the first time and
// twice as long each further time (at most 15 minutes). A correct password is refused while locked.
// req.ip is the socket address ('trust proxy' is off), so it cannot be spoofed with headers.
const RATE={fails:5,window:15*60e3,lock:60e3,maxLock:15*60e3};
const attempts=new Map(); // ip -> {fails:[time], lockouts, until}
app.get('/auth/config',(req,res)=>res.json({password_sign_in:!signInProblem}));
app.post('/auth/login',(req,res)=>{
 res.set('Cache-Control','no-store');
 if(signInProblem)return res.status(503).json({error:'Username/password sign-in is not configured on this server. Use the admin token.'});
 const ip=req.ip,now=Date.now();
 const a=attempts.get(ip)||{fails:[],lockouts:0,until:0};
 if(a.until>now){res.set('Retry-After',String(Math.ceil((a.until-now)/1000)));return res.status(429).json({error:'Too many attempts. Try again later.',retry_after_seconds:Math.ceil((a.until-now)/1000)});}
 if(now-a.until>24*3600e3)a.lockouts=0;
 const {username,password}=req.body||{};
 const valid=typeof username==='string'&&typeof password==='string'&&username.length<=200&&password.length<=200;
 const userOk=sameSecret(valid?username:'',loginUser),passOk=sameSecret(valid?password:'',loginPass);  // both always evaluated
 if(!(valid&&userOk&&passOk)){
  a.fails=a.fails.filter(t=>now-t<RATE.window);a.fails.push(now);
  if(a.fails.length>=RATE.fails){a.lockouts++;a.until=now+Math.min(RATE.maxLock,RATE.lock*2**(a.lockouts-1));a.fails=[];}
  attempts.set(ip,a);
  if(attempts.size>1000)for(const [k,v] of attempts)if(v.until<now&&!v.fails.some(t=>now-t<RATE.window))attempts.delete(k);
  return res.status(401).json({error:'Invalid username or password'});
 }
 attempts.delete(ip);
 const token=crypto.randomBytes(32).toString('hex');
 while(sessions.size>=MAX_SESSIONS)sessions.delete(sessions.keys().next().value);  // oldest first
 sessions.set(digest(token).toString('hex'),{created:now,seen:now});
 res.json({token,idle_timeout_seconds:SESSION_IDLE/1000,max_age_seconds:SESSION_MAX/1000});
});
app.post('/auth/logout',(req,res)=>{sessions.delete(digest(req.get('X-Admin-Token')).toString('hex'));res.json({ok:true});});
// The admin token keeps working unchanged (scripts, smoke tests, existing installations).
app.use('/api', (req,res,next)=>{const t=req.get('X-Admin-Token');if(!tokenMatches(t)&&!sessionValid(t))return res.status(401).json({error:'Unauthorized'});next();});
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
app.get('/api/overview',wrap(async(req,res)=>{const tables=['companies','branches','employees','devices','attendance_events','sync_jobs']; const values={};for(const t of tables){values[t]=Number((await pool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);}res.json(values);}));
mountEmployees(app,pool,wrap);
mountOrganization(app,pool,wrap);
app.get('/api/companies',wrap(async(req,res)=>res.json((await pool.query('SELECT * FROM companies ORDER BY name')).rows)));
app.get('/api/branches',wrap(async(req,res)=>res.json((await pool.query('SELECT id,company_id,name,country FROM branches ORDER BY name')).rows)));
app.get('/api/devices',wrap(async(req,res)=>res.json((await pool.query('SELECT * FROM devices ORDER BY created_at DESC')).rows)));
app.post('/api/companies',wrap(async(req,res)=>{const name=String(req.body.name||'').trim();if(!name)return res.status(400).json({error:'Name required'});const {rows}=await pool.query('INSERT INTO companies(name) VALUES($1) RETURNING *',[name]);res.status(201).json(rows[0]);}));
app.post('/api/branches',wrap(async(req,res)=>{const {company_id,name}=req.body,country=countryCode(req.body.country);if(!company_id||!String(name||'').trim()||!country)return res.status(400).json({error:'company_id, name and a supported country required'});const {rows}=await pool.query('INSERT INTO branches(company_id,name,country) VALUES($1,$2,$3) RETURNING *',[company_id,String(name).trim(),country]);res.status(201).json(rows[0]);}));

app.get('/api/hr-imported-employees',wrap(async(req,res)=>{
 const {rows}=await pool.query(`
  SELECT id,hr_employee_code,name_en,name_ar,country,
         company_id,home_branch_id,import_status,central_uid,biometric_number,biometric_uid
  FROM hr_employee_staging
  ORDER BY country,hr_employee_code
  LIMIT 500
 `);
 res.json(rows);
}));


app.patch('/api/hr-imported-employees/:id',wrap(async(req,res)=>{
 const id=req.params.id;
 if(!/^[0-9a-f-]{36}$/i.test(id))
  return res.status(400).json({error:'Invalid employee ID'});

 const old=(await pool.query(
  'SELECT * FROM hr_employee_staging WHERE id=$1',[id]
 )).rows[0];

 if(!old)return res.status(404).json({error:'Employee not found'});

 const body=req.body||{};
 const name=String(body.name_en??old.name_en??'').trim();
 const country=String(body.country??old.country??'').trim();
 const number=String(body.biometric_number??'').trim();
 const uid=String(body.biometric_uid??'').trim();
 const company=body.company_id||null;
 const branch=body.home_branch_id||null;

 const countries={
  EG:'Egypt',Egypt:'Egypt',
  SA:'Saudi Arabia','Saudi Arabia':'Saudi Arabia',
  JO:'Jordan',Jordan:'Jordan'
 };

 if(!name||!countries[country])
  return res.status(400).json({error:'Valid name and country required'});

 if(branch&&!company)
  return res.status(400).json({error:'Select a company first'});

 if(company){
  const valid=await pool.query(
   'SELECT 1 FROM companies WHERE id::text=$1',[company]
  );
  if(!valid.rowCount)
   return res.status(400).json({error:'Invalid company'});
 }

 if(branch){
  const valid=await pool.query(
   'SELECT 1 FROM branches WHERE id::text=$1 AND company_id::text=$2 AND country IN ($3,$4)',
   [branch,company,country,countries[country]]
  );
  if(!valid.rowCount)
   return res.status(400).json({error:'Branch, company or country mismatch'});
 }

 const q=await pool.query(`
  UPDATE hr_employee_staging
  SET name_en=$2,country=$3,company_id=$4,
      home_branch_id=$5,biometric_number=$6,biometric_uid=$7
  WHERE id=$1
  RETURNING id
 `,[id,name,countries[country],company,branch,number||null,uid||null]);

 res.json({ok:true,id:q.rows[0].id});
}));


app.post('/api/devices',wrap(async(req,res)=>{
 const {company_id,branch_id,name,model,ip,port}=req.body||{};
 const devicePort=Number(port||4370);
 const deviceIp=String(ip||'').trim();

 if(!UUID_RE.test(String(company_id||'')) ||
    !UUID_RE.test(String(branch_id||'')) ||
    !String(name||'').trim() ||
    !net.isIP(deviceIp) ||
    !Number.isInteger(devicePort) ||
    devicePort<1 || devicePort>65535) {
   return res.status(400).json({error:'Invalid device details'});
 }

 const check=await pool.query(
   'SELECT 1 FROM branches WHERE id=$1 AND company_id=$2',
   [branch_id,company_id]
 );
 if(!check.rowCount)
   return res.status(400).json({error:'Invalid branch/company'});

 const result=await pool.query(
   `INSERT INTO devices(company_id,branch_id,name,model,ip,port)
    VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT (company_id,ip,port) WHERE ip IS NOT NULL
    DO NOTHING
    RETURNING *`,
   [company_id,branch_id,String(name).trim(),model||null,deviceIp,devicePort]
 );

 if(result.rowCount)
   return res.status(201).json({
     ...result.rows[0],
     already_exists:false
   });

 const existing=await pool.query(
   `SELECT * FROM devices
    WHERE company_id=$1 AND ip=$2 AND port=$3`,
   [company_id,deviceIp,devicePort]
 );

 if(!existing.rowCount)
   return res.status(409).json({error:'Registration conflict; retry'});

 return res.status(200).json({
   ...existing.rows[0],
   already_exists:true,
   message:'Device already registered'
 });
}));
// Strictly read-only preview: only a configured, pre-approved Egypt IP may be queried.
app.get('/api/egypt/scan-preview',wrap(async(req,res)=>{const ip=process.env.EGYPT_ZK_IP||'192.168.1.147',port=Number(process.env.EGYPT_ZK_PORT||4370);const zk=new ZKLib(ip,port,10000,5200);try{await zk.createSocket();const result=await zk.getUsers();const users=Array.isArray(result)?result:(result.data||[]);res.json({count:users.length,users:users.map(u=>({uid:String(u.uid??''),userId:String(u.userId??''),name:u.name||''}))});}finally{try{await zk.disconnect()}catch{}}}));
// Staging is deliberately separate from central employees. Device UID is local to device.
async function readEgyptUsers(){
 const ip=process.env.EGYPT_ZK_IP||'192.168.1.147',port=Number(process.env.EGYPT_ZK_PORT||4370);
 const zk=new ZKLib(ip,port,10000,5200);
 try{await zk.createSocket();const result=await zk.getUsers();const users=Array.isArray(result)?result:(result.data||[]);
  return users.map(u=>({uid:String(u.uid??'').trim(),userId:String(u.userId??'').trim(),name:String(u.name??'').trim()}));
 }finally{try{await zk.disconnect();}catch{}}
}
app.get('/api/device-import/staging',wrap(async(req,res)=>{
 const deviceId=req.query.device_id;
 if(!deviceId)return res.status(400).json({error:'device_id required'});
 const {rows}=await pool.query('SELECT id,device_id,device_uid,device_user_id,device_name,review_status,matched_employee_id,last_seen_at FROM device_user_staging WHERE device_id=$1 ORDER BY device_uid',[deviceId]);res.json(rows);
}));
app.post('/api/device-import/egypt',wrap(async(req,res)=>{
 const {device_id}=req.body||{};
 if(!device_id)return res.status(400).json({error:'device_id required'});
 const dev=await pool.query('SELECT * FROM devices WHERE id=$1',[device_id]);
 if(!dev.rowCount || dev.rows[0].ip !== (process.env.EGYPT_ZK_IP||'192.168.1.147') || Number(dev.rows[0].port)!==Number(process.env.EGYPT_ZK_PORT||4370))return res.status(400).json({error:'Select the registered Egypt test device'});
 const users=await readEgyptUsers();
 if(users.some(x=>!x.uid||!x.userId)||new Set(users.map(x=>x.uid)).size!==users.length)return res.status(409).json({error:'Invalid or duplicate device UID; nothing imported'});
 const client=await pool.connect();let inserted=0,updated=0;
 try{await client.query('BEGIN');
  for(const u of users){
   const q=await client.query(`INSERT INTO device_user_staging(device_id,device_uid,device_user_id,device_name) VALUES($1,$2,$3,$4)
     ON CONFLICT(device_id,device_uid) DO UPDATE SET device_user_id=EXCLUDED.device_user_id,device_name=EXCLUDED.device_name,last_seen_at=now(),
       review_status=CASE WHEN device_user_staging.device_user_id IS DISTINCT FROM EXCLUDED.device_user_id THEN 'NEEDS_REVIEW' ELSE device_user_staging.review_status END,
       matched_employee_id=CASE WHEN device_user_staging.device_user_id IS DISTINCT FROM EXCLUDED.device_user_id THEN NULL ELSE device_user_staging.matched_employee_id END
     RETURNING (xmax=0) AS inserted`,[device_id,u.uid,u.userId,u.name]);
   if(q.rows[0].inserted)inserted++;else updated++;
  }
  await client.query('INSERT INTO audit_events(action,entity_type,entity_id,details) VALUES($1,$2,$3,$4)', ['DEVICE_STAGING_IMPORT','device',device_id,JSON.stringify({count:users.length,inserted,updated})]);
  await client.query('COMMIT');res.json({count:users.length,inserted,updated,review_required:true,message:'Stored in staging only. No central employees were created; no device writes.'});
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));

// V4 manual device enrollment: explicit, restricted to approved Egypt device.
let enrollmentBusy = false;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function getEnrollmentContext(employeeId, deviceId) {
 if (!UUID_RE.test(String(employeeId||'')) || !UUID_RE.test(String(deviceId||''))) return {error:'Valid employee_id and device_id required',status:400};
 const emp=(await pool.query('SELECT * FROM employees WHERE id=$1',[employeeId])).rows[0];
 const dev=(await pool.query('SELECT * FROM devices WHERE id=$1',[deviceId])).rows[0];
 if (!emp||!dev) return {error:'Employee or device not found',status:404};
 if (!emp.active) return {error:'Inactive employee',status:409};
 if(emp.company_id!==dev.company_id) return {error:'Employee and device must belong to same company',status:403};
 if(emp.home_branch_id && emp.home_branch_id!==dev.branch_id)return {error:'Employee home branch differs; cross-branch access requires separate approval',status:409};
 if(dev.ip!== (process.env.EGYPT_ZK_IP||'192.168.1.147') || Number(dev.port)!==Number(process.env.EGYPT_ZK_PORT||4370))return {error:'Only preapproved Egypt MB2000 can be used',status:403};
 return {emp,dev};
}
// A transfer error comes back next to a partial list; planning against it could reuse a taken slot.
function parseUsers(result){if(result&&!Array.isArray(result)&&result.err)throw Error('Device user list was incomplete; nothing was changed');const values=Array.isArray(result)?result:result?.data;if(!Array.isArray(values))throw Error('Unexpected users response');return values;}
function makePlan(users,emp,requestUserId){
 const userId=String(requestUserId??emp.employee_code).trim();
 if(!/^\d{1,9}$/.test(userId))return {error:'Device user ID must be 1-9 digits; supply device_user_id explicitly',status:400};
 const existing=users.find(u=>String(u.userId??'')===userId);
 if(existing)return {error:'Device user ID already exists. No existing record will be changed.',status:409,existing:{uid:String(existing.uid),userId:String(existing.userId),name:String(existing.name||'')}};
 const occupied=new Set(users.map(u=>Number(u.uid)).filter(Number.isInteger));
 let uid=1;while(occupied.has(uid) && uid<=65535)uid++;
 if(uid>65535)return {error:'No free device UID',status:409};
 const name=String(emp.full_name||'').trim();
 if(!name || Buffer.byteLength(name,'utf8')>23)return {error:'Name must be 1-23 UTF-8 bytes for compatibility with this device protocol',status:400};
 // The device stores names as ASCII; anything else would be written garbled.
 if(deviceName(name)?.name!==name)return {error:'Name has characters this device protocol cannot store (Latin letters, digits and punctuation only)',status:400};
 return {uid,userId,name};
}
async function readDeviceUsers(dev,callback){
 const zk=new ZKLib(dev.ip,Number(dev.port),10000,5200);
 try{await zk.createSocket();return await callback(zk,parseUsers(await zk.getUsers()));}
 finally{try{await zk.disconnect();}catch{}}
}
app.post('/api/device-enrollment/preview',wrap(async(req,res)=>{
 if(!readsEnabled())return res.status(403).json({error:'Device connections are disabled on this server. Set ENABLE_DEVICE_READS=true after approval.'});
 const {employee_id,device_id,device_user_id}=req.body||{};
 const context=await getEnrollmentContext(employee_id,device_id);
 if(context.error)return res.status(context.status).json(context);
 const plan=await readDeviceUsers(context.dev,async(_zk,users)=>makePlan(users,context.emp,device_user_id));
 if(plan.error)return res.status(plan.status).json(plan);
 res.json({ready:true,employee_id,device_id,plan,device_write:false,requires_confirmation:'PUSH_ONE_EMPLOYEE'});
}));
app.post('/api/device-enrollment/push',wrap(async(req,res)=>{
 if(process.env.ENABLE_DEVICE_WRITES!=='true')return res.status(403).json({error:'Device writes disabled. Set ENABLE_DEVICE_WRITES=true after approval.'});
 if(!readsEnabled())return res.status(403).json({error:'Device connections are disabled on this server. Set ENABLE_DEVICE_READS=true after approval.'});
 const {employee_id,device_id,device_user_id,confirmation,expected_uid}=req.body||{};
 if(confirmation!=='PUSH_ONE_EMPLOYEE')return res.status(400).json({error:'Explicit confirmation required'});
 if(!Number.isInteger(expected_uid)||expected_uid<1)return res.status(400).json({error:'Preview expected_uid required'});
 if(enrollmentBusy)return res.status(409).json({error:'Another device enrollment is running'});
 enrollmentBusy=true;
 try{
  const context=await getEnrollmentContext(employee_id,device_id);
  if(context.error)return res.status(context.status).json(context);
  // Prevent accidental reuse of an existing identity on this device.
  const linked=await pool.query('SELECT 1 FROM device_employee_links WHERE device_id=$1 AND employee_id=$2',[device_id,employee_id]);
  if(linked.rowCount)return res.status(409).json({error:'Employee already linked to device'});
  const result=await readDeviceUsers(context.dev,async(zk,users)=>{
   const plan=makePlan(users,context.emp,device_user_id);
   if(plan.error)return {error:plan.error,status:plan.status};
   if(plan.uid!==expected_uid)return {error:'Device users changed since preview. Preview again.',status:409};
   // Commit device write, verify by reading back before database link.
   // (node-zklib has no setUser; writeUser encodes the record and checks the acknowledgement.)
   if(!await writeUser(zk,plan))return {error:'Device rejected the write',status:502};
   const after=parseUsers(await zk.getUsers());
   const verified=after.find(u=>String(u.uid)===String(plan.uid) && String(u.userId)===plan.userId);
   if(!verified)return {error:'Write returned but verification failed. Inspect device before retrying.',status:502};
   return {plan,verified:true};
  });
  if(result.error)return res.status(result.status).json(result);
  try{
   await pool.query('INSERT INTO device_employee_links(device_id,employee_id,device_uid,device_user_id) VALUES($1,$2,$3,$4)',[device_id,employee_id,String(result.plan.uid),result.plan.userId]);
   await pool.query('INSERT INTO audit_events(action,entity_type,entity_id,details) VALUES($1,$2,$3,$4)', ['DEVICE_EMPLOYEE_PUSH','employee',employee_id,JSON.stringify({device_id,device_uid:result.plan.uid,device_user_id:result.plan.userId})]);
  }catch(e){console.error('DEVICE WRITE SUCCEEDED BUT LINK FAILED',employee_id,device_id,e.message);return res.status(500).json({error:'Device verified, but DB link failed. DO NOT retry; reconcile manually.',device_write:true,plan:result.plan});}
  return res.json({ok:true,device_write:true,verified:true,employee_id,device_id,plan:result.plan,message:'User record created; fingerprint/face enrollment must be performed separately on the device.'});
 }finally{enrollmentBusy=false;}
}));

mountIntegrations(app,pool,wrap);
mountDevicePush(app,pool,wrap);
app.get('/',(req,res)=>res.sendFile(path.resolve(dir,'../public/index.html')));
app.get('/ar',wrap(async(req,res)=>res.type('html').send(await localizedPage('ar'))));
// Bad input rejected by PostgreSQL or the body parser is the client's error (4xx), not a server failure.
const CLIENT_ERRORS={'23505':[409,'Duplicate identifier'],'22P02':[400,'Invalid identifier'],'23503':[409,'Referenced record is missing or still in use'],
 'entity.too.large':[413,'Request body too large'],'entity.parse.failed':[400,'Malformed request body']};
app.use((err,req,res,next)=>{
 const known=CLIENT_ERRORS[err.code]||CLIENT_ERRORS[err.type];
 if(known){console.warn('Request rejected:',err.code||err.type,req.method,req.path);return res.status(known[0]).json({error:known[1]});}
 console.error('Request failed:',err.code||err.message);res.status(500).json({error:'Request failed; check server logs'});
});
app.listen(Number(process.env.PORT||5180),process.env.HOST||'127.0.0.1',()=>console.log('ZK Central MVP running'));
