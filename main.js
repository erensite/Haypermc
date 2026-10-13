const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'), fs = require('fs'), { execFile } = require('child_process');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const AdmZip = require('adm-zip');

const ROOT = path.join(app.getPath('appData'), '.haypermc');
const CFG = path.join(ROOT, 'config.json');
fs.mkdirSync(ROOT, { recursive: true });
const defaults = { lang: null, autoJoin: true, server: 'play.HayperMC.com', ram: 4, user: null };
let cfg = { ...defaults, ...(fs.existsSync(CFG) ? JSON.parse(fs.readFileSync(CFG)) : {}) };
const save = () => fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
let win, auth = null;

app.whenReady().then(() => {
  win = new BrowserWindow({ width: 1000, height: 660, backgroundColor: '#0b0b14',
    webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  win.setMenu(null); win.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());

const J = async u => (await fetch(u, { headers: { 'User-Agent': 'HayperMC-Launcher/1.0' } })).json();
const dl = async (u, f) => { fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.from(await (await fetch(u)).arrayBuffer())); };
const log = m => win && win.webContents.send('log', m);

ipcMain.handle('cfg:get', () => cfg);
ipcMain.handle('cfg:set', (e, p) => { cfg = { ...cfg, ...p }; save(); return cfg; });

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
ipcMain.handle('login:ms', async () => {
  const x = await new Auth('select_account').launch('electron');
  const mc = await x.getMinecraft();
  auth = mc.mclc(); cfg.user = { type: 'ms', name: mc.profile.name }; save(); return cfg.user;
});
ipcMain.handle('login:off', (e, name) => {
  auth = Authenticator.getAuth(name); cfg.user = { type: 'off', name }; save(); return cfg.user;
});

// ---- loaders ----
const runJar = (jar, args) => new Promise((res, rej) =>
  execFile('java', ['-jar', jar, ...args], { cwd: ROOT }, e => e ? rej(e) : res()));
const vdirs = () => fs.existsSync(path.join(ROOT, 'versions')) ? fs.readdirSync(path.join(ROOT, 'versions')) : [];

async function prepare(v, loader) {
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
    await runJar(jar, ['--installClient', ROOT]);
  }
  return { custom: found() };
}

ipcMain.handle('play', async (e, { v, type, loader }) => {
  if (!auth) throw new Error('login');
  const extra = await prepare(v, loader);
  const [host, port] = cfg.server.split(':');
  const o = { authorization: auth, root: ROOT,
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
  if (kind === 'mod') { await dl(f.url, path.join(ROOT, 'mods', f.filename)); return {}; }
  const tmp = path.join(ROOT, 'pack.mrpack'); await dl(f.url, tmp);
  const z = new AdmZip(tmp), idx = JSON.parse(z.readAsText('modrinth.index.json'));
  for (const x of idx.files) await dl(x.downloads[0], path.join(ROOT, x.path));
  for (const en of z.getEntries()) if (!en.isDirectory && en.entryName.startsWith('overrides/')) {
    const out = path.join(ROOT, en.entryName.slice(10)); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, en.getData());
  }
  const d = idx.dependencies, ld = ['fabric-loader', 'forge', 'neoforge'].find(k => d[k]);
  return { v: d.minecraft, loader: ld ? ld.replace('-loader', '') : 'vanilla' };
});
