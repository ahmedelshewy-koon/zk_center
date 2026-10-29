import crypto from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns/promises';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const secretKey=()=>{const v=process.env.INTEGRATIONS_ENCRYPTION_KEY||'';if(!/^[a-f0-9]{64}$/i.test(v))throw new Error('INTEGRATIONS_ENCRYPTION_KEY must be 64 hexadecimal characters');return Buffer.from(v,'hex');};
function encrypt(token){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',secretKey(),iv),a=Buffer.concat([c.update(token,'utf8'),c.final()]);return [iv,c.getAuthTag(),a].map(x=>x.toString('base64url')).join('.');}
function decrypt(value){const [a,b,c]=value.split('.');const cipher=crypto.createDecipheriv('aes-256-gcm',secretKey(),Buffer.from(a,'base64url'));cipher.setAuthTag(Buffer.from(b,'base64url'));return Buffer.concat([cipher.update(Buffer.from(c,'base64url')),cipher.final()]).toString('utf8');}
function isPrivateIp(address){if(net.isIP(address)===4){const p=address.split('.').map(Number);return p[0]===10||p[0]===127||p[0]===192&&p[1]===168||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===169&&p[1]===254;}if(net.isIP(address)===6){const s=address.toLowerCase();return s==='::1'||s.startsWith('fc')||s.startsWith('fd')||s.startsWith('fe80:');}return false;}
async function validateEndpoint(raw){let url;try{url=new URL(raw);}catch{throw Error('Invalid endpoint URL');}if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hash)throw Error('Invalid endpoint URL');
 if(url.protocol==='http:'&&process.env.ALLOW_INTERNAL_HTTP_INTEGRATIONS!=='true')throw Error('HTTPS required; internal HTTP must be explicitly enabled');
 if(net.isIP(url.hostname)===0){const addrs=await dns.lookup(url.hostname,{all:true});if(!addrs.length)throw Error('Host lookup failed');if(addrs.some(a=>isPrivateIp(a.address))&&process.env.ALLOW_PRIVATE_INTEGRATION_HOSTS!=='true')throw Error('Private host blocked');}
 else if(isPrivateIp(url.hostname)&&process.env.ALLOW_PRIVATE_INTEGRATION_HOSTS!=='true')throw Error('Private host blocked');
 return url.toString();}
function publicRow(r){return {id:r.id,name:r.name,endpoint_url:r.endpoint_url,is_active:r.is_active,created_at:r.created_at,updated_at:r.updated_at,token_configured:true};}
async function log(pool,integrationId,action,employeeId,status,responseCode,detail){await pool.query('INSERT INTO api_integration_logs(integration_id,action,employee_id,status,response_code,detail) VALUES($1,$2,$3,$4,$5,$6)',[integrationId,action,employeeId||null,status,responseCode||null,String(detail||'').slice(0,400)]);}
async function send(url,token,payload){const target=await validateEndpoint(url);const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);
 try{const response=await fetch(target,{method:'POST',redirect:'manual',signal:controller.signal,headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify(payload)});const content=await response.text();return {status:response.status,ok:response.ok,body:content.slice(0,500)};}finally{clearTimeout(timer);}}
export function mountIntegrations(app,pool,wrap){
 app.get('/api/integrations',wrap(async(req,res)=>{const q=await pool.query('SELECT * FROM api_integrations WHERE deleted_at IS NULL ORDER BY created_at DESC');res.json(q.rows.map(publicRow));}));
 app.post('/api/integrations',wrap(async(req,res)=>{const {name,endpoint_url,api_token}=req.body||{};if(!String(name||'').trim()||String(api_token||'').length<20)return res.status(400).json({error:'Name and token (20+ chars) required'});let url;try{url=await validateEndpoint(String(endpoint_url||''));}catch(e){return res.status(400).json({error:e.message});}const row=(await pool.query('INSERT INTO api_integrations(name,endpoint_url,token_ciphertext) VALUES($1,$2,$3) RETURNING *',[String(name).trim().slice(0,120),url,encrypt(String(api_token))])).rows[0];res.status(201).json(publicRow(row));}));
 app.patch('/api/integrations/:id',wrap(async(req,res)=>{if(!UUID.test(req.params.id))return res.status(400).json({error:'Invalid ID'});const old=(await pool.query('SELECT * FROM api_integrations WHERE id=$1 AND deleted_at IS NULL',[req.params.id])).rows[0];if(!old)return res.status(404).json({error:'Not found'});const {name,endpoint_url,api_token,is_active}=req.body||{};let url=old.endpoint_url;if(endpoint_url!==undefined){try{url=await validateEndpoint(String(endpoint_url));}catch(e){return res.status(400).json({error:e.message});}}if(api_token!==undefined&&String(api_token).length<20)return res.status(400).json({error:'Token too short'});const row=(await pool.query('UPDATE api_integrations SET name=$2,endpoint_url=$3,token_ciphertext=$4,is_active=$5,updated_at=now() WHERE id=$1 RETURNING *',[old.id,name===undefined?old.name:String(name).trim().slice(0,120),url,api_token===undefined?old.token_ciphertext:encrypt(String(api_token)),typeof is_active==='boolean'?is_active:old.is_active])).rows[0];res.json(publicRow(row));}));
 async function getTarget(id){if(!UUID.test(id))return null;return (await pool.query('SELECT * FROM api_integrations WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];}
 app.post('/api/integrations/:id/test',wrap(async(req,res)=>{const dest=await getTarget(req.params.id);if(!dest)return res.status(404).json({error:'Not found'});if(!dest.is_active)return res.status(409).json({error:'Destination disabled'});try{const healthUrl = new URL(dest.endpoint_url);
if (healthUrl.pathname.endsWith('/employees/receive')) {
  healthUrl.pathname += '/health';
} else {
  return res.status(400).json({error:'Unsupported receiving API path'});
}
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10000);
let r;
try {
  const response = await fetch(healthUrl, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + decrypt(dest.token_ciphertext)
    },
    signal: controller.signal
  });
  const body = await response.json().catch(() => ({}));
  r = {
    ok: response.ok && body.success === true && body.employee_receiving === 'enabled',
    status: response.status
  };
} finally {
  clearTimeout(timeout);
}await log(pool,dest.id,'TEST',null,r.ok?'OK':'ERROR',r.status,`HTTP ${r.status}`);res.json({ok:r.ok,http_status:r.status,message:r.ok?'Test request accepted':'Test request rejected; receiver may not support empty employee test'});}catch(e){await log(pool,dest.id,'TEST',null,'ERROR',null,e.message);res.status(502).json({error:'Connection failed; check service logs'});}}));
 app.post('/api/integrations/:id/send-employee',wrap(async(req,res)=>{const dest=await getTarget(req.params.id);if(!dest)return res.status(404).json({error:'Not found'});if(!dest.is_active)return res.status(409).json({error:'Destination disabled'});const employeeId=String(req.body?.employee_id||'');if(!UUID.test(employeeId))return res.status(400).json({error:'Valid employee_id required'});if(req.body.confirmation!=='SEND_ONE_EMPLOYEE')return res.status(400).json({error:'Confirmation required'});const emp=(await pool.query('SELECT * FROM employees WHERE id=$1',[employeeId])).rows[0];if(!emp)return res.status(404).json({error:'Employee not found'});if(!emp.active)return res.status(409).json({error:'Employee inactive'});const payload={source:'zk-central',request_id:crypto.randomUUID(),employees:[{central_uid:emp.id,employee_code:emp.employee_code,name:emp.full_name,company_id:emp.company_id,branch_id:emp.home_branch_id,active:emp.active}]};
 try{const r=await send(dest.endpoint_url,decrypt(dest.token_ciphertext),payload);await log(pool,dest.id,'SEND_EMPLOYEE',emp.id,r.ok?'ACCEPTED':'REJECTED',r.status,`HTTP ${r.status}`);
res.status(r.ok?200:502).json({
  ok:r.ok,
  http_status:r.status,
  request_id:payload.request_id,
  message:r.ok?'Receiver accepted request. Device provisioning is not confirmed.':'Receiver rejected the request.',
  receiver_error:r.ok?undefined:r.body
});}catch(e){await log(pool,dest.id,'SEND_EMPLOYEE',emp.id,'ERROR',null,e.message);res.status(502).json({error:'Delivery failed or uncertain. Check logs before retrying to avoid duplicates.'});}}));
 app.delete('/api/integrations/:id',wrap(async(req,res)=>{
  if(!UUID.test(req.params.id))
    return res.status(400).json({error:'Invalid integration ID'});

  const result=await pool.query(
    `UPDATE api_integrations
     SET deleted_at=now(),is_active=false,updated_at=now()
     WHERE id=$1 AND deleted_at IS NULL
     RETURNING id`,
    [req.params.id]
  );

  if(!result.rowCount)
    return res.status(404).json({error:'Connection not found'});

  res.json({ok:true,message:'Connection deleted'});
 }));
 app.get('/api/integrations/logs',wrap(async(req,res)=>{const q=await pool.query('SELECT l.id,l.integration_id,d.name AS integration_name,l.action,l.employee_id,l.status,l.response_code,l.detail,l.created_at FROM api_integration_logs l LEFT JOIN api_integrations d ON d.id=l.integration_id ORDER BY l.created_at DESC LIMIT 100');res.json(q.rows);}));
}
