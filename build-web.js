// Собирает папку www: страница приложения, движок Stockfish и разбор примера партии.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { Chess } = require('chess.js');
const createCore = require('./core.js');

const root = __dirname;
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const safe = (x) => x.replace(/<\/script/gi, '<\\/script');

const PGN = `[Event "Paris Opera"]
[Site "Paris FRA"]
[Date "1858.??.??"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`;

// 1. chess.js в один скрипт для страницы
function bundleChess() {
  const out = esbuild.buildSync({
    entryPoints: [path.join(root, 'chess-entry.js')],
    bundle: true, minify: true, format: 'iife', write: false,
  });
  return out.outputFiles[0].text;
}

// 2. разбор примера партии настоящим движком (запускается один раз при сборке)
async function analyzeSample(depth) {
  const core = createCore(Chess);
  const stockfish = require('stockfish');
  let session;
  const eng = stockfish('lite-single', (line) => session && session.feed(line));
  session = new core.UciSession((c) => eng.processCommand(c));
  try {
    await session.init(30000);
    return await core.analyzeGame(PGN, session, { depth }, () => {});
  } finally {
    try { eng.terminate(); } catch (e) { /* ignore */ }
  }
}

(async () => {
  const tpl = read('page.template.html');
  const marker = '<div class="wrap">';
  const cut = tpl.indexOf(marker);
  if (cut < 0) throw new Error('В шаблоне нет блока .wrap');
  const headPart = tpl.slice(0, cut);
  const bodyPart = tpl.slice(cut);

  console.log('Разбираю пример партии…');
  const analysis = await analyzeSample(16);
  const sample = JSON.stringify({ pgn: PGN, analysis }).replace(/</g, '\\u003c');

  const body = bodyPart
    .replace('/*CHESS*/', () => safe(bundleChess()))
    .replace('/*CORE*/', () => safe(read('core.js')))
    .replace('/*SAMPLE*/null', () => sample);

  const appHead = `<!doctype html>
<html lang="ru">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d131a">
<style>
html { color-scheme: light dark; }
body { margin: 0; -webkit-tap-highlight-color: transparent; }
:root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
</style>
`;
  const html = appHead + headPart + '</head>\n<body>\n' + body + '\n</body>\n</html>\n';

  const www = path.join(root, 'www');
  fs.rmSync(www, { recursive: true, force: true });
  fs.mkdirSync(www, { recursive: true });
  fs.writeFileSync(path.join(www, 'index.html'), html);

  const bin = path.join(root, 'node_modules', 'stockfish', 'bin');
  const engines = [
    'stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm',
    'stockfish-19-single.js', 'stockfish-19-single.wasm',
    'stockfish-19-asm.js',
  ];
  for (const f of engines) {
    const from = path.join(bin, f);
    if (!fs.existsSync(from)) throw new Error('Нет файла движка: ' + f);
    fs.copyFileSync(from, path.join(www, f));
  }
  console.log('www готов:', fs.readdirSync(www).join(', '));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
