from pathlib import Path

p = Path("public/index.html")
s = p.read_text(encoding="utf-8")

old = "async function api(p,opts={}){const r=await fetch('/api'+p,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});"

new = """let localAdminToken = '';

function setLocalAdminToken(){
 const value = prompt('Enter local ZK Central Admin Token:');
 if(value === null) return;
 localAdminToken = value.trim();
 loadAll();
}

async function api(p,opts={}){
 const r=await fetch('/api'+p,{
  ...opts,
  headers:{
   'Content-Type':'application/json',
   ...(localAdminToken ? {'X-Admin-Token':localAdminToken} : {}),
   ...(opts.headers||{})
  }
 });"""

if s.count(old) != 1:
    raise SystemExit("API function differs. No changes saved.")

s = s.replace(old,new,1)

s = s.replace(
    "window.addEventListener('DOMContentLoaded',()=>loadAll());",
    "window.addEventListener('DOMContentLoaded',()=>setLocalAdminToken());",
    1
)

p.write_text(s,encoding="utf-8")
print("LOCAL TOKEN LOGIN INSTALLED")
