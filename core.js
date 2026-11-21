/* Ядро анализа: общий код для браузера и Node (тесты). */
function createCore(Chess) {
  'use strict';

  const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };

  /* ---------- вероятность победы ---------- */
  // cp: сантипешки с точки зрения стороны, чей ход. Возвращает 0..1
  function winProb(cp, mate) {
    if (mate !== null && mate !== undefined) return mate > 0 ? 1 : mate < 0 ? 0 : 0.5;
    const c = Math.max(-1500, Math.min(1500, cp));
    return 1 / (1 + Math.exp(-0.00368208 * c));
  }

  /* ---------- материал ---------- */
  function matDiff(fen, color) {
    const placement = fen.split(' ')[0];
    let w = 0, b = 0;
    for (const ch of placement) {
      const v = VALUES[ch.toLowerCase()];
      if (!v) continue;
      if (ch === ch.toUpperCase()) w += v; else b += v;
    }
    return color === 'w' ? w - b : b - w;
  }

  /* ---------- UCI-сессия ---------- */
  class UciSession {
    constructor(send) {
      this.send = send;
      this.tokens = [];
      this.cur = null;
      this.multipv = 1;
    }
    feed(line) {
      if (typeof line !== 'string') return;
      if (line === 'uciok' || line === 'readyok') {
        const t = this.tokens.filter(x => x.token === line);
        this.tokens = this.tokens.filter(x => x.token !== line);
        t.forEach(x => x.resolve());
        return;
      }
      if (!this.cur) return;
      if (line.startsWith('info ')) {
        if (/ (lowerbound|upperbound)/.test(line)) return;
        const sc = line.match(/ score (cp|mate) (-?\d+)/);
        const pvm = line.match(/ pv (.+)$/);
        if (!sc || !pvm) return;
        const dm = line.match(/ depth (\d+)/);
        const mm = line.match(/ multipv (\d+)/);
        const idx = mm ? +mm[1] : 1;
        const depth = dm ? +dm[1] : 0;
        const prev = this.cur.lines[idx];
        if (prev && prev.depth > depth) return;
        this.cur.lines[idx] = {
          depth,
          cp: sc[1] === 'cp' ? +sc[2] : null,
          mate: sc[1] === 'mate' ? +sc[2] : null,
          pv: pvm[1].trim().split(/\s+/),
        };
      } else if (line.startsWith('bestmove')) {
        const c = this.cur;
        this.cur = null;
        const arr = Object.keys(c.lines).map(Number).sort((a, b) => a - b).map(k => c.lines[k]);
        c.resolve(arr);
      }
    }
    waitFor(token, ms) {
      return new Promise((resolve, reject) => {
        const entry = { token, resolve: () => { clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => {
          this.tokens = this.tokens.filter(x => x !== entry);
          reject(new Error('timeout:' + token));
        }, ms);
        this.tokens.push(entry);
      });
    }
    async init(timeoutMs) {
      let p = this.waitFor('uciok', timeoutMs);
      this.send('uci');
      await p;
      this.send('setoption name Hash value 32');
      this.send('setoption name MultiPV value 2');
      this.multipv = 2;
      p = this.waitFor('readyok', timeoutMs);
      this.send('isready');
      await p;
    }
    go(fen, depth) {
      return new Promise((resolve) => {
        this.cur = { lines: {}, resolve };
        this.send('position fen ' + fen);
        this.send('go depth ' + depth);
      });
    }
    stop() { this.send('stop'); }
  }

  /* ---------- нормализация линий движка ---------- */
  function normLines(lines) {
    return lines.map(l => ({
      cp: l.cp, mate: l.mate, pv: l.pv, depth: l.depth,
      wp: winProb(l.cp, l.mate),
    }));
  }

  /* ---------- песочница хода по PV ---------- */
  function sacrificeInfo(fenBefore, uciPlayed, pvAfter, mover) {
    const base = matDiff(fenBefore, mover);
    const g = new Chess(fenBefore);
    const mv = (u) => g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length > 4 ? u[4] : undefined });
    try { mv(uciPlayed); } catch (e) { return null; }
    let dReply = null, dEnd = null, mate = g.isCheckmate();
    if (mate) return { dReply: 0, dEnd: matDiff(g.fen(), mover) - base, mate: true };
    const pv = pvAfter || [];
    let plies = 0;
    for (let i = 0; i < pv.length && i < 4; i++) {
      try { mv(pv[i]); } catch (e) { break; }
      plies++;
      if (plies === 1) dReply = matDiff(g.fen(), mover) - base;
      if (plies % 2 === 0 || g.isCheckmate()) dEnd = matDiff(g.fen(), mover) - base;
      if (g.isCheckmate()) mate = true;
      if (g.isGameOver()) break;
    }
    if (dReply === null) dReply = matDiff(g.fen(), mover) - base;
    if (dEnd === null) dEnd = dReply;
    return { dReply, dEnd, mate };
  }

  /* ---------- категории ходов ---------- */
  const CLASSES = {
    legendary:  { sym: '!!!', name: 'Гениальный', order: 0 },
    brilliant:  { sym: '!!',  name: 'Блестящий',  order: 1 },
    great:      { sym: '!',   name: 'Сильный',    order: 2 },
    best:       { sym: '★',   name: 'Лучший',     order: 3 },
    excellent:  { sym: '✓',   name: 'Отличный',   order: 4 },
    good:       { sym: '•',   name: 'Хороший',    order: 5 },
    book:       { sym: '≡',   name: 'Теория',     order: 6 },
    inaccuracy: { sym: '?!',  name: 'Неточность', order: 7 },
    mistake:    { sym: '?',   name: 'Ошибка',     order: 8 },
    miss:       { sym: '✕',   name: 'Упущено',    order: 9 },
    blunder:    { sym: '??',  name: 'Зевок',      order: 10 },
  };

  function classifyMove(ctx) {
    // ctx: { ply, uci, fenBefore, mover, linesBefore, linesAfter, prevLoss }
    const L0 = ctx.linesBefore[0];
    const L1 = ctx.linesBefore[1] || null;
    const wpBest = L0.wp;
    const playedIdx = ctx.linesBefore.findIndex(l => l.pv[0] === ctx.uci);
    const isBest = playedIdx === 0;
    let wpAfter;
    if (playedIdx >= 0) wpAfter = ctx.linesBefore[playedIdx].wp;
    else if (ctx.linesAfter && ctx.linesAfter.length) wpAfter = 1 - ctx.linesAfter[0].wp;
    else wpAfter = ctx.terminalWp;
    let loss = Math.max(0, wpBest - wpAfter);
    if (isBest) loss = 0;

    let cls;
    if (isBest || loss <= 0.01) cls = 'best';
    else if (loss <= 0.025) cls = 'excellent';
    else if (loss <= 0.05) cls = 'good';
    else if (loss <= 0.10) cls = 'inaccuracy';
    else if (loss <= 0.20) cls = 'mistake';
    else cls = 'blunder';

    const gapToSecond = L1 ? wpBest - L1.wp : 0;
    const base = matDiff(ctx.fenBefore, ctx.mover);

    // Сильный: единственный хороший ход
    if (cls === 'best' && L1 && gapToSecond >= 0.12 && wpBest < 0.97 && wpAfter >= 0.35) cls = 'great';

    // Блестящий и гениальный: жертва, которая остаётся лучшим ходом
    let sac = null;
    if ((cls === 'best' || cls === 'great' || cls === 'excellent') && loss <= 0.03) {
      const pvAfter = ctx.linesAfter && ctx.linesAfter[0] ? ctx.linesAfter[0].pv : [];
      sac = sacrificeInfo(ctx.fenBefore, ctx.uci, pvAfter, ctx.mover);
      if (sac) {
        const realSac = sac.dReply <= -3 && (sac.dEnd <= -2 || sac.mate);
        const notAlreadyWon = base < 3 && wpAfter >= 0.45;
        if (realSac && notAlreadyWon) {
          cls = 'brilliant';
          const onlyWay = sac.mate || gapToSecond >= 0.2;
          if (-sac.dReply >= 5 && onlyWay) cls = 'legendary';
        }
      }
    }

    // Упущено: соперник дал шанс, а я его не использовал
    if ((cls === 'inaccuracy' || cls === 'mistake') && ctx.prevLoss >= 0.12 && wpBest >= 0.7) cls = 'miss';

    // Теория: ранние ходы без потерь
    if ((cls === 'best' || cls === 'excellent' || cls === 'good') && ctx.ply < 8 && loss <= 0.02 && wpBest > 0.42 && wpBest < 0.60) cls = 'book';

    return { cls, loss, wpBest, wpAfter, sac };
  }

  function accuracyOfMove(wpBest, wpAfter) {
    const drop = Math.max(0, (wpBest - wpAfter) * 100);
    const a = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
    return Math.max(0, Math.min(100, a));
  }

  /* ---------- анализ партии ---------- */
  function parseGame(pgn) {
    const g = new Chess();
    g.loadPgn(pgn);
    const headers = g.getHeaders ? g.getHeaders() : g.header();
    const moves = g.history({ verbose: true });
    const startFen = moves.length ? moves[0].before : g.fen();
    return { headers, moves, startFen };
  }

  async function analyzeGame(pgn, session, opts, onProgress) {
    const depth = (opts && opts.depth) || 14;
    const { headers, moves, startFen } = parseGame(pgn);
    if (!moves.length) throw new Error('В партии нет ходов');

    const fens = [startFen].concat(moves.map(m => m.after));
    const evals = new Array(fens.length);
    for (let i = 0; i < fens.length; i++) {
      const g = new Chess(fens[i]);
      if (g.isGameOver()) {
        const mated = g.isCheckmate();
        evals[i] = { terminal: true, lines: [], wp: mated ? 0 : 0.5, mated };
      } else {
        const lines = normLines(await session.go(fens[i], depth));
        if (!lines.length) throw new Error('Движок не вернул оценку');
        evals[i] = { terminal: false, lines, wp: lines[0].wp };
      }
      if (onProgress) onProgress(i + 1, fens.length);
    }

    const out = [];
    let prevLoss = 0;
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      const uci = m.from + m.to + (m.promotion || '');
      const after = evals[i + 1];
      const res = classifyMove({
        ply: i,
        uci,
        fenBefore: fens[i],
        mover: m.color,
        linesBefore: evals[i].lines,
        linesAfter: after.terminal ? null : after.lines,
        terminalWp: after.terminal ? (after.mated ? 1 : 0.5) : 0.5,
        prevLoss,
      });
      prevLoss = res.loss;
      // оценка после хода с точки зрения белых
      const whiteWpAfter = after.terminal
        ? (after.mated ? (m.color === 'w' ? 1 : 0) : 0.5)
        : (m.color === 'w' ? 1 - after.lines[0].wp : after.lines[0].wp);
      const l0 = after.terminal ? null : after.lines[0];
      let evalAfter = null; // с точки зрения белых
      if (after.terminal) evalAfter = { mate: after.mated ? 0 : null, cp: after.mated ? null : 0 };
      else {
        const sign = m.color === 'w' ? -1 : 1; // l0 с точки зрения соперника
        evalAfter = { cp: l0.cp === null ? null : sign * l0.cp, mate: l0.mate === null ? null : sign * l0.mate };
      }
      const best = evals[i].lines[0];
      let bestSan = null;
      try {
        const g = new Chess(fens[i]);
        const b = best.pv[0];
        const bm = g.move({ from: b.slice(0, 2), to: b.slice(2, 4), promotion: b.length > 4 ? b[4] : undefined });
        bestSan = bm.san;
      } catch (e) { /* ignore */ }
      out.push({
        ply: i,
        san: m.san,
        uci,
        color: m.color,
        from: m.from,
        to: m.to,
        fen: m.after,
        cls: res.cls,
        loss: +res.loss.toFixed(4),
        acc: +accuracyOfMove(res.wpBest, res.wpAfter).toFixed(2),
        whiteWp: +whiteWpAfter.toFixed(4),
        evalAfter,
        bestSan,
        isBest: uci === best.pv[0],
      });
    }
    const startEval = evals[0].terminal ? { cp: 0, mate: null, wp: 0.5 } : (() => {
      const l = evals[0].lines[0];
      return { cp: l.cp, mate: l.mate, wp: l.wp };
    })();
    const whiteToMove = startFen.split(' ')[1] !== 'b';
    const startWhiteWp = whiteToMove ? startEval.wp : 1 - startEval.wp;
    return { headers, startFen, startWp: +startWhiteWp.toFixed(4), depth, moves: out };
  }

  function summarize(moves) {
    const res = { w: { acc: 0, n: 0, counts: {} }, b: { acc: 0, n: 0, counts: {} } };
    for (const m of moves) {
      const s = res[m.color];
      s.acc += m.acc; s.n++;
      s.counts[m.cls] = (s.counts[m.cls] || 0) + 1;
    }
    for (const k of ['w', 'b']) res[k].acc = res[k].n ? +(res[k].acc / res[k].n).toFixed(1) : 0;
    return res;
  }

  return { UciSession, analyzeGame, summarize, parseGame, classifyMove, winProb, CLASSES, matDiff };
}
if (typeof module !== 'undefined' && module.exports) module.exports = createCore;
