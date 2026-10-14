const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path'), fs = require('fs'), { execFile } = require('child_process');
const { Client } = require('minecraft-launcher-core');
const crypto = require('crypto');
const { Auth } = require('msmc');
const AdmZip = require('adm-zip');

const ROOT = path.join(app.getPath('appData'), '.haypermc');
const CFG = path.join(ROOT, 'config.json');
fs.mkdirSync(ROOT, { recursive: true });
const defaults = { lang: null, autoJoin: true, server: 'play.HayperMC.com', ram: 4, user: null, inst: 'Default' };
let cfg = { ...defaults, ...(fs.existsSync(CFG) ? JSON.parse(fs.readFileSync(CFG)) : {}) };
const save = () => fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
const igd = () => { const d = path.join(ROOT, 'instances', cfg.inst || 'Default'); fs.mkdirSync(d, { recursive: true }); return d; };
const clean = n => path.basename(String(n).replace(/[^\p{L}\p{N} _-]/gu, '').trim()) || 'Default';
let win, auth = null;

app.whenReady().then(() => {
  win = new BrowserWindow({ width: 1060, height: 680, minWidth: 900, minHeight: 600, frame: false, icon: path.join(__dirname, 'assets', 'icon.ico'), backgroundColor: '#0a0a12',
    webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  win.setMenu(null); win.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());

const J = async u => (await fetch(u, { headers: { 'User-Agent': 'HayperMC-Launcher/1.0' } })).json();
const dl = async (u, f) => { fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.from(await (await fetch(u)).arrayBuffer())); };
const log = m => win && win.webContents.send('log', m);

const pub = () => ({ ...cfg, accounts: undefined });
ipcMain.handle('cfg:get', () => pub());
ipcMain.handle('cfg:set', (e, p) => { cfg = { ...cfg, ...p }; save(); return pub(); });

// release | snapshot | old_beta | old_alpha
ipcMain.handle('versions', async () =>
  (await J('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json')).versions.map(v => ({ id: v.id, type: v.type })));

ipcMain.handle('status', async () => {
  try {
    const d = await J('https://api.mcsrvstat.us/3/' + cfg.server);
    return { online: !!d.online, players: d.players, motd: d.motd && d.motd.clean ? d.motd.clean.join(' ') : '', version: d.version };
  } catch { return { online: false }; }
});

// ---- accounts ----

// ---- loaders ----
const runJar = (jar, args, java) => new Promise((res, rej) =>
  execFile(java.replace('javaw.exe', 'java.exe'), ['-jar', jar, ...args], { cwd: ROOT }, e => e ? rej(e) : res()));

// Bundled Java: downloads the right Temurin JRE per Minecraft version (Windows)
async function javaFor(v) {
  if (process.platform !== 'win32') return 'java';
  let major = 8;
  try {
    const m = await J('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    major = (await J(m.versions.find(x => x.id === v).url)).javaVersion.majorVersion;
  } catch {}
  const dir = path.join(ROOT, 'runtime', String(major));
  const find = () => { if (!fs.existsSync(dir)) return null;
    const d = fs.readdirSync(dir).find(n => fs.existsSync(path.join(dir, n, 'bin', 'javaw.exe')));
    return d && path.join(dir, d, 'bin', 'javaw.exe'); };
  let p = find(); if (p) return p;
  log(`Java ${major} downloading...`);
  const z = path.join(ROOT, 'java.zip');
  await dl(`https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/x64/jre/hotspot/normal/eclipse`, z);
  new AdmZip(z).extractAllTo(dir, true); fs.unlinkSync(z);
  return find();
}
const vdirs = () => fs.existsSync(path.join(ROOT, 'versions')) ? fs.readdirSync(path.join(ROOT, 'versions')) : [];

async function prepare(v, loader, java) {
  if (loader === 'vanilla') return {};
  if (loader === 'fabric') {
    const l = (await J(`https://meta.fabricmc.net/v2/versions/loader/${v}`))[0].loader.version;
    const id = `fabric-loader-${l}-${v}`, f = path.join(ROOT, 'versions', id, id + '.json');
    if (!fs.existsSync(f)) await dl(`https://meta.fabricmc.net/v2/versions/loader/${v}/${l}/profile/json`, f);
    return { custom: id };
  }
  let url, key;
  if (loader === 'forge') {
    const p = await J('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    const b = p.promos[`${v}-recommended`] || p.promos[`${v}-latest`];
    if (!b) throw new Error('Forge: no build for ' + v);
    url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${v}-${b}/forge-${v}-${b}-installer.jar`; key = b;
  } else {
    const xml = await (await fetch('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml')).text();
    const t = v.split('.'), pre = `${t[1]}.${t[2] || 0}.`;
    const all = [...xml.matchAll(/<version>([^<]+)/g)].map(m => m[1]).filter(s => s.startsWith(pre));
    const nv = all.filter(s => !s.includes('beta')).pop() || all.pop();
    if (!nv) throw new Error('NeoForge: no build for ' + v);
    url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${nv}/neoforge-${nv}-installer.jar`; key = nv;
  }
  const found = () => vdirs().find(d => d.toLowerCase().includes(loader) && d.includes(key));
  if (!found()) {
    log('Installing ' + loader + '...');
    const jar = path.join(ROOT, 'installer.jar');
    await dl(url, jar);
    fs.writeFileSync(path.join(ROOT, 'launcher_profiles.json'), '{"profiles":{}}');
    await runJar(jar, ['--installClient', ROOT], java);
  }
  return { custom: found() };
}

ipcMain.handle('play', async (e, { v, type, loader }) => {
  if (!auth) throw new Error('login');
  const java = await javaFor(v);
  const extra = await prepare(v, loader, java);
  const [host, port] = cfg.server.split(':');
  const o = { authorization: auth, root: ROOT, javaPath: java, overrides: { gameDirectory: igd() },
    version: { number: v, type: type === 'release' ? 'release' : 'snapshot', ...(extra.custom ? { custom: extra.custom } : {}) },
    memory: { max: cfg.ram + 'G', min: '1G' } };
  if (cfg.autoJoin) o.server = { host, port: port || '25565' };
  const l = new Client();
  l.on('debug', log); l.on('data', log);
  l.on('progress', p => win.webContents.send('progress', p));
  l.launch(o);
});

// ---- Modrinth: mods & modpacks ----
ipcMain.handle('mr:search', async (e, { q, kind, v, loader }) => {
  const f = [[`project_type:${kind}`]];
  if (kind === 'mod') { f.push([`versions:${v}`]); if (loader !== 'vanilla') f.push([`categories:${loader}`]); }
  return (await J(`https://api.modrinth.com/v2/search?limit=20&query=${encodeURIComponent(q)}&facets=${encodeURIComponent(JSON.stringify(f))}`)).hits;
});
ipcMain.handle('mr:install', async (e, { id, kind, v, loader }) => {
  const qs = kind === 'mod' ? `?game_versions=${encodeURIComponent(JSON.stringify([v]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}` : '';
  const vs = await J(`https://api.modrinth.com/v2/project/${id}/version${qs}`);
  if (!vs.length) throw new Error('No compatible version');
  const f = vs[0].files.find(x => x.primary) || vs[0].files[0];
  if (kind === 'mod') { await dl(f.url, path.join(igd(), 'mods', f.filename)); return {}; }
  const tmp = path.join(ROOT, 'pack.mrpack'); await dl(f.url, tmp);
  const z = new AdmZip(tmp), idx = JSON.parse(z.readAsText('modrinth.index.json'));
  cfg.inst = clean(idx.name || id); save();
  for (const x of idx.files) await dl(x.downloads[0], path.join(igd(), x.path));
  for (const en of z.getEntries()) if (!en.isDirectory && en.entryName.startsWith('overrides/')) {
    const out = path.join(igd(), en.entryName.slice(10)); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, en.getData());
  }
  const d = idx.dependencies, ld = ['fabric-loader', 'forge', 'neoforge'].find(k => d[k]);
  return { inst: cfg.inst, v: d.minecraft, loader: ld ? ld.replace('-loader', '') : 'vanilla' };
});

// ---- unified mod browser: Modrinth + CurseForge ----
const CF = 'https://api.curseforge.com/v1';
const cfj = async u => (await fetch(CF + u, { headers: { 'x-api-key': cfg.cfKey || '', Accept: 'application/json' } })).json();
const LDR = ['forge', 'fabric', 'neoforge', 'quilt'];
ipcMain.handle('mod:files', async (e, { src, id }) => {
  if (src === 'cf') return (await cfj(`/mods/${id}/files?pageSize=50`)).data.map(f => ({
    id: f.id, name: f.displayName, mc: f.gameVersions.filter(x => /^\d/.test(x)),
    loaders: f.gameVersions.map(x => x.toLowerCase()).filter(x => LDR.includes(x)) }));
  return (await J(`https://api.modrinth.com/v2/project/${id}/version`))
    .map(f => ({ id: f.id, name: f.version_number, mc: f.game_versions, loaders: f.loaders }));
});
async function mrGet(vid, depth, seen) {
  if (seen.has(vid)) return; seen.add(vid);
  const ver = await J(`https://api.modrinth.com/v2/version/${vid}`);
  const f = ver.files.find(x => x.primary) || ver.files[0];
  await dl(f.url, path.join(igd(), 'mods', path.basename(f.filename)));
  if (depth > 2) return;
  for (const d of ver.dependencies || []) if (d.dependency_type === 'required') {
    let id = d.version_id;
    if (!id && d.project_id) {
      const q = `?game_versions=${encodeURIComponent(JSON.stringify([ver.game_versions[0]]))}&loaders=${encodeURIComponent(JSON.stringify([ver.loaders[0]]))}`;
      const l = await J(`https://api.modrinth.com/v2/project/${d.project_id}/version${q}`); id = l[0] && l[0].id;
    }
    if (id) await mrGet(id, depth + 1, seen);
  }
}
ipcMain.handle('mods:list', () => { const d = path.join(igd(), 'mods'); return fs.existsSync(d) ? fs.readdirSync(d).filter(n => n.endsWith('.jar')) : []; });
ipcMain.handle('mods:del', (e, n) => { fs.unlinkSync(path.join(igd(), 'mods', path.basename(n))); });

ipcMain.handle('win', (e, a) => { if (a === 'min') win.minimize(); else if (a === 'max') win.isMaximized() ? win.unmaximize() : win.maximize(); else if (a === 'close') win.close(); });

// ---- profiles (instances) & installed versions ----
const meta = n => path.join(ROOT, 'instances', n, 'instance.json');
ipcMain.handle('inst:list', () => {
  const b = path.join(ROOT, 'instances'); fs.mkdirSync(path.join(b, 'Default'), { recursive: true });
  return fs.readdirSync(b).filter(n => fs.statSync(path.join(b, n)).isDirectory()).map(n => {
    let x = {}; try { x = JSON.parse(fs.readFileSync(meta(n))); } catch {} return { name: n, ver: x.ver, ldr: x.ldr }; });
});
ipcMain.handle('inst:create', (e, { name, ver, ldr }) => { const n = clean(name);
  fs.mkdirSync(path.join(ROOT, 'instances', n), { recursive: true }); fs.writeFileSync(meta(n), JSON.stringify({ ver, ldr })); return n; });
ipcMain.handle('inst:save', (e, { name, ver, ldr }) => { const n = clean(name);
  fs.mkdirSync(path.join(ROOT, 'instances', n), { recursive: true }); fs.writeFileSync(meta(n), JSON.stringify({ ver, ldr })); });
ipcMain.handle('inst:del', (e, name) => { const n = clean(name);
  fs.rmSync(path.join(ROOT, 'instances', n), { recursive: true, force: true });
  if (cfg.inst === n) { cfg.inst = 'Default'; save(); } });
ipcMain.handle('inst:open', (e, name) => shell.openPath(path.join(ROOT, 'instances', clean(name))));
ipcMain.handle('vers:list', () => vdirs());
ipcMain.handle('vers:del', (e, n) => { fs.rmSync(path.join(ROOT, 'versions', path.basename(n)), { recursive: true, force: true }); });

// ---- multiple player accounts ----
function offAuth(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex'), uuid = `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  return { access_token: uuid, client_token: uuid, uuid, name, user_properties: '{}', meta: { type: 'mojang', demo: false } };
}
if (cfg.user && !cfg.accounts) {
  cfg.accounts = cfg.user.type === 'off' ? [{ id: 'a0', type: 'off', name: cfg.user.name }] : [];
  cfg.acc = cfg.accounts[0] ? cfg.accounts[0].id : null; delete cfg.user; save();
}
const accs = () => cfg.accounts || (cfg.accounts = []);
async function useAcc(id) {
  auth = null; const a = accs().find(x => x.id === id); if (!a) return;
  if (a.type === 'off') { auth = offAuth(a.name); return; }
  const x = await new Auth('select_account').refresh(a.token), mc = await x.getMinecraft();
  auth = mc.mclc(); a.token = x.save(); a.name = mc.profile.name; save();
}
ipcMain.handle('acc:list', () => ({ acc: cfg.acc, list: accs().map(a => ({ id: a.id, type: a.type, name: a.name })) }));
ipcMain.handle('acc:add-off', async (e, n) => {
  if (!/^\w{3,16}$/.test(n)) throw new Error('3-16: A-Z 0-9 _');
  const a = { id: Date.now().toString(36), type: 'off', name: n }; accs().push(a); cfg.acc = a.id; save(); await useAcc(a.id);
});
ipcMain.handle('acc:add-ms', async () => {
  const x = await new Auth('select_account').launch('electron'), mc = await x.getMinecraft();
  const a = { id: Date.now().toString(36), type: 'ms', name: mc.profile.name, token: x.save() };
  accs().push(a); cfg.acc = a.id; save(); auth = mc.mclc();
});
ipcMain.handle('acc:select', async (e, id) => { cfg.acc = id; save(); await useAcc(id); });
ipcMain.handle('acc:del', (e, id) => {
  cfg.accounts = accs().filter(a => a.id !== id);
  if (cfg.acc === id) { cfg.acc = cfg.accounts[0] ? cfg.accounts[0].id : null; auth = null; if (cfg.acc) useAcc(cfg.acc).catch(() => {}); }
  save();
});
app.whenReady().then(() => { if (cfg.acc) useAcc(cfg.acc).catch(() => {}); });

// ---- Discover: mods / modpacks / resource packs / shaders ----
const MRS = ['relevance', 'downloads', 'follows', 'newest', 'updated'];
const CFLD = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 }, CFS = { relevance: 1, downloads: 6, follows: 2, newest: 11, updated: 3 };
ipcMain.handle('mod:search', async (e, { src, kind, q, v, loader, sort, page }) => {
  const off = (page || 0) * 20;
  if (src === 'cf') {
    if (!cfg.cfKey) throw new Error('nokey');
    const d = await cfj(`/mods/search?gameId=432&classId=6&pageSize=20&index=${off}&sortField=${CFS[sort] || 1}&sortOrder=desc&searchFilter=${encodeURIComponent(q || '')}` +
      (v ? `&gameVersion=${encodeURIComponent(v)}` : '') + (CFLD[loader] ? `&modLoaderType=${CFLD[loader]}` : ''));
    return { total: d.pagination ? d.pagination.totalCount : 0, hits: (d.data || []).map(x => ({ id: x.id, title: x.name, description: x.summary,
      icon: x.logo && x.logo.thumbnailUrl, author: x.authors && x.authors[0] && x.authors[0].name, downloads: x.downloadCount, follows: x.thumbsUpCount,
      cats: (x.categories || []).map(c => c.name) })) };
  }
  const f = [[`project_type:${kind}`]]; if (v) f.push([`versions:${v}`]); if (loader) f.push([`categories:${loader}`]);
  const d = await J(`https://api.modrinth.com/v2/search?limit=20&offset=${off}&index=${MRS.includes(sort) ? sort : 'relevance'}&query=${encodeURIComponent(q || '')}&facets=${encodeURIComponent(JSON.stringify(f))}`);
  return { total: d.total_hits, hits: d.hits.map(h => ({ id: h.project_id, title: h.title, description: h.description, icon: h.icon_url,
    author: h.author, downloads: h.downloads, follows: h.follows, cats: h.display_categories || h.categories || [] })) };
});
const safe = (b, r) => { const p = path.resolve(b, r); if (!p.startsWith(path.resolve(b) + path.sep)) throw new Error('bad path'); return p; };
async function installPack(url, name) {
  const tmp = path.join(ROOT, 'pack.mrpack'); await dl(url, tmp);
  const z = new AdmZip(tmp), idx = JSON.parse(z.readAsText('modrinth.index.json'));
  cfg.inst = clean(idx.name || name); save(); const base = igd();
  for (const x of idx.files) await dl(x.downloads[0], safe(base, x.path));
  for (const en of z.getEntries()) if (!en.isDirectory && en.entryName.startsWith('overrides/')) {
    const out = safe(base, en.entryName.slice(10)); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, en.getData());
  }
  const d = idx.dependencies, ld = ['fabric-loader', 'forge', 'neoforge'].find(k => d[k]);
  return { inst: cfg.inst, v: d.minecraft, loader: ld ? ld.replace('-loader', '') : 'vanilla' };
}
ipcMain.handle('mod:install', async (e, { src, id, fid, kind }) => {
  if (!/^\w+$/.test(String(fid))) throw new Error('bad id');
  if (src === 'cf') {
    const f = (await cfj(`/mods/${id}/files/${fid}`)).data;
    if (!f.downloadUrl) throw new Error('blocked');
    await dl(f.downloadUrl, path.join(igd(), 'mods', path.basename(f.fileName))); return 'ok';
  }
  if (!kind || kind === 'mod') { await mrGet(fid, 0, new Set()); return 'ok'; }
  const ver = await J(`https://api.modrinth.com/v2/version/${fid}`), f = ver.files.find(x => x.primary) || ver.files[0];
  if (kind === 'modpack') return installPack(f.url, String(id));
  await dl(f.url, path.join(igd(), kind === 'shader' ? 'shaderpacks' : 'resourcepacks', path.basename(f.filename))); return 'ok';
});
