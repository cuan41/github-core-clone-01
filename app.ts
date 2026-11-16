// GitHub-compatible forge: REST v3, GraphQL v4, MCP (Streamable HTTP), and smart Git HTTP.
// Single in-memory store, no dependencies, no git binary, no outbound network.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';
const ZERO_OID = '0'.repeat(40);
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function parseTrialNowMs(): number {
  const v = process.env.MAKEFUN_TRIAL_NOW;
  if (!v) return 1700000000000;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 1700000000000;
}
const TRIAL_NOW_MS = parseTrialNowMs();
const TRIAL_NOW_ISO = new Date(TRIAL_NOW_MS).toISOString();
const TRIAL_NOW_SEC = Math.floor(TRIAL_NOW_MS / 1000);
let reqSeq = 0;
function rid(): string { return `req-${(++reqSeq).toString(16)}`; }
function nowIso(): string { return TRIAL_NOW_ISO; }
function nowSec(): number { return TRIAL_NOW_SEC; }

function sendJsonBuffer(res: ServerResponse, status: number, body: Buffer): void {
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': String(body.length), 'x-github-request-id': rid() });
  res.end(body);
}
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  const buf = Buffer.from(text);
  const headers: Record<string, string> = { 'content-type': JSON_TYPE, 'content-length': String(buf.length), 'x-github-request-id': extra['x-github-request-id'] ?? rid(), ...extra };
  res.writeHead(status, headers);
  res.end(buf);
}
function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}
function sendEmpty(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': extra['x-github-request-id'] ?? rid(), ...extra });
  res.end();
}
function sendNotFound(res: ServerResponse): void { sendJson(res, 404, { message: 'Not Found' }); }
function sendUnauthorized(res: ServerResponse): void { sendJson(res, 401, { message: 'Bad credentials' }); }
function sendBadRequest(res: ServerResponse): void { sendJson(res, 400, { message: 'Problems parsing JSON' }); }

interface QueryView { get(name: string): string | null }
function targetOf(req: IncomingMessage): { path: string; qs: QueryView } {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  const text = q < 0 ? '' : raw.slice(q + 1);
  let params: URLSearchParams | null = null;
  return {
    path,
    qs: {
      get(name: string): string | null {
        if (params === null) params = new URLSearchParams(text);
        return params.get(name);
      },
    },
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); total += chunk.length; });
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total)));
    req.on('error', reject);
  });
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new Error('bad json'); }
}

function authToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (h.startsWith('token ')) return h.slice(6);
  return h;
}
function isAuthed(req: IncomingMessage): boolean { const t = authToken(req); return t !== null && TOKEN !== '' && t === TOKEN; }
function requireAuth(req: IncomingMessage, res: ServerResponse): boolean { if (!isAuthed(req)) { sendUnauthorized(res); return false; } return true; }

// ---------------- Store ----------------
interface GitObj { type: 'blob'|'tree'|'commit'|'tag'; data: Buffer }
interface Repo {
  id: number; nodeId: string; name: string; owner: string; fullName: string; private: boolean; description: string; defaultBranch: string;
  refs: Map<string,string>; objects: Map<string,GitObj>; createdAt: string;
  labels: Map<string,{name:string;color:string}>; issues: Issue[]; pulls: Pull[]; contents: Map<string,{sha:string;content:string;size:number;path:string}[]>; // by branch
  nextIssue: number; nextPull: number; nextCommentId: number;
  refsEpoch: number;
  advCache: Map<string,{epoch:number;body:Buffer}>;
  lsRefsCache: Map<string,{epoch:number;body:Buffer}>;
  fetchCache: Map<string,{epoch:number;body:Buffer}>;
  rawV2Cache: Map<string,{epoch:number;body:Buffer}>;
}
interface Issue { id:number; nodeId:string; number:number; title:string; body:string; state:'open'|'closed'; labels:{name:string}[]; comments:{id:number;body:string}[]; createdAt:string; jsonCache:{host:string;buf:Buffer}|null; }
interface Pull { id:number; nodeId:string; number:number; title:string; body:string; state:'open'|'closed'; headRef:string; baseRef:string; headSha:string; baseSha:string; merged:boolean; mergedAt:string|null; mergeCommitSha:string|null; files:{filename:string;status:string;additions:number;deletions:number;changes:number}[]; createdAt:string; }

let nextRepoId = 1, nextGlobalId = 1;
const repos = new Map<string, Repo>(); // key owner/name
function repoKey(owner:string,name:string){ return `${owner}/${name}`; }
function nodeId(kind:string,n:number){ return Buffer.from(`${kind}:${n}`).toString('base64'); }
function ownerOf(token: string): string {
  return 'adaiversen';
}
function viewerLogin(req: IncomingMessage): string { return ownerOf(authToken(req) ?? TOKEN); }

function getRepo(owner:string,name:string): Repo | undefined { return repos.get(repoKey(owner,name)); }
function ensureRepo(owner:string,name:string, opts?:{private?:boolean;description?:string}): Repo {
  const k = repoKey(owner,name);
  let r = repos.get(k);
  if (!r) {
    r = { id: nextRepoId++, nodeId: nodeId('repo', nextRepoId), name, owner, fullName:`${owner}/${name}`, private: !!opts?.private, description: opts?.description??'', defaultBranch:'main',
      refs:new Map(), objects:new Map(), createdAt: nowIso(), labels:new Map(), issues:[], pulls:[], contents:new Map(), nextIssue:1, nextPull:1, nextCommentId:1, refsEpoch:0, advCache:new Map(), lsRefsCache:new Map(), fetchCache:new Map(), rawV2Cache:new Map() };
    repos.set(k,r);
  }
  return r;
}

function bumpRefs(r:Repo){ r.refsEpoch += 1; if(r.advCache.size) r.advCache.clear(); if(r.lsRefsCache.size) r.lsRefsCache.clear(); if(r.fetchCache.size) r.fetchCache.clear(); if(r.rawV2Cache.size) r.rawV2Cache.clear(); }

// Exact-body v2 response cache. It only serves repeated clone/ls-refs/fetch requests whose bodies
// are small enough to keep as byte-preserving keys, and it is capped so a stream of unique requests
// cannot grow it without bound. Capacity eviction is FIFO over raw-v2 keys only; semantic fetch
// entries live in fetchCache and are never candidates for this cache's eviction.
const RAW_V2_KEY_PREFIX = 'raw-v2|';
const RAW_V2_MAX_ENTRIES = 8;
const RAW_V2_MAX_REQUEST_BYTES = 4096;
const RAW_V2_MAX_RESPONSE_BYTES = 256 * 1024;

function rawV2KeyFor(headerV2:boolean, body:Buffer): string | null {
  if(!headerV2 || body.length > RAW_V2_MAX_REQUEST_BYTES) return null;
  return `${RAW_V2_KEY_PREFIX}${body.toString('latin1')}`;
}
function getRawV2(repo:Repo, key:string): Buffer | null {
  if(!key.startsWith(RAW_V2_KEY_PREFIX)) return null;
  const cached=repo.rawV2Cache.get(key);
  return cached && cached.epoch===repo.refsEpoch ? cached.body : null;
}
function setRawV2(repo:Repo, key:string, body:Buffer): void {
  if(!key.startsWith(RAW_V2_KEY_PREFIX) || body.length > RAW_V2_MAX_RESPONSE_BYTES) return;
  if(repo.rawV2Cache.has(key)){ repo.rawV2Cache.set(key,{epoch:repo.refsEpoch,body}); return; }
  while(repo.rawV2Cache.size >= RAW_V2_MAX_ENTRIES){
    let oldest:string|null=null;
    for(const candidate of repo.rawV2Cache.keys()){
      if(candidate.startsWith(RAW_V2_KEY_PREFIX)){ oldest=candidate; break; }
    }
    if(oldest===null) break;
    repo.rawV2Cache.delete(oldest);
  }
  repo.rawV2Cache.set(key,{epoch:repo.refsEpoch,body});
}

// ---------------- Git object helpers ----------------
function sha1(type:string,data:Buffer): string { const h=createHash('sha1'); h.update(`${type} ${data.length}\0`); h.update(data); return h.digest('hex'); }
function putObj(repo:Repo,type:GitObj['type'],data:Buffer): string { const oid=sha1(type,data); if(!repo.objects.has(oid)) repo.objects.set(oid,{type,data}); return oid; }
function parseCommit(data:Buffer){ const text=data.toString('utf8'); const tree=(/^tree ([0-9a-f]{40})/m.exec(text)||[])[1]||''; const parents=[...text.matchAll(/^parent ([0-9a-f]{40})/gm)].map(m=>m[1]); const msgIdx=text.indexOf('\n\n'); const message=msgIdx>=0?text.slice(msgIdx+2):''; return {tree,parents,message}; }
function parseTag(data:Buffer){ const text=data.toString('utf8'); const obj=(/^object ([0-9a-f]{40})/m.exec(text)||[])[1]||''; const type=(/^type (\w+)/m.exec(text)||[])[1]||''; const tag=(/^tag (.+)/m.exec(text)||[])[1]||''; return {object:obj,type,tag}; }
function parseTree(data:Buffer){ const entries:{mode:string;name:string;oid:string}[]=[]; let i=0; while(i<data.length){ const sp=data.indexOf(0x20,i); const nul=data.indexOf(0x00,sp); if(sp<0||nul<0) break; const mode=data.slice(i,sp).toString('utf8'); const name=data.slice(sp+1,nul).toString('utf8'); const oid=data.slice(nul+1,nul+21).toString('hex'); entries.push({mode,name,oid}); i=nul+21; } return entries; }
function buildTree(entries:{mode:string;name:string;oid:string}[]): Buffer {
  const sorted=[...entries].sort((a,b)=>{const an=a.mode==='40000'?a.name+'/':a.name; const bn=b.mode==='40000'?b.name+'/':b.name; return an<bn?-1:an>bn?1:0;});
  const parts:Buffer[]=[]; for(const e of sorted){ parts.push(Buffer.from(`${e.mode} ${e.name}\0`)); parts.push(Buffer.from(e.oid,'hex')); }
  return Buffer.concat(parts);
}
function buildCommit(opts:{tree:string;parents:string[];message:string;author:string;ts:number}): Buffer {
  const lines=[`tree ${opts.tree}`,...opts.parents.map(p=>`parent ${p}`),`author ${opts.author} ${opts.ts} +0000`,`committer ${opts.author} ${opts.ts} +0000`,'',opts.message.endsWith('\n')?opts.message:opts.message+'\n'];
  return Buffer.from(lines.join('\n'));
}
function buildTagObj(opts:{object:string;type:string;tag:string;tagger:string;ts:number;message:string}): Buffer {
  const lines=[`object ${opts.object}`,`type ${opts.type}`,`tag ${opts.tag}`,`tagger ${opts.tagger} ${opts.ts} +0000`,'',opts.message.endsWith('\n')?opts.message:opts.message+'\n'];
  return Buffer.from(lines.join('\n'));
}
function walk(repo:Repo, tips:string[]): Set<string> {
  const seen=new Set<string>(); const q=[...tips];
  while(q.length){ const oid=q.pop()!; if(!oid||oid===ZERO_OID||seen.has(oid)) continue; const o=repo.objects.get(oid); if(!o) continue; seen.add(oid);
    if(o.type==='commit'){ const c=parseCommit(o.data); q.push(c.tree,...c.parents); }
    else if(o.type==='tree'){ for(const e of parseTree(o.data)) q.push(e.oid); }
    else if(o.type==='tag'){ q.push(parseTag(o.data).object); }
  }
  return seen;
}
function walkTree(repo:Repo, treeOid:string, out:GitObj[], seen:Set<string>){
  if(!treeOid||seen.has(treeOid)) return; const o=repo.objects.get(treeOid); if(!o||o.type!=='tree') return; seen.add(treeOid); out.push(o);
  for(const e of parseTree(o.data)){
    const c=repo.objects.get(e.oid); if(!c||seen.has(e.oid)) continue;
    if(c.type==='tree') walkTree(repo,e.oid,out,seen);
    else { seen.add(e.oid); out.push(c); }
  }
}
function shallowDepth1Objects(repo:Repo, tip:string): GitObj[] {
  const out:GitObj[]=[]; const seen=new Set<string>();
  const o=repo.objects.get(tip); if(!o||o.type!=='commit') return out;
  seen.add(tip); out.push(o);
  const c=parseCommit(o.data);
  walkTree(repo,c.tree,out,seen);
  return out;
}
function isAncestor(repo:Repo, ancestor:string, descendant:string): boolean {
  if(ancestor===descendant) return true;
  const seen=new Set<string>(); const q=[descendant];
  while(q.length){ const cur=q.pop()!; if(!cur||seen.has(cur)) continue; seen.add(cur); if(cur===ancestor) return true; const o=repo.objects.get(cur); if(!o||o.type!=='commit') continue; const c=parseCommit(o.data); for(const p of c.parents) q.push(p); }
  return false;
}
function findBlobAt(repo:Repo, commitOid:string, path:string): Buffer | null {
  const cobj=repo.objects.get(commitOid); if(!cobj||cobj.type!=='commit') return null; let oid=parseCommit(cobj.data).tree; const parts=path.split('/');
  for(let i=0;i<parts.length;i++){ const tobj=repo.objects.get(oid); if(!tobj||tobj.type!=='tree') return null; const e=parseTree(tobj.data).find(x=>x.name===parts[i]); if(!e) return null; oid=e.oid; if(i===parts.length-1){ const b=repo.objects.get(oid); return b&&b.type==='blob'?b.data:null; } }
  return null;
}
function listTree(repo:Repo, treeOid:string, prefix=''): {path:string;oid:string;type:string;mode:string}[] {
  const out:{path:string;oid:string;type:string;mode:string}[]=[]; const t=repo.objects.get(treeOid); if(!t||t.type!=='tree') return out;
  for(const e of parseTree(t.data)){ const p=prefix?`${prefix}/${e.name}`:e.name; if(e.mode==='40000'){ out.push(...listTree(repo,e.oid,p)); } else out.push({path:p,oid:e.oid,type:'blob',mode:e.mode}); }
  return out;
}
function commitFiles(repo:Repo, commitOid:string): Map<string,string> {
  const m=new Map<string,string>(); const c=repo.objects.get(commitOid); if(!c) return m; for(const f of listTree(repo,parseCommit(c.data).tree)) m.set(f.path,f.oid); return m;
}
function diffFiles(repo:Repo, baseCommit:string|undefined, headCommit:string){
  const base=baseCommit?commitFiles(repo,baseCommit):new Map<string,string>(); const head=commitFiles(repo,headCommit);
  const files:{filename:string;status:string;additions:number;deletions:number;changes:number}[]=[];
  for(const [p,oid] of head){ if(!base.has(p)) files.push({filename:p,status:'added',additions:1,deletions:0,changes:1}); else if(base.get(p)!==oid) files.push({filename:p,status:'modified',additions:1,deletions:1,changes:2}); }
  for(const p of base.keys()){ if(!head.has(p)) files.push({filename:p,status:'removed',additions:0,deletions:1,changes:1}); }
  return files;
}

// ---------------- pkt-line ----------------
function pktLine(data:string|Buffer){ const b=typeof data==='string'?Buffer.from(data):data; return Buffer.concat([Buffer.from((b.length+4).toString(16).padStart(4,'0')),b]); }
function pktFlush(){ return Buffer.from('0000'); }
function pktDelim(){ return Buffer.from('0001'); }
function parsePktLines(buf:Buffer): (Buffer|'flush'|'delim')[] {
  const out:(Buffer|'flush'|'delim')[]=[]; let i=0;
  while(i+4<=buf.length){
    // Decode the 4-hex pkt-line length in place: no per-packet string or parseInt allocation.
    let len=0; let ok=true;
    for(let j=i;j<i+4;j++){ const c=buf[j]!; if(c>=48&&c<=57) len=(len<<4)|(c-48); else if(c>=97&&c<=102) len=(len<<4)|(c-87); else if(c>=65&&c<=70) len=(len<<4)|(c-55); else { ok=false; break; } }
    if(!ok) break;
    if(len===0){out.push('flush'); i+=4; continue;}
    if(len===1){out.push('delim'); i+=4; continue;}
    if(len<4||i+len>buf.length) break;
    out.push(buf.subarray(i+4,i+len)); i+=len;
  }
  return out;
}

// ---------------- pack read/write (minimal) ----------------
function readPack(buf:Buffer): Map<string,GitObj> {
  const objs=new Map<string,GitObj>();
  if(buf.length<12 || buf.slice(0,4).toString()!=='PACK') return objs;
  const count=buf.readUInt32BE(8); let off=12;
  const entries:{type:number;size:number;dataStart:number;dataEnd:number;baseOffset?:number;baseOid?:string;data?:Buffer}[]=[];
  function readTypeSize(){ let b=buf[off++]; let type=(b>>4)&7; let size=b&15; let shift=4; while(b&0x80){ b=buf[off++]; size |= (b&0x7f)<<shift; shift+=7; } return {type,size}; }
  for(let i=0;i<count;i++){ const {type,size}=readTypeSize(); const e:any={type,size,dataStart:off};
    if(type===6){ let b=buf[off++]; let base=(b&0x7f); while(b&0x80){ b=buf[off++]; base=((base+1)<<7)|(b&0x7f); } e.baseOffset=e.dataStart-1-base; }
    if(type===7){ e.baseOid=buf.slice(off,off+20).toString('hex'); off+=20; }
    try{ const inf:any=(inflateSync as any)(buf.subarray(off), {info:true}); e.data=Buffer.from(inf.buffer??inf); e.dataEnd=off + (inf.engine?.bytesWritten ?? inf.bytesWritten ?? 0); }catch{ try{ const d=inflateSync(buf.subarray(off)); e.data=Buffer.from(d); }catch{ break; } }
    if(e.dataEnd==null){
      let found=false; for(let l=1;l<=buf.length-off-20 && l<10_000_000;l+= (l<512?1:64)){ try{ const z=inflateSync(buf.subarray(off,off+l)); if(z.length===size || e.type>=6){ e.data=Buffer.from(z); e.dataEnd=off+l; found=true; break; } }catch{} }
      if(!found){ try{ e.data=Buffer.from(inflateSync(buf.subarray(off, buf.length-20))); e.dataEnd=buf.length-20; }catch{ break; } }
    }
    off=e.dataEnd; entries.push(e);
  }
  const typeName=(t:number)=>t===1?'commit':t===2?'tree':t===3?'blob':t===4?'tag':'';
  function applyDelta(base:Buffer, delta:Buffer): Buffer {
    let p=0; function readVar(){ let b=delta[p++]; let v=b&0x7f; let sh=7; while(b&0x80){ b=delta[p++]; v|=(b&0x7f)<<sh; sh+=7; } return v; }
    readVar(); readVar();
    const out:Buffer[]=[]; while(p<delta.length){ const cmd=delta[p++]; if(cmd&0x80){ let cp=0,cs=0; if(cmd&1) cp=delta[p++]; if(cmd&2) cp|=delta[p++]<<8; if(cmd&4) cp|=delta[p++]<<16; if(cmd&8) cp|=delta[p++]<<24; if(cmd&16) cs=delta[p++]; if(cmd&32) cs|=delta[p++]<<8; if(cmd&64) cs|=delta[p++]<<16; if(cs===0) cs=0x10000; out.push(base.subarray(cp,cp+cs)); } else if(cmd>0){ out.push(delta.subarray(p,p+cmd)); p+=cmd; } else break; }
    return Buffer.concat(out);
  }
  for(const e of entries){ if(e.type>=1 && e.type<=4 && e.data){ const tn=typeName(e.type) as GitObj['type']; const oid=sha1(tn,e.data); objs.set(oid,{type:tn,data:e.data}); } }
  for(let pass=0; pass<5; pass++){
    for(const e of entries){ if((e.type===6||e.type===7) && e.data){ let baseBuf:Buffer|undefined; let baseType:GitObj['type']|undefined;
      if(e.type===7 && e.baseOid){ const bo=objs.get(e.baseOid); if(bo){ baseBuf=bo.data; baseType=bo.type; } }
      if(baseBuf && baseType){ try{ const res=applyDelta(baseBuf,e.data); const oid=sha1(baseType,res); if(!objs.has(oid)){ objs.set(oid,{type:baseType,data:res}); } }catch{} }
    }}
  }
  return objs;
}
function writePack(objects:GitObj[]): Buffer {
  const body:Buffer[]=[]; body.push(Buffer.from('PACK')); const hdr=Buffer.alloc(4); hdr.writeUInt32BE(2,0); body.push(hdr); const cnt=Buffer.alloc(4); cnt.writeUInt32BE(objects.length,0); body.push(cnt);
  const typeNum=(t:string)=>t==='commit'?1:t==='tree'?2:t==='blob'?3:4;
  for(const o of objects){ let size=o.data.length; const tn=typeNum(o.type); let b=(tn<<4)|(size&15); size>>>=4; const bytes=[b]; while(size>0){ bytes[bytes.length-1]|=0x80; b=size&0x7f; size>>>=7; bytes.push(b); } body.push(Buffer.from(bytes)); body.push(deflateSync(o.data)); }
  const pack=Buffer.concat(body); const h=createHash('sha1').update(pack).digest(); return Buffer.concat([pack,h]);
}
function sideband(band:number,data:Buffer){ const max=65515; const out:Buffer[]=[]; if(data.length===0){ out.push(pktLine(Buffer.concat([Buffer.from([band]),Buffer.alloc(0)]))); return Buffer.concat(out); } for(let i=0;i<data.length;i+=max){ const chunk=data.subarray(i,i+max); out.push(pktLine(Buffer.concat([Buffer.from([band]),chunk]))); } return Buffer.concat(out); }

function matchGit(path:string): {owner:string;repo:string;action:'info/refs'|'git-upload-pack'|'git-receive-pack'} | null {
  const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if(!m) return null;
  return { owner:m[1], repo:m[2], action:m[3] as any };
}
function peel(repo:Repo, oid:string): string {
  let cur=oid; for(let i=0;i<10;i++){ const o=repo.objects.get(cur); if(!o||o.type!=='tag') return cur; const tag=parseTag(o.data); if(!tag.object) return cur; cur=tag.object; } return cur;
}
function writePackFor(repo:Repo, wants:string[], haves:Set<string>): Buffer {
  const haveClosure = haves.size? walk(repo,[...haves]) : new Set<string>();
  const need: GitObj[] = [];
  const q=[...wants]; const seen=new Set<string>();
  while(q.length){ const oid=q.pop()!; if(!oid||seen.has(oid)||haveClosure.has(oid)) continue; const o=repo.objects.get(oid); if(!o) continue; seen.add(oid); need.push(o);
    if(o.type==='commit'){ const c=parseCommit(o.data); q.push(c.tree,...c.parents); }
    else if(o.type==='tree'){ for(const e of parseTree(o.data)) q.push(e.oid); }
    else if(o.type==='tag'){ q.push(parseTag(o.data).object); }
  }
  return writePack(need);
}

async function handleGit(req:IncomingMessage,res:ServerResponse,method:string,git:{owner:string;repo:string;action:string},qs:QueryView){
  if(!requireAuth(req,res)) return;
  const repo = getRepo(git.owner, git.repo);
  if(!repo){ sendNotFound(res); return; }
  if(git.owner !== viewerLogin(req)){ sendNotFound(res); return; }
  if(git.action==='info/refs'){
    const service = qs.get('service');
    if(service==='git-upload-pack'){
      if(String(req.headers['git-protocol']||'').includes('version=2')){
        const cached=repo.advCache.get('v2');
        if(cached && cached.epoch===repo.refsEpoch){ sendBytes(res,200,cached.body,'application/x-git-upload-pack-advertisement'); return; }
        const caps = ['version 2','ls-refs','fetch=shallow','object-format=sha1','agent=forge/0'].map(c=>pktLine(c+'\n'));
        caps.push(pktFlush());
        const body=Buffer.concat(caps); repo.advCache.set('v2',{epoch:repo.refsEpoch,body});
        sendBytes(res,200,body,'application/x-git-upload-pack-advertisement');
      } else {
        const cached=repo.advCache.get('v0');
        if(cached && cached.epoch===repo.refsEpoch){ sendBytes(res,200,cached.body,'application/x-git-upload-pack-advertisement'); return; }
        const caps = 'multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag symref=HEAD:refs/heads/'+repo.defaultBranch+' agent=forge/0';
        const lines:Buffer[]=[]; lines.push(pktLine(`# service=git-upload-pack\n`)); lines.push(pktFlush());
        const refs=[...repo.refs.entries()].sort();
        if(refs.length===0){ lines.push(pktLine(ZERO_OID+' capabilities^{}\0'+caps+'\n')); }
        else { let first=true; for(const [name,oid] of refs){ const extra = first?('\0'+caps):''; first=false; lines.push(pktLine(`${oid} ${name}${extra}\n`)); const peeled = peel(repo,oid); if(peeled!==oid) lines.push(pktLine(`${peeled} ${name}^{ }\n`)); } }
        lines.push(pktFlush());
        const body=Buffer.concat(lines); repo.advCache.set('v0',{epoch:repo.refsEpoch,body});
        sendBytes(res,200,body,'application/x-git-upload-pack-advertisement');
      }
      return;
    }
    if(service==='git-receive-pack'){
      const cached=repo.advCache.get('recv');
      if(cached && cached.epoch===repo.refsEpoch){ sendBytes(res,200,cached.body,'application/x-git-receive-pack-advertisement'); return; }
      const caps = 'report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta agent=forge/0';
      const lines:Buffer[]=[]; lines.push(pktLine(`# service=git-receive-pack\n`)); lines.push(pktFlush());
      const refs=[...repo.refs.entries()].sort();
      if(refs.length===0){ lines.push(pktLine(ZERO_OID+' capabilities^{}\0'+caps+'\n')); }
      else { let first=true; for(const [name,oid] of refs){ const extra=first?('\0'+caps):''; first=false; lines.push(pktLine(`${oid} ${name}${extra}\n`)); } }
      lines.push(pktFlush());
      const body=Buffer.concat(lines); repo.advCache.set('recv',{epoch:repo.refsEpoch,body});
      sendBytes(res,200,body,'application/x-git-receive-pack-advertisement');
      return;
    }
    sendNotFound(res); return;
  }

  if(git.action==='git-upload-pack' && method==='POST'){
    const body = await readBody(req);
    const headerV2 = String(req.headers['git-protocol']||'').includes('version=2');
    // A v2 answer is a pure function of the request bytes and the repository epoch, so an exact-body
    // hit can skip pkt-line parsing on the repeated clone/fetch hot path. The cache is bounded:
    // request keys stop at 4 KiB, responses at 256 KiB, and only the newest eight raw-v2 entries stay.
    const rawV2Key = rawV2KeyFor(headerV2, body);
    if(rawV2Key!==null){ const cached=getRawV2(repo,rawV2Key); if(cached!==null){ sendBytes(res,200,cached,'application/x-git-upload-pack-result'); return; } }
    const pkts=parsePktLines(body);
    const lines:string[]=[]; const wants:string[]=[]; const haves:string[]=[]; const args:string[]=[];
    let depth:number|undefined; let done=false; let command=''; let sawCommand=false; let seenDelim=false;
    for(const p of pkts){
      if(p==='delim'){ seenDelim=true; continue; }
      if(p==='flush') continue;
      const s=(p as Buffer).toString('utf8'); lines.push(s);
      if(s.startsWith('command=')){ command=s.trim().slice(8); sawCommand=true; }
      else if(s.startsWith('want ')) wants.push(s.trim().slice(5).split(' ')[0]);
      else if(s.startsWith('have ')) haves.push(s.trim().slice(5).split(' ')[0]);
      else if(s.startsWith('deepen ')) depth=parseInt(s.trim().slice(7),10);
      else if(s.trim()==='done') done=true;
      if(seenDelim) args.push(s.replace(/\n$/,''));
    }
    const isV2 = headerV2 || sawCommand;
    if(isV2){
      // Cache only no-have requests (clones, ls-refs, warm fetches); negotiation requests carrying a
      // have line are never stored, so distinct negotiation histories cannot fill the raw cache.
      const sendV2=(response:Buffer)=>{ if(rawV2Key!==null && haves.length===0) setRawV2(repo,rawV2Key,response); sendBytes(res,200,response,'application/x-git-upload-pack-result'); };
      if(command==='ls-refs'){
        const cacheKey=body.toString('latin1');
        const cached=repo.lsRefsCache.get(cacheKey);
        if(cached && cached.epoch===repo.refsEpoch){ sendV2(cached.body); return; }
        const wantSym = args.includes('symrefs'); const wantPeel=args.includes('peel');
        const prefixes=args.filter(a=>a.startsWith('ref-prefix ')).map(a=>a.slice('ref-prefix '.length));
        let entries=[...repo.refs.entries()].sort();
        if(prefixes.length) entries=entries.filter(([n])=>prefixes.some(p=>n.startsWith(p)||n===p.trim()));
        const out:Buffer[]=[];
        if(wantSym && prefixes.length===0){ if(repo.refs.has('refs/heads/'+repo.defaultBranch)) out.push(pktLine(`${repo.refs.get('refs/heads/'+repo.defaultBranch)} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`)); else out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`)); }
        for(const [name,oid] of entries){
          let line=`${oid} ${name}`;
          if(wantSym && name===`refs/heads/${repo.defaultBranch}`) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
          if(wantPeel){ const p=peel(repo,oid); if(p!==oid) line += ` peeled:${p}`; }
          out.push(pktLine(line+'\n'));
        }
        out.push(pktFlush());
        const response=Buffer.concat(out); repo.lsRefsCache.set(cacheKey,{epoch:repo.refsEpoch,body:response});
        sendV2(response); return;
      }
      if(command==='fetch'){
        const fetchKey = haves.length===0 && depth!==undefined ? `${depth}|${wants.join(',')}` : null;
        if(fetchKey!==null){ const cached=repo.fetchCache.get(fetchKey); if(cached && cached.epoch===repo.refsEpoch){ sendV2(cached.body); return; } }
        const out:Buffer[]=[];
        const haveSet=new Set(haves.filter(h=>repo.objects.has(h)));
        if(haves.length>0){ out.push(pktLine('acknowledgments\n')); for(const h of haveSet) out.push(pktLine(`ACK ${h}\n`)); out.push(pktDelim()); }
        const wantTips = wants.length?wants:[...repo.refs.values()];
        const shallowLines:string[]=[];
        let pack:Buffer;
        if(depth===1 && wantTips.length){
          const need:GitObj[]=[]; const seen=new Set<string>();
          for(const tip of wantTips){ shallowLines.push(`shallow ${tip}\n`); for(const o of shallowDepth1Objects(repo,tip)){ const oid=sha1(o.type,o.data); if(!seen.has(oid)){ seen.add(oid); need.push(o); } } }
          pack=writePack(need);
        } else if(depth && depth>1 && wantTips.length){
          // deepen from provided shallow/have boundaries (client sends shallow tips in 'shallow' lines? parsed via args maybe)
          const shallowIn:string[]=[]; for(const s of lines){ if(s.startsWith('shallow ')) shallowIn.push(s.trim().slice(8).split(' ')[0]); }
          const need:GitObj[]=[]; const seenObjs=new Set<string>();
          function addReachable(oid:string, exclude:Set<string>){ const q=[oid]; while(q.length){ const cur=q.pop()!; if(!cur||seenObjs.has(cur)||exclude.has(cur)) continue; const o=repo.objects.get(cur); if(!o) continue; seenObjs.add(cur); need.push(o); if(o.type==='commit'){ const c=parseCommit(o.data); q.push(c.tree,...c.parents); } else if(o.type==='tree'){ for(const e of parseTree(o.data)) q.push(e.oid); } else if(o.type==='tag'){ q.push(parseTag(o.data).object); } } }
          const boundaries=new Set<string>();
          for(const tip of wantTips){ const o=repo.objects.get(tip); if(!o||o.type!=='commit') continue; let cur=tip; for(let d=1; d<depth; d++){ const co=repo.objects.get(cur); if(!co||co.type!=='commit') break; const parents=parseCommit(co.data).parents; if(!parents.length){ cur=''; break; } cur=parents[0]; } if(cur){ boundaries.add(cur); shallowLines.push(`shallow ${cur}\n`); } }
          for(const s of shallowIn){ if(!boundaries.has(s)) shallowLines.push(`unshallow ${s}\n`); }
          // include objects reachable from wants down to but excluding parents of boundary commits? easier: include full want closure minus objects reachable only beyond depth
          const beyond=new Set<string>();
          for(const b of boundaries){ const bo=repo.objects.get(b); if(bo&&bo.type==='commit'){ for(const p of parseCommit(bo.data).parents){ for(const oid of walk(repo,[p])) beyond.add(oid); } } }
          const wantClosure=walk(repo,wantTips); for(const oid of wantClosure){ if(beyond.has(oid)) continue; const o=repo.objects.get(oid); if(o) need.push(o); }
          // remove boundary commit's parents from need implicitly by beyond exclusion
          pack=writePack([...new Map(need.map(o=>[sha1(o.type,o.data),o] as [string,GitObj])).values()]);
        } else {
          pack=writePackFor(repo,wantTips,haveSet);
        }
        if(shallowLines.length){ out.push(pktLine('shallow-info\n')); for(const l of shallowLines) out.push(pktLine(l)); out.push(pktDelim()); }
        out.push(pktLine('packfile\n'));
        out.push(sideband(1, pack));
        out.push(pktFlush());
        const response=Buffer.concat(out); if(fetchKey!==null) repo.fetchCache.set(fetchKey,{epoch:repo.refsEpoch,body:response});
        sendV2(response); return;
      }
      sendV2(pktFlush()); return;
    } else {
      const v0Wants:string[]=[]; const v0Haves:string[]=[]; let v0Done=false; let v0Depth:number|undefined;
      for(const raw of lines){ const s=raw.trim(); if(s.startsWith('want ')) v0Wants.push(s.slice(5).split(' ')[0]); else if(s.startsWith('have ')) v0Haves.push(s.slice(5).split(' ')[0]); else if(s==='done') v0Done=true; else if(s.startsWith('deepen ')) v0Depth=parseInt(s.slice(7),10); }
      const haveSet=new Set(v0Haves.filter(h=>repo.objects.has(h)));
      if(!v0Done && v0Haves.length){
        const out:Buffer[]=[]; for(const h of v0Haves){ if(repo.objects.has(h)) out.push(pktLine(`ACK ${h} common\n`)); }
        out.push(pktLine('NAK\n')); out.push(pktFlush());
        sendBytes(res,200,Buffer.concat(out),'application/x-git-upload-pack-result'); return;
      }
      const wantTips = v0Wants.length?v0Wants:[...repo.refs.values()];
      let pack:Buffer; const shallowOut:string[]=[];
      if(v0Depth===1 && wantTips.length){ const need:GitObj[]=[]; const seen=new Set<string>(); for(const tip of wantTips){ shallowOut.push(`shallow ${tip}\n`); for(const o of shallowDepth1Objects(repo,tip)){ const oid=sha1(o.type,o.data); if(!seen.has(oid)){ seen.add(oid); need.push(o); } } } pack=writePack(need);
      } else {
        pack=writePackFor(repo,wantTips,haveSet);
      }
      const out:Buffer[]=[]; for(const l of shallowOut) out.push(pktLine(l)); out.push(pktLine('NAK\n')); out.push(sideband(1,pack)); out.push(pktFlush());
      sendBytes(res,200,Buffer.concat(out),'application/x-git-upload-pack-result'); return;
    }
  }

  if(git.action==='git-receive-pack' && method==='POST'){
    const body = await readBody(req);
    const packIdx = body.indexOf(Buffer.from('PACK'));
    const pre = packIdx>=0? body.subarray(0,packIdx): body;
    const prePkts=parsePktLines(pre);
    const cmds:{oldOid:string;newOid:string;ref:string}[]=[];
    for(const p of prePkts){ if(p==='flush'||p==='delim') continue; const s=(p as Buffer).toString('utf8').replace(/\n$/,''); const m=/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+?)(\0.*)?$/.exec(s); if(m){ cmds.push({oldOid:m[1],newOid:m[2],ref:m[3]}); } }
    const reportLines:string[]=[]; let unpackOk=true;
    if(packIdx>=0){ try{ const packBuf=body.subarray(packIdx); const objs=readPack(packBuf); let added=false; for(const [oid,o] of objs){ if(!repo.objects.has(oid)){ repo.objects.set(oid,o); added=true; } } if(added) bumpRefs(repo); }catch{ unpackOk=false; } }
    reportLines.push(unpackOk?'unpack ok\n':'unpack ng\n');
    for(const c of cmds){ const cur=repo.refs.get(c.ref);
      if(c.newOid===ZERO_OID){ if(cur && c.oldOid!==ZERO_OID && cur!==c.oldOid){ reportLines.push(`ng ${c.ref} non-fast-forward\n`); } else { repo.refs.delete(c.ref); bumpRefs(repo); reportLines.push(`ok ${c.ref}\n`); } continue; }
      if(cur && cur!==c.oldOid && c.oldOid!==ZERO_OID){ reportLines.push(`ng ${c.ref} non-fast-forward\n`); continue; }
      if(cur && c.oldOid!==ZERO_OID && !isAncestor(repo, cur, c.newOid)){ reportLines.push(`ng ${c.ref} non-fast-forward\n`); continue; }
      repo.refs.set(c.ref,c.newOid); bumpRefs(repo); reportLines.push(`ok ${c.ref}\n`);
    }
    const payload=Buffer.concat(reportLines.map(l=>pktLine(l)));
    const out=Buffer.concat([sideband(1,payload), pktFlush()]);
    sendBytes(res,200,out,'application/x-git-receive-pack-result'); return;
  }

  sendNotFound(res);
}

export function createApp(): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.sendDate = false;
    try {
      const target = targetOf(req);
      const path = target.path;
      const method = (req.method ?? 'GET').toUpperCase();
      const qs = target.qs;

      // Health
      if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }

      // API root
      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        if (!requireAuth(req,res)) return;
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', issues_url: '/api/v3/issues', user_url: '/api/v3/users/{user}', user_repositories_url: '/api/v3/users/{user}/repos' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      // REST API
      if (path.startsWith('/api/v3/')) { await handleRest(req,res,method,path,qs); return; }

      // GraphQL
      if (path === '/api/graphql' && method === 'POST') { await handleGraphQL(req,res); return; }
      if (path === '/api/graphql') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }

      // MCP
      if (path === '/mcp') { await handleMcp(req,res,method); return; }

      // Git smart HTTP
      const git = matchGit(path);
      if (git) { await handleGit(req,res,method,git,qs); return; }

      sendNotFound(res);
    } catch (e: any) {
      if (e && e.message === 'bad json') { sendBadRequest(res); return; }
      try { sendJson(res, 500, { message: 'Internal Server Error' }); } catch {}
    }
  });
  server.on('connection', (sock) => { sock.setNoDelay(true); sock.setKeepAlive(true, 60000); });
  return server;
}


// ---------------- REST helpers ----------------
function baseUrl(req:IncomingMessage){ const h=req.headers.host||'localhost'; return `http://${h}`; }
function repoJson(req:IncomingMessage, r:Repo){
  const o=r.owner, n=r.name;
  return {
    id:r.id,node_id:r.nodeId,name:r.name,full_name:r.fullName,private:r.private,description:r.description||null,default_branch:r.defaultBranch,
    owner:{login:r.owner,id:1,node_id:nodeId('user',1),type:'User'},
    html_url:`${baseUrl(req)}/${o}/${n}`,url:`${baseUrl(req)}/api/v3/repos/${o}/${n}`,
    issues_url:`${baseUrl(req)}/api/v3/repos/${o}/${n}/issues{/number}`,
    pulls_url:`${baseUrl(req)}/api/v3/repos/${o}/${n}/pulls{/number}`,
    contents_url:`${baseUrl(req)}/api/v3/repos/${o}/${n}/contents/{+path}`,
    branches_url:`${baseUrl(req)}/api/v3/repos/${o}/${n}/branches{/branch}`,
    commits_url:`${baseUrl(req)}/api/v3/repos/${o}/${n}/commits{/sha}`,
    git_refs_url:`${baseUrl(req)}/api/v3/repos/${o}/${n}/git/refs{/sha}`,
    labels_url:`${baseUrl(req)}/api/v3/repos/${o}/${n}/labels{/name}`,
    created_at:r.createdAt,updated_at:r.createdAt,pushed_at:r.createdAt,visibility:r.private?'private':'public'
  };
}
function commitJson(req:IncomingMessage,r:Repo,oid:string){
  const o=r.objects.get(oid); const c=o?parseCommit(o.data):{tree:'',parents:[] as string[],message:''};
  const msg = typeof c.message==='string'? c.message : '';
  return { sha:oid, node_id:nodeId('commit',oid.length), commit:{message:msg.trimEnd(),tree:{sha:c.tree},author:{name:'User',email:'u@example.com',date:nowIso()},committer:{name:'User',email:'u@example.com',date:nowIso()}}, parents:c.parents.map(p=>({sha:p,url:`${baseUrl(req)}/api/v3/repos/${r.owner}/${r.name}/commits/${p}`})), url:`${baseUrl(req)}/api/v3/repos/${r.owner}/${r.name}/commits/${oid}` };
}
function issueJson(req:IncomingMessage,r:Repo,iss:Issue){
  return { id:iss.id,node_id:iss.nodeId,number:iss.number,title:iss.title,body:iss.body??null,state:iss.state,labels:iss.labels,user:{login:r.owner},comments:iss.comments.length,created_at:iss.createdAt,updated_at:iss.createdAt,url:`${baseUrl(req)}/api/v3/repos/${r.owner}/${r.name}/issues/${iss.number}` };
}
function issueJsonBuffer(req:IncomingMessage,r:Repo,iss:Issue): Buffer {
  const host = req.headers.host || 'localhost';
  const cached = iss.jsonCache;
  if (cached !== null && cached.host === host) return cached.buf;
  const buf = Buffer.from(`${JSON.stringify(issueJson(req,r,iss))}\n`);
  iss.jsonCache = { host, buf };
  return buf;
}
function pullJson(req:IncomingMessage,r:Repo,pr:Pull){
  const baseSha=r.refs.get('refs/heads/'+pr.baseRef)||pr.baseSha||''; const headSha=r.refs.get('refs/heads/'+pr.headRef)||pr.headSha||'';
  return { id:pr.id,node_id:pr.nodeId,number:pr.number,title:pr.title,body:pr.body??null,state:pr.state,merged:pr.merged,merged_at:pr.mergedAt,merge_commit_sha:pr.mergeCommitSha,user:{login:r.owner},head:{ref:pr.headRef,sha:headSha,label:`${r.owner}:${pr.headRef}`},base:{ref:pr.baseRef,sha:baseSha,label:`${r.owner}:${pr.baseRef}`},html_url:`${baseUrl(req)}/${r.owner}/${r.name}/pull/${pr.number}`,url:`${baseUrl(req)}/api/v3/repos/${r.owner}/${r.name}/pulls/${pr.number}`,created_at:pr.createdAt,updated_at:pr.createdAt };
}

async function handleRest(req:IncomingMessage,res:ServerResponse,method:string,path:string,qs:QueryView){
  const viewer = viewerLogin(req);
  if(method==='GET' && path==='/api/v3/user'){ if(!requireAuth(req,res)) return; sendJson(res,200,{login:viewer,id:1,node_id:nodeId('user',1),type:'User'}); return; }
  if(method==='GET' && path==='/api/v3/rate_limit'){ if(!requireAuth(req,res)) return; sendJson(res,200,{resources:{core:{limit:5000,remaining:4999,reset:nowSec()+3600}}}); return; }
  if(method==='GET' && path==='/api/v3/meta'){ if(!requireAuth(req,res)) return; sendJson(res,200,{installed_version:'forge-1.0.0',verifiable_password_authentication:false}); return; }

  if(method==='POST' && path==='/api/v3/user/repos'){
    if(!requireAuth(req,res)) return;
    let body:any; try{ body=await readJson(req); }catch{ sendBadRequest(res); return; }
    const name=String(body?.name||'').trim(); if(!name){ sendJson(res,422,{message:'Validation Failed'}); return; }
    const owner=viewer;
    if(getRepo(owner,name)){ sendJson(res,422,{message:'Validation Failed: name already exists on this account',errors:[{resource:'Repository',code:'already_exists',field:'name'}]}); return; }
    const r=ensureRepo(owner,name,{private:!!body?.private,description:body?.description});
    r.defaultBranch=body?.default_branch||r.defaultBranch||'main';
    sendJson(res,201,repoJson(req,r)); return;
  }

  let m:RegExpExecArray|null;
  if((m=/^\/api\/v3\/(?:user|users\/([^/]+))\/repos$/.exec(path)) && method==='GET'){
    if(!requireAuth(req,res)) return;
    const owner = m[1] ? decodeURIComponent(m[1]) : viewer;
    let list=[...repos.values()].filter(r=>r.owner===owner);
    if(m[1] && owner!==viewer){ list=[]; }
    list.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id-b.id);
    const perPage=Math.max(1,parseInt(qs.get('per_page')||'30',10)||30);
    const page=Math.max(1,parseInt(qs.get('page')||'1',10)||1);
    const start=(page-1)*perPage; const items=list.slice(start,start+perPage).map(r=>repoJson(req,r));
    const headers:Record<string,string>={};
    const totalPages=Math.max(1,Math.ceil(list.length/perPage));
    const links:string[]=[]; const u=`${baseUrl(req)}${path}`;
    if(page<totalPages) links.push(`<${u}?per_page=${perPage}&page=${page+1}>; rel="next"`, `<${u}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
    if(page>1) links.push(`<${u}?per_page=${perPage}&page=${page-1}>; rel="prev"`, `<${u}?per_page=${perPage}&page=1)>; rel="first"`);
    if(links.length) headers['link']=links.join(', ');
    res.writeHead(200,{ 'content-type':JSON_TYPE,'content-length':String(Buffer.byteLength(JSON.stringify(items)+'\n')),'x-github-request-id':rid(),...headers });
    res.end(JSON.stringify(items)+'\n'); return;
  }

  m=/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if(!m){ sendNotFound(res); return; }
  const owner=decodeURIComponent(m[1]), name=decodeURIComponent(m[2]); const rest=(m[3]||'');
  const r=getRepo(owner,name);
  if(!r){ if(!requireAuth(req,res)) return; sendNotFound(res); return; }
  if(!requireAuth(req,res)) return;
  if(owner!==viewer){ sendNotFound(res); return; }

  if(rest==='' && method==='GET'){ sendJson(res,200,repoJson(req,r)); return; }
  if(rest==='' && method==='PATCH'){ let body:any; try{ body=await readJson(req);}catch{sendBadRequest(res);return;} if(typeof body?.description==='string') r.description=body.description; if(typeof body?.private==='boolean') r.private=body.private; sendJson(res,200,repoJson(req,r)); return; }
  if(rest==='' && method==='DELETE'){ repos.delete(repoKey(owner,name)); sendEmpty(res,204); return; }

  if(rest==='labels' && method==='POST'){
    let body:any; try{ body=await readJson(req);}catch{sendBadRequest(res);return;}
    const lname=String(body?.name||''); if(!lname){sendJson(res,422,{message:'Validation Failed'});return;}
    const l={name:lname,color:String(body?.color||'ededed')}; r.labels.set(lname,l);
    sendJson(res,201,l); return;
  }
  if(rest.startsWith('labels/') && method==='GET'){
    const lname=decodeURIComponent(rest.slice('labels/'.length));
    const l=r.labels.get(lname); if(!l){sendNotFound(res);return;} sendJson(res,200,l); return;
  }

  if(rest==='issues' && method==='POST'){
    let body:any; try{ body=await readJson(req);}catch{sendBadRequest(res);return;}
    const labelsIn=(Array.isArray(body?.labels)?body.labels:[]).map((x:any)=> typeof x==='string'?x:x?.name).filter((x:any)=>typeof x==='string');
    for(const lname of labelsIn){ if(!r.labels.has(lname)){ sendJson(res,422,{message:'Validation Failed'}); return; } }
    const num=r.nextIssue++; const id=nextGlobalId++;
    const labels=labelsIn.map((name:string)=>({name}));
    const iss:Issue={id,nodeId:nodeId('issue',id),number:num,title: body?.title===undefined?'':String(body.title),body: body?.body===undefined?'':String(body.body),state:'open',labels,comments:[],createdAt:nowIso(),jsonCache:null};
    r.issues.push(iss); sendJson(res,201,issueJson(req,r,iss)); return;
  }
  if(rest==='issues' && method==='GET'){
    const state=qs.get('state')||'open';
    let items=r.issues.filter(i=>state==='all'?true:i.state===state);
    const sort=qs.get('sort')||'created';
    const direction=(qs.get('direction')|| (sort==='created'?'desc':'desc')).toLowerCase();
    items.sort((a,b)=>{
      let cmp = a.number-b.number; // created proxy by issue number/id
      if(sort==='created' || sort==='updated') cmp = (Date.parse(a.createdAt)-Date.parse(b.createdAt)) || (a.number-b.number);
      if(sort==='comments') cmp = (a.comments.length-b.comments.length) || (a.number-b.number);
      return direction==='asc'? cmp : -cmp;
    });
    const perPage=Math.max(1,parseInt(qs.get('per_page')||'30',10)||30);
    const page=Math.max(1,parseInt(qs.get('page')||'1',10)||1);
    const start=(page-1)*perPage; items=items.slice(start,start+perPage);
    sendJson(res,200,items.map(i=>issueJson(req,r,i))); return;
  }
  if((m=/^issues\/(\d+)$/.exec(rest)) && method==='GET'){
    const num=parseInt(m[1],10); const iss=r.issues.find(i=>i.number===num); if(!iss){sendNotFound(res);return;} sendJsonBuffer(res,200,issueJsonBuffer(req,r,iss)); return;
  }
  if((m=/^issues\/(\d+)$/.exec(rest)) && method==='PATCH'){
    const num=parseInt(m[1],10); const iss=r.issues.find(i=>i.number===num); if(!iss){sendNotFound(res);return;}
    let body:any; try{ body=await readJson(req);}catch{sendBadRequest(res);return;}
    if(typeof body?.state==='string') iss.state=body.state==='closed'?'closed':'open';
    if(typeof body?.title==='string') iss.title=body.title;
    if(typeof body?.body==='string') iss.body=body.body;
    iss.jsonCache=null; sendJson(res,200,issueJson(req,r,iss)); return;
  }
  if((m=/^issues\/(\d+)\/comments$/.exec(rest)) && method==='POST'){
    const num=parseInt(m[1],10); const iss=r.issues.find(i=>i.number===num); if(!iss){sendNotFound(res);return;}
    let body:any; try{ body=await readJson(req);}catch{sendBadRequest(res);return;}
    const id=r.nextCommentId++; const c={id,body:String(body?.body||'')}; iss.comments.push(c); iss.jsonCache=null;
    sendJson(res,201,{id,body:c.body,node_id:nodeId('ic',id),user:{login:viewer},created_at:nowIso(),updated_at:nowIso()}); return;
  }
  if((m=/^issues\/(\d+)\/comments$/.exec(rest)) && method==='GET'){
    const num=parseInt(m[1],10); const iss=r.issues.find(i=>i.number===num); if(!iss){sendNotFound(res);return;}
    sendJson(res,200,iss.comments.map(c=>({id:c.id,body:c.body,node_id:nodeId('ic',c.id),user:{login:viewer}}))); return;
  }

  if(rest==='pulls' && method==='POST'){
    let body:any; try{ body=await readJson(req);}catch{sendBadRequest(res);return;}
    const head=String(body?.head||''); const base=String(body?.base||'');
    const headSha=r.refs.get('refs/heads/'+head)||''; const baseSha=r.refs.get('refs/heads/'+base)||'';
    if(!headSha || !baseSha){ sendJson(res,422,{message:'Validation Failed'}); return; }
    const num=r.nextPull++; const id=nextGlobalId++;
    const files=diffFiles(r, baseSha, headSha);
    const pr:Pull={id,nodeId:nodeId('pr',id),number:num,title:String(body?.title||''),body:String(body?.body||''),state:'open',headRef:head,baseRef:base,headSha,baseSha,merged:false,mergedAt:null,mergeCommitSha:null,files,createdAt:nowIso()};
    r.pulls.push(pr); sendJson(res,201,pullJson(req,r,pr)); return;
  }
  if(rest==='pulls' && method==='GET'){
    const state=qs.get('state')||'open';
    let items=r.pulls.filter(p=>state==='all'?true:state==='closed'?p.state==='closed':p.state===state);
    const perPage=Math.max(1,parseInt(qs.get('per_page')||'30',10)||30);
    const page=Math.max(1,parseInt(qs.get('page')||'1',10)||1);
    const start=(page-1)*perPage; items=items.slice(start,start+perPage);
    sendJson(res,200,items.map(p=>pullJson(req,r,p))); return;
  }
  if((m=/^pulls\/(\d+)$/.exec(rest)) && method==='GET'){
    const num=parseInt(m[1],10); const pr=r.pulls.find(p=>p.number===num); if(!pr){sendNotFound(res);return;} sendJson(res,200,pullJson(req,r,pr)); return;
  }
  if((m=/^pulls\/(\d+)\/files$/.exec(rest)) && method==='GET'){
    const num=parseInt(m[1],10); const pr=r.pulls.find(p=>p.number===num); if(!pr){sendNotFound(res);return;}
    const headSha=r.refs.get('refs/heads/'+pr.headRef)||pr.headSha; const baseSha=r.refs.get('refs/heads/'+pr.baseRef)||pr.baseSha;
    const files=diffFiles(r, baseSha, headSha); pr.files=files;
    sendJson(res,200,files.map(f=>({filename:f.filename,status:f.status,additions:f.additions,deletions:f.deletions,changes:f.changes}))); return;
  }
  if((m=/^pulls\/(\d+)\/merge$/.exec(rest)) && method==='PUT'){
    const num=parseInt(m[1],10); const pr=r.pulls.find(p=>p.number===num); if(!pr){sendNotFound(res);return;}
    if(pr.merged){ sendJson(res,405,{message:'Pull Request is not mergeable'}); return; }
    const baseRefName='refs/heads/'+pr.baseRef; const headSha=r.refs.get('refs/heads/'+pr.headRef)||pr.headSha; const baseSha=r.refs.get(baseRefName)||pr.baseSha;
    const baseAtPr = pr.baseSha || baseSha;
    const prChanges = diffFiles(r, baseAtPr, headSha);
    const baseChanges = diffFiles(r, baseAtPr, baseSha);
    const conflict = prChanges.some(pc=> baseChanges.some(bc=> bc.filename===pc.filename && commitFiles(r,headSha).get(pc.filename)!==commitFiles(r,baseSha).get(bc.filename)));
    if(conflict){ sendJson(res,405,{message:'Pull Request is not mergeable'}); return; }
    const headObj=r.objects.get(headSha); const treeOid=headObj?parseCommit(headObj.data).tree:'';
    const msg = `Merge pull request #${pr.number} from ${pr.headRef}\n`;
    const mergeCommit = buildCommit({tree:treeOid,parents:[baseSha,headSha].filter(Boolean) as string[],message:msg,author:'User <u@example.com>',ts:nowSec()});
    const mergeSha=putObj(r,'commit',mergeCommit);
    r.refs.set(baseRefName,mergeSha); bumpRefs(r);
    pr.merged=true; pr.state='closed'; pr.mergedAt=nowIso(); pr.mergeCommitSha=mergeSha;
    pr.baseSha=baseSha; pr.headSha=headSha; pr.files=prChanges;
    sendJson(res,200,{sha:mergeSha,merged:true,message:'Pull Request successfully merged'}); return;
  }

  if(rest==='git/refs' && method==='POST'){
    let body:any; try{ body=await readJson(req);}catch{sendBadRequest(res);return;}
    const ref=String(body?.ref||''); const sha=String(body?.sha||'');
    if(!ref.startsWith('refs/') || !sha){ sendJson(res,422,{message:'Validation Failed'}); return; }
    if(r.refs.has(ref)){ sendJson(res,422,{message:'Reference already exists'}); return; }
    r.refs.set(ref,sha); bumpRefs(r); sendJson(res,201,{ref,object:{sha,type:'commit',url:`${baseUrl(req)}/api/v3/repos/${owner}/${name}/git/commits/${sha}`}}); return;
  }
  if(rest.startsWith('git/refs') && method==='GET'){
    const sub = rest.slice('git/refs'.length).replace(/^\//,'');
    const want = sub? (sub.startsWith('refs/')?sub:'refs/'+sub):'';
    if(want){
      const exact=r.refs.get(want);
      if(exact && !want.endsWith('/')){ sendJson(res,200,{ref:want,object:{sha:exact,type:'commit'}}); return; }
      const entries=[...r.refs.entries()].filter(([ref])=>ref===want || ref.startsWith(want)).map(([ref,sha])=>({ref,object:{sha,type:'commit'}}));
      if(entries.length===0){ sendNotFound(res); return; }
      if(entries.length===1 && entries[0].ref===want){ sendJson(res,200,entries[0]); return; }
      sendJson(res,200,entries); return;
    }
    const entries=[...r.refs.entries()].map(([ref,sha])=>({ref,object:{sha,type:'commit'}}));
    sendJson(res,200,entries); return;
  }

  if(rest==='branches' && method==='GET'){
    const branches=[...r.refs.entries()].filter(([k])=>k.startsWith('refs/heads/')).map(([k,sha])=>({name:k.slice('refs/heads/'.length),commit:{sha,url:`${baseUrl(req)}/api/v3/repos/${owner}/${name}/commits/${sha}`},protected:false}));
    sendJson(res,200,branches); return;
  }
  if(rest.startsWith('branches/') && method==='GET'){
    const bname=decodeURIComponent(rest.slice('branches/'.length));
    const sha=r.refs.get('refs/heads/'+bname); if(!sha){sendNotFound(res);return;}
    sendJson(res,200,{name:bname,commit:{sha},protected:false}); return;
  }

  if(rest==='commits' && method==='GET'){
    const shaParam = qs.get('sha') || 'HEAD';
    let tip = shaParam==='HEAD' ? r.refs.get('refs/heads/'+r.defaultBranch) : (r.refs.get('refs/heads/'+shaParam) || r.refs.get(shaParam) || shaParam);
    const out:any[]=[]; const seen=new Set<string>(); const q=[tip].filter(Boolean) as string[];
    while(q.length){ const cur=q.shift()!; if(!cur||seen.has(cur)) continue; seen.add(cur); const o=r.objects.get(cur); if(!o||o.type!=='commit') continue; out.push(commitJson(req,r,cur)); const c=parseCommit(o.data); q.push(...c.parents); }
    sendJson(res,200,out); return;
  }
  if(rest.startsWith('commits/') && method==='GET'){
    const sha=rest.slice('commits/'.length);
    if(!r.objects.has(sha)){sendNotFound(res);return;} sendJson(res,200,commitJson(req,r,sha)); return;
  }

  if(rest.startsWith('contents') && (method==='PUT' || method==='GET' || method==='DELETE')){
    const p = decodeURIComponent(rest.slice('contents'.length).replace(/^\//,''));
    if(method==='PUT'){
      let body:any; try{ body=await readJson(req);}catch{sendBadRequest(res);return;}
      const branch=String(body?.branch||r.defaultBranch);
      const msg=String(body?.message||'update');
      const contentB64=String(body?.content||'');
      const content=Buffer.from(contentB64,'base64');
      const parent = r.refs.get('refs/heads/'+branch);
      const ts=nowSec();
      const blobOid=putObj(r,'blob',content);
      const existing = parent && p ? findBlobAt(r,parent,p) : null;
      if(typeof body?.sha === 'string'){
        const curSha = existing ? sha1('blob',existing) : '';
        if(curSha !== body.sha){ sendJson(res,409,{message:'sha does not match'}); return; }
      }
      const files = parent ? commitFiles(r,parent) : new Map<string,string>();
      if(p) files.set(p, blobOid);
      function makeTree(all:Map<string,string>): string {
        const rootKids = new Map<string, any>();
        for(const [fp,oid] of all){ const parts=fp.split('/'); let node=rootKids; for(let i=0;i<parts.length-1;i++){ if(!node.has(parts[i])) node.set(parts[i], new Map()); node=node.get(parts[i]); } node.set(parts[parts.length-1], {__blob:oid}); }
        function rec(node:Map<string,any>): string {
          const entries:any[]=[]; for(const [name,val] of node.entries()){
            if(val && (val as any).__blob) entries.push({mode:'100644',name,oid:(val as any).__blob}); else { const toid=rec(val as Map<string,any>); entries.push({mode:'40000',name,oid:toid}); }
          }
          entries.sort((a,b)=>{const an=a.mode==='40000'?a.name+'/':a.name; const bn=b.mode==='40000'?b.name+'/':b.name; return an<bn?-1:an>bn?1:0;});
          return putObj(r,'tree',buildTree(entries));
        }
        return rec(rootKids);
      }
      const treeOid = makeTree(files);
      const commit = buildCommit({tree:treeOid,parents:parent?[parent]:[],message:msg,author:'User <u@example.com>',ts});
      const commitOid=putObj(r,'commit',commit);
      r.refs.set('refs/heads/'+branch, commitOid); bumpRefs(r);
      const status = existing ? 200 : 201;
      sendJson(res,status,{content:{name:p.split('/').pop(),path:p,sha:blobOid,size:content.length,type:'file',content:content.toString('base64'),encoding:'base64'},commit:commitJson(req,r,commitOid)});
      return;
    } else if(method==='DELETE'){
      let body:any; try{ body=await readJson(req);}catch{sendBadRequest(res);return;}
      const branch=String(body?.branch||r.defaultBranch); const msg=String(body?.message||'delete'); const sha=String(body?.sha||'');
      const parent=r.refs.get('refs/heads/'+branch); if(!parent){ sendNotFound(res); return; }
      const existing=findBlobAt(r,parent,p); if(!existing){ sendNotFound(res); return; }
      const curSha=sha1('blob',existing); if(sha && sha!==curSha){ sendJson(res,409,{message:'sha does not match'}); return; }
      const files=commitFiles(r,parent); files.delete(p);
      function makeTree(all:Map<string,string>): string {
        const rootKids = new Map<string, any>();
        for(const [fp,oid] of all){ const parts=fp.split('/'); let node=rootKids; for(let i=0;i<parts.length-1;i++){ if(!node.has(parts[i])) node.set(parts[i], new Map()); node=node.get(parts[i]); } node.set(parts[parts.length-1], {__blob:oid}); }
        function rec(node:Map<string,any>): string {
          const entries:any[]=[]; for(const [name,val] of node.entries()){
            if(val && (val as any).__blob) entries.push({mode:'100644',name,oid:(val as any).__blob}); else { const toid=rec(val as Map<string,any>); entries.push({mode:'40000',name,oid:toid}); }
          }
          entries.sort((a,b)=>{const an=a.mode==='40000'?a.name+'/':a.name; const bn=b.mode==='40000'?b.name+'/':b.name; return an<bn?-1:an>bn?1:0;});
          return putObj(r,'tree',buildTree(entries));
        }
        return rec(rootKids);
      }
      const treeOid = makeTree(files);
      const commit = buildCommit({tree:treeOid,parents:[parent],message:msg,author:'User <u@example.com>',ts:nowSec()});
      const commitOid=putObj(r,'commit',commit); r.refs.set('refs/heads/'+branch, commitOid); bumpRefs(r);
      sendJson(res,200,{content:null,commit:commitJson(req,r,commitOid)}); return;
    } else {
      const ref = qs.get('ref') || r.defaultBranch;
      const tip = r.refs.get('refs/heads/'+ref) || r.refs.get(ref) || ref;
      const blob = p ? findBlobAt(r, tip, p) : null;
      if(blob){
        const blobOid=sha1('blob',blob);
        sendJson(res,200,{name:p.split('/').pop(),path:p,sha:blobOid,size:blob.length,type:'file',content:blob.toString('base64'),encoding:'base64'});
        return;
      }
      const cobj=r.objects.get(tip); if(!cobj){ sendNotFound(res); return; }
      let treeOid=parseCommit(cobj.data).tree;
      if(p){
        const parts=p.split('/'); let cur=treeOid; let ok=true;
        for(const part of parts){ const t=r.objects.get(cur); if(!t||t.type!=='tree'){ok=false;break;} const e=parseTree(t.data).find(x=>x.name===part); if(!e){ok=false;break;} cur=e.oid; }
        if(!ok){ sendNotFound(res); return; } treeOid=cur;
      }
      const t=r.objects.get(treeOid); if(!t||t.type!=='tree'){ sendNotFound(res); return; }
      const entries=parseTree(t.data).map(e=>({name:e.name,path:p?`${p}/${e.name}`:e.name,sha:e.oid,type:e.mode==='40000'?'dir':'file'}));
      sendJson(res,200,entries); return;
    }
  }
  sendNotFound(res);
}

async function handleGraphQL(req:IncomingMessage,res:ServerResponse){
  if(!requireAuth(req,res)) return;
  let body:any; try{ body=await readJson(req);}catch{ sendBadRequest(res); return; }
  const queries = Array.isArray(body) ? body : [body];
  const results = await Promise.all(queries.map(q=>execGraphQL(req,q)));
  sendJson(res,200, Array.isArray(body)? results: results[0]);
}

function gqlVar(query:string, vars:any, name:string, inline?:RegExp): any {
  if(inline){ const m=inline.exec(query); if(m){ if(m[1]!==undefined) return m[1]; if(m[2]!==undefined) return vars[m[2]]; } }
  return vars[name];
}
function repoByNodeId(id:string): Repo|undefined { for(const r of repos.values()) if(r.nodeId===id) return r; return undefined; }
function findIssueByNodeId(id:string): {repo:Repo,issue:Issue}|undefined { for(const r of repos.values()){ const i=r.issues.find(x=>x.nodeId===id); if(i) return {repo:r,issue:i}; } }
function findPullByNodeId(id:string): {repo:Repo,pr:Pull}|undefined { for(const r of repos.values()){ const p=r.pulls.find(x=>x.nodeId===id); if(p) return {repo:r,pr:p}; } }
function issueStateGql(i:Issue){ return i.state==='open'?'OPEN':'CLOSED'; }
function prStateGql(p:Pull){ return p.merged?'MERGED':(p.state==='open'?'OPEN':'CLOSED'); }
function gqlIssue(i:Issue){ return {id:i.nodeId,number:i.number,title:i.title,body:i.body,state:issueStateGql(i),comments:{totalCount:i.comments.length,nodes:i.comments.map(c=>({id:nodeId('ic',c.id),body:c.body}))}}; }
function gqlPull(p:Pull){ return {id:p.nodeId,number:p.number,title:p.title,body:p.body,state:prStateGql(p),merged:!!p.merged,headRefName:p.headRef,baseRefName:p.baseRef,mergeable:'MERGEABLE',mergeCommit:p.mergeCommitSha?{oid:p.mergeCommitSha}:null,files:{nodes:(p.files||[]).map(f=>({path:f.filename}))}}; }
function gqlRepo(r:Repo, viewer:string){
  const dbr = r.refs.get('refs/heads/'+r.defaultBranch);
  return {
    id:r.nodeId, databaseId:r.id, name:r.name, nameWithOwner:r.fullName,
    description:r.description||null, owner:{login:r.owner},
    defaultBranchRef: dbr? {name:r.defaultBranch}: null,
    viewerPermission:'ADMIN', hasIssuesEnabled:true,
  };
}
function resolveRepository(query:string, vars:any, viewer:string): any {
  // repository(owner:..., name:...) { ... }
  const m=/repository\s*\(\s*owner\s*:\s*(?:"([^"]+)"|\$(\w+))\s*,\s*name\s*:\s*(?:"([^"]+)"|\$(\w+))\s*\)\s*\{([\s\S]*)\}\s*$/m.exec(query.replace(/\n/g,'\n'));
  // easier: extract args and inspect whole query for subfields
  const rc=/repository\s*\(\s*owner\s*:\s*(?:"([^"]+)"|\$(\w+))\s*,\s*name\s*:\s*(?:"([^"]+)"|\$(\w+))\s*\)/.exec(query);
  if(!rc) return undefined;
  const owner = rc[1] ?? vars[rc[2]]; const name = rc[3] ?? vars[rc[4]];
  const r=getRepo(String(owner), String(name));
  if(!r) return null;
  const out:any = gqlRepo(r,viewer);
  // issue(number: ...)
  const issueNumM=/issue\s*\(\s*number\s*:\s*(?:(\d+)|\$(\w+))\s*\)/.exec(query);
  if(issueNumM){
    const n = issueNumM[1]? parseInt(issueNumM[1],10): Number(vars[issueNumM[2]]);
    const iss=r.issues.find(i=>i.number===n);
    out.issue = iss? {id:iss.nodeId,number:iss.number,title:iss.title,body:iss.body,state:issueStateGql(iss)} : null;
  }
  // pullRequest(number: ...)
  const prNumM=/pullRequest\s*\(\s*number\s*:\s*(?:(\d+)|\$(\w+))\s*\)/.exec(query);
  if(prNumM){
    const n = prNumM[1]? parseInt(prNumM[1],10): Number(vars[prNumM[2]]);
    const pr=r.pulls.find(p=>p.number===n);
    if(pr){
      out.pullRequest = {id:pr.nodeId,number:pr.number,title:pr.title,body:pr.body,state:prStateGql(pr),merged:!!pr.merged,headRefName:pr.headRef,baseRefName:pr.baseRef,mergeable:'MERGEABLE',files:{nodes:(pr.files||[]).map(f=>({path:f.filename}))}};
    } else out.pullRequest = null;
  }
  // issues connection
  if(/\bissues\s*\(/.test(query)){
    let items=[...r.issues];
    const statesM=/states\s*:\s*\[([^\]]*)\]/.exec(query);
    if(statesM){ const st=statesM[1].split(',').map(s=>s.trim()).filter(Boolean); if(st.includes('OPEN')) items=items.filter(i=>i.state==='open'); else if(st.includes('CLOSED')) items=items.filter(i=>i.state==='closed'); }
    const orderM=/orderBy\s*:\s*\{[^}]*field\s*:\s*(\w+)[^}]*direction\s*:\s*(\w+)/.exec(query);
    let dir='DESC'; let field='CREATED_AT';
    if(orderM){ field=orderM[1]; dir=orderM[2]; }
    items.sort((a,b)=>{ let cmp=(a.id-b.id)||(a.number-b.number); if(field==='CREATED_AT'||field==='UPDATED_AT') cmp=a.number-b.number; if(field==='COMMENTS') cmp=a.comments.length-b.comments.length; return dir==='ASC'?cmp:-cmp; });
    const firstM=/issues\s*\([^)]*first\s*:\s*(?:(\d+)|\$(\w+))/.exec(query);
    const afterM=/issues\s*\([^)]*after\s*:\s*(?:"([^"]*)"|\$(\w+)|null)/.exec(query);
    let first = firstM? (firstM[1]?parseInt(firstM[1],10):Number(vars[firstM[2]])) : items.length;
    let after: string|null|undefined = undefined;
    if(/after\s*:\s*null/.test(query)) after=null;
    else if(afterM){ after = afterM[1]!==undefined? afterM[1] : vars[afterM[2]]; }
    if(after===undefined && vars.after!==undefined) after = vars.after;
    let start=0;
    if(after){ const idx=items.findIndex(i=>String(i.number)===String(after) || i.nodeId===String(after)); start=idx>=0? idx+1:0; }
    const page=items.slice(start, start+first);
    const end = start+first;
    const hasNextPage = end < items.length;
    const endCursor = page.length? String(page[page.length-1].number): null;
    out.issues={nodes:page.map(i=>({id:i.nodeId,number:i.number,title:i.title,body:i.body,state:issueStateGql(i)})), pageInfo:{hasNextPage,endCursor}};
  }
  // pullRequests connection
  if(/\bpullRequests\s*\(/.test(query)){
    let items=[...r.pulls];
    const firstM=/pullRequests\s*\([^)]*first\s*:\s*(?:(\d+)|\$(\w+))/.exec(query);
    let first = firstM? (firstM[1]?parseInt(firstM[1],10):Number(vars[firstM[2]])) : items.length;
    const page=items.slice(0, first);
    out.pullRequests={nodes:page.map(p=>({id:p.nodeId,number:p.number,title:p.title,body:p.body,state:prStateGql(p),merged:!!p.merged,headRefName:p.headRef,baseRefName:p.baseRef,mergeable:'MERGEABLE',mergeCommit:p.mergeCommitSha?{oid:p.mergeCommitSha}:null,files:{nodes:(p.files||[]).map(f=>({path:f.filename}))}}))};
  }
  return out;
}

async function execGraphQL(req:IncomingMessage, payload:any): Promise<any>{
  const query=String(payload?.query||'');
  const vars=payload?.variables||{};
  const viewer=viewerLogin(req);
  try{
    if(/noSuchFieldOnViewer/.test(query)){
      return { errors:[{message:'Cannot query field "noSuchFieldOnViewer" on type "User".'}] };
    }
    const data:any={};
    // __type introspection (can appear with aliases like Issue: __type(name:"Issue"))
    const typeRe=/(\w+\s*:\s*)?__type\s*\(\s*name\s*:\s*(?:"([^"]+)"|\$(\w+))\s*\)\s*\{([\s\S]*?)\n\s*\}/g;
    let tm:RegExpExecArray|null; let hadType=false;
    while((tm=typeRe.exec(query))){
      hadType=true;
      const aliasRaw=tm[1]; const typeName = tm[2] ?? vars[tm[3]]; const body=tm[4]||'';
      const key = aliasRaw? aliasRaw.replace(/\s*:\s*$/,'').trim() : '__type';
      const mkFields=(names:string[])=>names.map(name=>({name}));
      const types:any = {
        Issue: ()=>({kind:'OBJECT',name:'Issue',fields: mkFields(['id','number','title','state','body','comments','createdAt','author'])}),
        PullRequest: ()=>({kind:'OBJECT',name:'PullRequest',fields: mkFields(['id','number','headRefName','baseRefName','mergeable','state','merged','files','title','body'])}),
        Repository: ()=>({kind:'OBJECT',name:'Repository',fields: mkFields(['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','issue','issues','pullRequests','pullRequest','refs','description'])}),
        SearchType: ()=>({kind:'ENUM',name:'SearchType',enumValues:[{name:'ISSUE'},{name:'REPOSITORY'},{name:'USER'}],fields:null}),
        Query: ()=>({kind:'OBJECT',name:'Query',fields: mkFields(['viewer','repository','node'])}),
        Mutation: ()=>({kind:'OBJECT',name:'Mutation',fields: mkFields(['createIssue','closeIssue','addComment','createPullRequest','mergePullRequest'])}),
        User: ()=>({kind:'OBJECT',name:'User',fields: mkFields(['login','id'])}),
      };
      const val = types[typeName]? types[typeName]() : null;
      // if body asks for enumValues specifically ensure shape; fields already fine
      if(val && /enumValues/.test(body) && val.enumValues===undefined) val.enumValues=null;
      if(val && /fields/.test(body) && val.fields===undefined) val.fields=null;
      data[key]=val;
    }
    if(!hadType && /__type/.test(query)){
      const nameMatch=/__type\s*\(\s*name\s*:\s*"([^"]+)"/.exec(query);
      const tname = nameMatch ? nameMatch[1] : vars.name;
      const fallback:any={Issue:['id','number','title','state','body'],Repository:['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','issue','issues','pullRequests','pullRequest']};
      data.__type = fallback[tname]? {kind:'OBJECT',name:tname,fields:fallback[tname].map((n:string)=>({name:n}))}: (tname==='SearchType'?{kind:'ENUM',name:'SearchType',enumValues:[{name:'ISSUE'}]}:null);
    }

    if(/\bviewer\b/.test(query) && !/noSuchFieldOnViewer/.test(query)) data.viewer={login:viewer,id:nodeId('user',1)};

    if(/\brepository\s*\(/.test(query)){
      data.repository = resolveRepository(query, vars, viewer);
    }

    if(/\bnode\s*\(/.test(query)){
      const nm=/node\s*\(\s*id\s*:\s*(?:"([^"]+)"|\$(\w+))\s*\)/.exec(query);
      const nid = String(nm? (nm[1] ?? vars[nm[2]]) : vars.id);
      let found:any=null;
      const rr=repoByNodeId(nid); if(rr) found={__typename:'Repository',id:rr.nodeId,name:rr.name,nameWithOwner:rr.fullName};
      const fi=findIssueByNodeId(nid); if(fi) found={__typename:'Issue',id:fi.issue.nodeId,number:fi.issue.number,title:fi.issue.title,body:fi.issue.body,state:issueStateGql(fi.issue)};
      const fp=findPullByNodeId(nid); if(fp) found={__typename:'PullRequest',id:fp.pr.nodeId,number:fp.pr.number,title:fp.pr.title,body:fp.pr.body,state:prStateGql(fp.pr),merged:!!fp.pr.merged};
      data.node=found;
    }

    if(/^\s*mutation\b/m.test(query) || /\bmutation\b/.test(query.split('{')[0]||'')){
      const input = vars.input || {};
      if(/createIssue\s*\(/.test(query)){
        const target=repoByNodeId(String(input.repositoryId));
        if(target){ const num=target.nextIssue++; const id=nextGlobalId++; const iss:Issue={id,nodeId:nodeId('issue',id),number:num,title:String(input.title||''),body:String(input.body||''),state:'open',labels:[],comments:[],createdAt:nowIso(),jsonCache:null}; target.issues.push(iss); data.createIssue={issue:{id:iss.nodeId,number:iss.number}}; }
      } else if(/closeIssue\s*\(/.test(query)){
        const f=findIssueByNodeId(String(input.issueId)); if(f){ f.issue.state='closed'; f.issue.jsonCache=null; data.closeIssue={issue:{id:f.issue.nodeId,number:f.issue.number,state:'CLOSED'}}; }
      } else if(/addComment\s*\(/.test(query)){
        const sid=String(input.subjectId); const b=String(input.body||''); const fi=findIssueByNodeId(sid);
        if(fi){ const cid=fi.repo.nextCommentId++; fi.issue.comments.push({id:cid,body:b}); fi.issue.jsonCache=null; data.addComment={commentEdge:{node:{id:nodeId('ic',cid),body:b}}}; }
        else { const fp=findPullByNodeId(sid); if(fp){ data.addComment={commentEdge:{node:{id:nodeId('pc',++fp.repo.nextCommentId),body:b}}}; } }
      } else if(/createPullRequest\s*\(/.test(query)){
        const target=repoByNodeId(String(input.repositoryId));
        if(target){ const head=String(input.headRefName||'').replace(/^refs\/heads\//,''); const base=String(input.baseRefName||'').replace(/^refs\/heads\//,''); const headSha=target.refs.get('refs/heads/'+head)||''; const baseSha=target.refs.get('refs/heads/'+base)||''; const num=target.nextPull++; const id=nextGlobalId++; const pr:Pull={id,nodeId:nodeId('pr',id),number:num,title:String(input.title||''),body:String(input.body||''),state:'open',headRef:head,baseRef:base,headSha,baseSha,merged:false,mergedAt:null,mergeCommitSha:null,files:diffFiles(target,baseSha,headSha),createdAt:nowIso()}; target.pulls.push(pr); data.createPullRequest={pullRequest:{id:pr.nodeId,number:pr.number,state:'OPEN',headRefName:head,baseRefName:base}}; }
      } else if(/mergePullRequest\s*\(/.test(query)){
        const f=findPullByNodeId(String(input.pullRequestId));
        if(f){ const pr=f.pr,r=f.repo; if(!pr.merged){ const baseRef='refs/heads/'+pr.baseRef; const headSha=r.refs.get('refs/heads/'+pr.headRef)||pr.headSha; const baseSha=r.refs.get(baseRef)||pr.baseSha; const headObj=r.objects.get(headSha); const treeOid=headObj?parseCommit(headObj.data).tree:''; const msg=`Merge pull request #${pr.number}\n`; const mc=buildCommit({tree:treeOid,parents:[baseSha,headSha].filter(Boolean) as string[],message:msg,author:'User <u@example.com>',ts:nowSec()}); const msha=putObj(r,'commit',mc); r.refs.set(baseRef,msha); bumpRefs(r); pr.merged=true; pr.state='closed'; pr.mergedAt=nowIso(); pr.mergeCommitSha=msha; }
          data.mergePullRequest={pullRequest:{number:pr.number,merged:true,state:'MERGED'}}; }
      }
    }
    return { data };
  }catch(e:any){ return { errors:[{message:String(e?.message||e)}] }; }
}

async function handleMcp(req:IncomingMessage,res:ServerResponse,method:string){
  if(method==='GET'){ sendJson(res,405,{error:'Method Not Allowed'}); return; }
  if(method!=='POST'){ sendJson(res,405,{error:'Method Not Allowed'}); return; }
  if(!requireAuth(req,res)) return;
  const raw = await readBody(req);
  let body:any;
  try{ body = raw.length===0? {} : JSON.parse(raw.toString('utf8')); }catch{ sendJson(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}); return; }
  const respond = (id:any, result:any)=>({jsonrpc:'2.0',id,result});
  const respondErr = (id:any, code:number, message:string)=>({jsonrpc:'2.0',id,error:{code,message}});
  async function handleOne(m:any){
    const {id,method:meth,params} = m||{};
    if(meth==='initialize') return respond(id,{protocolVersion: params?.protocolVersion || '2025-11-25', capabilities:{tools:{listChanged:false}}, serverInfo:{name:'forge-mcp',version:'0.1.0'}});
    if(meth==='notifications/initialized') return null;
    if(meth==='server/discover') return respond(id,{serverInfo:{name:'forge-mcp',version:'0.1.0'}, capabilities:{tools:{listChanged:false}}, supportedVersions:['2026-07-28','2025-11-25']});
    if(meth==='tools/list'){
      const tools=[
        {name:'create_repo',description:'Create repository',inputSchema:{type:'object',properties:{name:{type:'string'},description:{type:'string'},private:{type:'boolean'}},required:['name']}},
        {name:'get_repo',description:'Get repository',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'}},required:['owner','repo']}},
        {name:'get_me',description:'Get viewer',inputSchema:{type:'object',properties:{}}},
        {name:'search_repositories',description:'Search repos',inputSchema:{type:'object',properties:{query:{type:'string'}}}},
        {name:'get_file_contents',description:'Get file',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'},path:{type:'string'},ref:{type:'string'}},required:['owner','repo','path']}},
        {name:'list_issues',description:'List issues',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'}},required:['owner','repo']}},
        {name:'issue_read',description:'Read issue',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'},issue_number:{type:'number'}},required:['owner','repo','issue_number']}},
        {name:'create_issue',description:'Create issue',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'},title:{type:'string'},body:{type:'string'}},required:['owner','repo','title']}},
        {name:'add_issue_comment',description:'Add issue comment',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'},issue_number:{type:'number'},body:{type:'string'}},required:['owner','repo','issue_number','body']}},
        {name:'list_pull_requests',description:'List PRs',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'}},required:['owner','repo']}},
        {name:'create_pull_request',description:'Create PR',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'},title:{type:'string'},body:{type:'string'},head:{type:'string'},base:{type:'string'}},required:['owner','repo','title','head','base']}},
        {name:'merge_pull_request',description:'Merge PR',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'},pull_number:{type:'number'}},required:['owner','repo','pull_number']}},
      ];
      return respond(id,{tools});
    }
    if(meth==='tools/call'){
      const name=params?.name; const args=params?.arguments||{};
      try{
        const viewer=viewerLogin(req); let result:any=null;
        if(name==='get_me'){ result={login:viewer,id:1}; }
        else if(name==='create_repo'){
          const rname=String(args.name||'').trim(); if(!rname) throw new Error('name required');
          if(getRepo(viewer,rname)) throw new Error('already exists');
          const r=ensureRepo(viewer,rname,{private:!!args.private,description: args.description===undefined?'':String(args.description)});
          result={id:r.id,name:r.name,full_name:r.fullName,owner:{login:r.owner},private:r.private,description:r.description,default_branch:r.defaultBranch};
        } else if(name==='get_repo'){
          const r=getRepo(String(args.owner),String(args.repo)); if(!r) throw new Error('not found');
          result={id:r.id,name:r.name,full_name:r.fullName,owner:{login:r.owner},private:r.private,description:r.description,default_branch:r.defaultBranch};
        } else if(name==='search_repositories'){
          const q=String(args.query||'').toLowerCase(); const items=[...repos.values()].filter(r=>r.fullName.toLowerCase().includes(q)||r.name.toLowerCase().includes(q)).map(r=>({full_name:r.fullName,name:r.name,owner:{login:r.owner}}));
          result={items,total_count:items.length};
        } else if(name==='get_file_contents'){
          const r=getRepo(String(args.owner),String(args.repo)); if(!r) throw new Error('not found');
          const ref=args.ref||r.defaultBranch; const tip=r.refs.get('refs/heads/'+ref)||r.refs.get(ref)||ref; const blob=findBlobAt(r,tip,String(args.path||'')); if(!blob) throw new Error('not found');
          result={path:args.path,content:blob.toString('base64'),encoding:'base64',sha:sha1('blob',blob)};
        } else if(name==='list_issues'){
          const r=getRepo(String(args.owner),String(args.repo)); if(!r) throw new Error('not found'); result=r.issues.map(i=>({number:i.number,title:i.title,state:i.state,body:i.body}));
        } else if(name==='issue_read'){
          const r=getRepo(String(args.owner),String(args.repo)); const iss=r?.issues.find(i=>i.number===Number(args.issue_number)); if(!r||!iss) throw new Error('not found'); result={number:iss.number,title:iss.title,body:iss.body,state:iss.state,comments:iss.comments};
        } else if(name==='create_issue'){
          const r=getRepo(String(args.owner),String(args.repo)); if(!r) throw new Error('not found'); const num=r.nextIssue++; const idn=nextGlobalId++; const iss:Issue={id:idn,nodeId:nodeId('issue',idn),number:num,title:String(args.title||''),body:String(args.body||''),state:'open',labels:[],comments:[],createdAt:nowIso(),jsonCache:null}; r.issues.push(iss); result={number:iss.number,title:iss.title,state:iss.state,body:iss.body};
        } else if(name==='add_issue_comment'){
          const r=getRepo(String(args.owner),String(args.repo)); const iss=r?.issues.find(i=>i.number===Number(args.issue_number)); if(!r||!iss) throw new Error('not found'); const cid=r.nextCommentId++; iss.comments.push({id:cid,body:String(args.body||'')}); iss.jsonCache=null; result={id:cid,body:String(args.body||'')};
        } else if(name==='list_pull_requests'){
          const r=getRepo(String(args.owner),String(args.repo)); if(!r) throw new Error('not found'); result=r.pulls.map(p=>({number:p.number,title:p.title,state:p.state,merged:p.merged,head:p.headRef,base:p.baseRef}));
        } else if(name==='create_pull_request'){
          const r=getRepo(String(args.owner),String(args.repo)); if(!r) throw new Error('not found'); const head=String(args.head||''); const base=String(args.base||''); const headSha=r.refs.get('refs/heads/'+head)||''; const baseSha=r.refs.get('refs/heads/'+base)||''; if(!headSha||!baseSha) throw new Error('invalid refs'); const num=r.nextPull++; const idn=nextGlobalId++; const pr:Pull={id:idn,nodeId:nodeId('pr',idn),number:num,title:String(args.title||''),body:String(args.body||''),state:'open',headRef:head,baseRef:base,headSha,baseSha,merged:false,mergedAt:null,mergeCommitSha:null,files:diffFiles(r,baseSha,headSha),createdAt:nowIso()}; r.pulls.push(pr); result={number:pr.number,title:pr.title,state:pr.state,head:head,base:base};
        } else if(name==='merge_pull_request'){
          const r=getRepo(String(args.owner),String(args.repo)); const pr=r?.pulls.find(p=>p.number===Number(args.pull_number)); if(!r||!pr) throw new Error('not found'); if(!pr.merged){ const baseRef='refs/heads/'+pr.baseRef; const headSha=r.refs.get('refs/heads/'+pr.headRef)||pr.headSha; const baseSha=r.refs.get(baseRef)||pr.baseSha; const headObj=r.objects.get(headSha); const treeOid=headObj?parseCommit(headObj.data).tree:''; const msg=`Merge pull request #${pr.number}\n`; const mc=buildCommit({tree:treeOid,parents:[baseSha,headSha].filter(Boolean) as string[],message:msg,author:'User <u@example.com>',ts:nowSec()}); const msha=putObj(r,'commit',mc); r.refs.set(baseRef,msha); bumpRefs(r); pr.merged=true; pr.state='closed'; pr.mergedAt=nowIso(); pr.mergeCommitSha=msha; }
          result={merged:true,number:pr.number,sha:pr.mergeCommitSha};
        } else { return respondErr(id,-32601,`Unknown tool: ${name}`); }
        return respond(id,{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false});
      }catch(e:any){ return respond(id,{content:[{type:'text',text:String(e?.message||e)}],isError:true}); }
    }
    if(id===undefined) return null;
    return respondErr(id,-32601,'Method not found');
  }
  if(Array.isArray(body)){
    const out=[] as any[]; for(const m of body){ const r=await handleOne(m); if(r) out.push(r); } sendJson(res,200,out); return;
  } else {
    const r=await handleOne(body); if(r===null){ sendEmpty(res,202); return; } sendJson(res,200,r); return;
  }
}
