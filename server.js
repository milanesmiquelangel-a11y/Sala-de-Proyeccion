require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MAX_GENERATIONS_PER_HOUR = parseInt(process.env.MAX_GENERATIONS_PER_HOUR || '5', 10);
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const USE_SUPABASE = !!(process.env.SUPABASE_URL && SUPABASE_SECRET_KEY);
const USE_PG_SESSION = process.env.USE_PG_SESSION === 'true';
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'media';

if (!POLLINATIONS_API_KEY) console.error('Falta POLLINATIONS_API_KEY.');
if (!USE_SUPABASE) console.warn('Supabase no está configurado. El proyecto usará almacenamiento local temporal.');
if (!USE_PG_SESSION) console.warn('Sesiones PostgreSQL desactivadas temporalmente; se usa almacenamiento de sesión en memoria.');

let supabase = null;
let pgPool = null;
if (USE_SUPABASE) {
  supabase = createClient(process.env.SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  if (process.env.DATABASE_URL) {
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    pgPool.on('error', (err) => console.error('PostgreSQL pool error:', err));
  }
}

const DB_PATH = path.join(__dirname, 'data', 'db.json');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ users: [], generations: [] }, null, 2));
function readDB() { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
function writeDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

const uploadsDir = path.join(__dirname, 'public', 'uploads');
const videosDir = path.join(__dirname, 'public', 'videos');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(videosDir, { recursive: true });

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Solo se aceptan imágenes JPG, PNG o WEBP.'), ok);
  }
});

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '100kb' }));

const sessionOptions = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax', httpOnly: true, secure: process.env.NODE_ENV === 'production' }
};
if (pgPool && USE_PG_SESSION) sessionOptions.store = new PgSession({ pool: pgPool, createTableIfMissing: true });
app.use(session(sessionOptions));

app.use('/uploads', express.static(uploadsDir, { maxAge: '7d', immutable: true }));
app.use('/videos', express.static(videosDir, { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Tienes que iniciar sesión.' });
  next();
}

const BLOCKED_TERMS = ['contenido sexual con menores', 'child sexual', 'csam', 'violencia sexual', 'sexual violence', 'como fabricar una bomba', 'how to make a bomb', 'como fabricar armas', 'weapon manufacturing instructions'];
function isPromptSafe(prompt) { const lower = prompt.toLowerCase(); return !BLOCKED_TERMS.some(t => lower.includes(t)); }

async function dbUserByEmail(email) {
  if (!USE_SUPABASE) return readDB().users.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
  const { data, error } = await supabase.from('users').select('*').ilike('email', email).maybeSingle();
  if (error) throw error;
  return data;
}
async function dbUserById(id) {
  if (!USE_SUPABASE) return readDB().users.find(u => u.id === id) || null;
  const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}
async function createUser(user) {
  if (!USE_SUPABASE) { const db = readDB(); db.users.push(user); writeDB(db); return user; }
  const { data, error } = await supabase.from('users').insert(user).select().single();
  if (error) throw error;
  return data;
}
async function listGenerations(userId) {
  if (!USE_SUPABASE) return readDB().generations.filter(g => g.userId === userId).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)).slice(0,50);
  const { data, error } = await supabase.from('generations').select('*').eq('user_id', userId).order('created_at', { ascending:false }).limit(50);
  if (error) throw error;
  return data.map(g => ({ id:g.id, userId:g.user_id, prompt:g.prompt, model:g.model, aspectRatio:g.aspect_ratio, duration:g.duration, audio:g.audio, hasImage:g.has_image, imagePath:g.image_path, videoPath:g.video_path, createdAt:g.created_at }));
}
async function countRecentGenerations(userId) {
  const since = new Date(Date.now() - 60*60*1000).toISOString();
  if (!USE_SUPABASE) return readDB().generations.filter(g => g.userId===userId && new Date(g.createdAt).getTime() > Date.now()-60*60*1000).length;
  const { count, error } = await supabase.from('generations').select('id', { count:'exact', head:true }).eq('user_id', userId).gt('created_at', since);
  if (error) throw error;
  return count || 0;
}
async function createGeneration(g) {
  if (!USE_SUPABASE) { const db=readDB(); db.generations.push(g); writeDB(db); return g; }
  const row = { id:g.id, user_id:g.userId, prompt:g.prompt, model:g.model, aspect_ratio:g.aspectRatio, duration:g.duration, audio:g.audio, has_image:g.hasImage, image_path:g.imagePath, video_path:g.videoPath, created_at:g.createdAt };
  const { data, error } = await supabase.from('generations').insert(row).select().single();
  if (error) throw error;
  return data;
}
async function getGenerationForUser(id, userId) {
  if (!USE_SUPABASE) return readDB().generations.find(g=>g.id===id && g.userId===userId) || null;
  const { data, error } = await supabase.from('generations').select('*').eq('id',id).eq('user_id',userId).maybeSingle();
  if (error) throw error;
  return data ? { id:data.id, userId:data.user_id, imagePath:data.image_path, videoPath:data.video_path } : null;
}
async function deleteGeneration(id,userId) {
  if (!USE_SUPABASE) { const db=readDB(); const i=db.generations.findIndex(g=>g.id===id&&g.userId===userId); if(i<0)return null; const g=db.generations[i]; db.generations.splice(i,1); writeDB(db); return g; }
  const g=await getGenerationForUser(id,userId); if(!g)return null;
  const { error }=await supabase.from('generations').delete().eq('id',id).eq('user_id',userId); if(error)throw error; return g;
}

async function signedUrl(pathname, expires=3600) {
  if (!pathname) return null;
  if (!USE_SUPABASE) return pathname;
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(pathname, expires);
  if (error) throw error;
  return data.signedUrl;
}
async function storageUpload(filePath, buffer, contentType) {
  if (!USE_SUPABASE) { const local = path.join(filePath.startsWith('images/')?uploadsDir:videosDir, path.basename(filePath)); fs.writeFileSync(local, buffer); return '/'+(filePath.startsWith('images/')?'uploads/':'videos/')+path.basename(filePath); }
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(filePath, buffer, { contentType, upsert:false, cacheControl:'31536000' });
  if (error) throw error;
  return filePath;
}
async function storageRemove(paths) {
  const clean=paths.filter(Boolean); if(!clean.length)return;
  if (!USE_SUPABASE) { for(const p of clean){ const dir=p.startsWith('images/')?uploadsDir:videosDir; const f=path.join(dir,path.basename(p)); if(fs.existsSync(f))fs.unlinkSync(f); } return; }
  const { error }=await supabase.storage.from(STORAGE_BUCKET).remove(clean); if(error) console.error('Storage remove:',error.message);
}

app.post('/api/register', async (req,res)=>{
  try {
    const {email,password}=req.body||{};
    if(!email||!password||password.length<8)return res.status(400).json({error:'Correo y contraseña (mínimo 8 caracteres) son obligatorios.'});
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:'Introduce un correo válido.'});
    if(await dbUserByEmail(email))return res.status(409).json({error:'Ya existe una cuenta con ese correo.'});
    const user={id:crypto.randomUUID(),email:email.trim(),password_hash:await bcrypt.hash(password,10),created_at:new Date().toISOString()};
    await createUser(USE_SUPABASE?user:{id:user.id,email:user.email,passwordHash:user.password_hash,createdAt:user.created_at});
    req.session.userId=user.id; res.json({email:user.email});
  } catch(e){ console.error('Register error:',e); res.status(500).json({error:'No se pudo crear la cuenta.'}); }
});

app.post('/api/login', async (req,res)=>{
  try {
    const {email,password}=req.body||{}; const user=await dbUserByEmail(email||'');
    const hash=user?.password_hash||user?.passwordHash;
    if(!user||!(await bcrypt.compare(password||'',hash||'')))return res.status(401).json({error:'Correo o contraseña incorrectos.'});
    req.session.userId=user.id; res.json({email:user.email});
  } catch(e){ console.error('Login error:',e); res.status(500).json({error:'No se pudo iniciar sesión.'}); }
});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/me',async(req,res)=>{try{if(!req.session.userId)return res.status(401).json({error:'No has iniciado sesión.'});const u=await dbUserById(req.session.userId);if(!u)return res.status(401).json({error:'Sesión inválida.'});res.json({email:u.email});}catch(e){console.error('Session lookup error:',e);res.status(500).json({error:'Error de sesión.'});}});

app.get('/api/history',requireLogin,async(req,res)=>{
  try{const rows=await listGenerations(req.session.userId);const generations=await Promise.all(rows.map(async g=>({...g,videoUrl:await signedUrl(g.videoPath),imageUrl:g.imagePath?await signedUrl(g.imagePath):null})));res.json({generations});}
  catch(e){console.error(e);res.status(500).json({error:'No se pudo cargar el historial.'});}
});

app.post('/api/upload',requireLogin,upload.single('image'),async(req,res)=>{
  try{if(!req.file)return res.status(400).json({error:'No se recibió ninguna imagen.'});const ext=req.file.mimetype==='image/png'?'.png':req.file.mimetype==='image/webp'?'.webp':'.jpg';const filePath=`images/${req.session.userId}/${crypto.randomUUID()}${ext}`;await storageUpload(filePath,req.file.buffer,req.file.mimetype);const url=await signedUrl(filePath,7200);res.json({url,path:filePath});}
  catch(e){console.error(e);res.status(500).json({error:'No se pudo guardar la imagen.'});}
});

app.delete('/api/history/:id',requireLogin,async(req,res)=>{
  try{const g=await deleteGeneration(req.params.id,req.session.userId);if(!g)return res.status(404).json({error:'Video no encontrado.'});await storageRemove([g.videoPath,g.imagePath]);res.json({ok:true});}
  catch(e){console.error(e);res.status(500).json({error:'No se pudo eliminar el video.'});}
});

app.post('/api/generate-video',requireLogin,async(req,res)=>{
  if(!POLLINATIONS_API_KEY)return res.status(500).json({error:'El servidor no tiene configurada la clave de la API.'});
  try{
    const {prompt,model,aspectRatio,duration,audio,imageUrl,imagePath}=req.body||{};
    if(!prompt||typeof prompt!=='string'||!prompt.trim())return res.status(400).json({error:'Falta describir la escena.'});
    if(prompt.length>2000)return res.status(400).json({error:'La descripción es demasiado larga (máximo 2000 caracteres).'});
    if(!isPromptSafe(prompt))return res.status(400).json({error:'Esa descripción no se puede generar. Prueba con otra escena.'});
    if(await countRecentGenerations(req.session.userId)>=MAX_GENERATIONS_PER_HOUR)return res.status(429).json({error:`Llegaste al límite de ${MAX_GENERATIONS_PER_HOUR} videos por hora.`});
    const allowedModels=['seedance-2.0-fast','wan-fast','veo']; const safeModel=allowedModels.includes(model)?model:'seedance-2.0-fast';
    const ratios=['16:9','9:16','1:1']; const safeAspectRatio=ratios.includes(aspectRatio)?aspectRatio:'16:9';
    const d=Number(duration);const safeDuration=Number.isFinite(d)?Math.min(10,Math.max(2,Math.round(d))):5;
    if(safeModel==='veo'&&! [4,6,8].includes(safeDuration))return res.status(400).json({error:'Veo funciona con 4, 6 u 8 segundos.'});
    if(imagePath && !imagePath.startsWith(`images/${req.session.userId}/`))return res.status(400).json({error:'La imagen de referencia no es válida.'});
    if(imagePath && !imageUrl)return res.status(400).json({error:'Falta la URL temporal de la imagen.'});
    const params=new URLSearchParams({model:safeModel,key:POLLINATIONS_API_KEY,aspect_ratio:safeAspectRatio,duration:String(safeDuration)});
    if(imageUrl)params.set('image',imageUrl); if(audio&&safeModel==='veo')params.set('audio','true');
    const upstream=await fetch(`https://gen.pollinations.ai/video/${encodeURIComponent(prompt)}?${params.toString()}`);
    if(!upstream.ok){const text=await upstream.text().catch(()=> '');console.error('Pollinations video error:',upstream.status,text.slice(0,500));return res.status(upstream.status).json({error:'La generación falló en el proveedor de IA.',detail:text.slice(0,300)});}
    const buffer=Buffer.from(await upstream.arrayBuffer());
    const id=crypto.randomUUID();const videoPath=`videos/${req.session.userId}/${id}.mp4`;
    await storageUpload(videoPath,buffer,'video/mp4');
    const createdAt=new Date().toISOString();
    try {
      await createGeneration({id,userId:req.session.userId,prompt:prompt.trim(),model:safeModel,aspectRatio:safeAspectRatio,duration:safeDuration,audio:!!(audio&&safeModel==='veo'),hasImage:!!imagePath,imagePath:imagePath||null,videoPath,createdAt});
    } catch (dbError) {
      await storageRemove([videoPath]);
      throw dbError;
    }
    res.setHeader('Content-Type','video/mp4');res.setHeader('X-Generation-Id',id);res.send(buffer);
  }catch(e){console.error(e);res.status(502).json({error:'No se pudo completar la generación. Intenta de nuevo en unos minutos.'});}
});

app.get('/health',(req,res)=>res.json({ok:true}));
app.get('/login.html',(req,res)=>{res.setHeader('Cache-Control','no-store');res.sendFile(path.join(__dirname,'public','login.html'));});
app.get('/',(req,res)=>{res.setHeader('Cache-Control','no-store');res.sendFile(path.join(__dirname,'public','index.html'));});

app.use((err,req,res,next)=>{
  console.error('Unhandled request error:', err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({error:err.message||'Error en la carga del archivo.'});
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({error:'JSON de la solicitud no válido.'});
  }
  return res.status(500).json({error:'Error interno del servidor.'});
});

app.set('trust proxy', 1);
app.listen(PORT, '0.0.0.0', ()=>console.log(`Sala de Proyección corriendo en http://localhost:${PORT}`));
