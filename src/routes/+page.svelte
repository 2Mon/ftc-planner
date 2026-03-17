<script>
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import jsQR from 'jsqr';

  // ── State ────────────────────────────────────────────────────────────────────
  let teams = $state([
    { id: 0, number: '', color: '#ef5350', alliance: 'red',  slot: 0, visible: true, paths: { auto: [], teleop: [] }, notes: { auto: '', teleop: '' }, auto: { close: false, far: false, scored: 0, classified: 0 }, cycles: 0 },
    { id: 1, number: '', color: '#ff7043', alliance: 'red',  slot: 1, visible: true, paths: { auto: [], teleop: [] }, notes: { auto: '', teleop: '' }, auto: { close: false, far: false, scored: 0, classified: 0 }, cycles: 0 },
    { id: 2, number: '', color: '#42a5f5', alliance: 'blue', slot: 0, visible: true, paths: { auto: [], teleop: [] }, notes: { auto: '', teleop: '' }, auto: { close: false, far: false, scored: 0, classified: 0 }, cycles: 0 },
    { id: 3, number: '', color: '#7e57c2', alliance: 'blue', slot: 1, visible: true, paths: { auto: [], teleop: [] }, notes: { auto: '', teleop: '' }, auto: { close: false, far: false, scored: 0, classified: 0 }, cycles: 0 },
  ]);
  let matchNumber = $state('');
  let score       = $state({ red: '', blue: '', notes: '' });
  let phase       = $state('auto');
  let tool        = $state('draw');
  let activeId    = $state(0);

  let redTeams  = $derived(teams.filter(t => t.alliance === 'red'));
  let blueTeams = $derived(teams.filter(t => t.alliance === 'blue'));
  let active    = $derived(teams.find(t => t.id === activeId) ?? teams[0]);

  // ── Undo / redo ──────────────────────────────────────────────────────────────
  let undoStack = $state([]);
  let redoStack = $state([]);

  function snap() {
    return teams.map(t => ({ id: t.id, paths: JSON.parse(JSON.stringify(t.paths)) }));
  }
  function pushUndo() {
    undoStack = [...undoStack.slice(-59), snap()];
    redoStack = [];
  }
  function applySnap(s) {
    teams = teams.map(t => { const f = s.find(x => x.id === t.id); return f ? { ...t, paths: f.paths } : t; });
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack = [...redoStack, snap()];
    applySnap(undoStack.at(-1));
    undoStack = undoStack.slice(0, -1);
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack = [...undoStack, snap()];
    applySnap(redoStack.at(-1));
    redoStack = redoStack.slice(0, -1);
  }

  // ── Team helpers ──────────────────────────────────────────────────────────────
  function setTeam(id, patch) {
    teams = teams.map(t => t.id === id ? { ...t, ...patch } : t);
  }
  function clearActive() {
    const t = teams.find(t => t.id === activeId);
    if (!t) return;
    pushUndo();
    teams = teams.map(t => t.id === activeId ? { ...t, paths: { ...t.paths, [phase]: [] } } : t);
  }

  // ── Path simplification (Ramer–Douglas–Peucker) ───────────────────────────────
  function simplify(path, eps = 0.006) {
    if (path.length <= 2) return path;
    function rdp(pts) {
      if (pts.length <= 2) return pts;
      const [x1, y1] = [pts[0].x, pts[0].y], [x2, y2] = [pts.at(-1).x, pts.at(-1).y];
      const len = Math.hypot(x2 - x1, y2 - y1);
      let max = 0, idx = 0;
      for (let i = 1; i < pts.length - 1; i++) {
        const d = len < 1e-9
          ? Math.hypot(pts[i].x - x1, pts[i].y - y1)
          : Math.abs((y2 - y1) * pts[i].x - (x2 - x1) * pts[i].y + x2 * y1 - y2 * x1) / len;
        if (d > max) { max = d; idx = i; }
      }
      if (max > eps) return [...rdp(pts.slice(0, idx + 1)).slice(0, -1), ...rdp(pts.slice(idx))];
      return [pts[0], pts.at(-1)];
    }
    return rdp(path);
  }

  // ── Serialise / deserialise ───────────────────────────────────────────────────
  const tf  = p => ({ x: +((p.x - 0.5) * 144).toFixed(1), y: +((0.5 - p.y) * 144).toFixed(1) });
  const ftf = p => ({ x: +(p.x / 144 + 0.5).toFixed(4), y: +(0.5 - p.y / 144).toFixed(4) });

  function encodeAlliance(alliance) {
    const ts = teams.filter(t => t.alliance === alliance);
    return ts.map(t => ({
      number: t.number, cycles: t.cycles,
      notes: t.notes,
      auto: t.auto,
      paths: {
        auto:   t.paths.auto.map(p => simplify(p).map(tf)),
        teleop: t.paths.teleop.map(p => simplify(p).map(tf)),
      },
    }));
  }

  function buildQRPayload(alliance) {
    return { match: matchNumber, alliance, teams: encodeAlliance(alliance) };
  }

  function mergeFromPayload(payload) {
    const fromField = p => p.map(ftf);
    payload.teams.forEach((src, slot) => {
      const t = teams.find(t => t.alliance === payload.alliance && t.slot === slot);
      if (!t) return;
      teams = teams.map(x => x.id !== t.id ? x : {
        ...x,
        number: src.number ?? x.number,
        cycles: src.cycles ?? x.cycles,
        notes:  src.notes  ?? x.notes,
        auto:   src.auto   ?? x.auto,
        paths: {
          auto:   (src.paths?.auto   ?? []).map(fromField),
          teleop: (src.paths?.teleop ?? []).map(fromField),
        },
      });
    });
    if (payload.match) matchNumber = payload.match;
  }

  function exportFullJSON() {
    const serTeam = t => ({
      team: t.number, cycles: t.cycles,
      auto:   { ...t.auto, notes: t.notes.auto,   paths: t.paths.auto.map(p => simplify(p).map(tf)) },
      teleop: { notes: t.notes.teleop, paths: t.paths.teleop.map(p => simplify(p).map(tf)) },
    });
    const payload = { match: matchNumber, score,
      alliances: { red: redTeams.map(serTeam), blue: blueTeams.map(serTeam) } };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    a.download = `match-${matchNumber || 'scouting'}.json`;
    a.click();
  }

  // ── Overlays ──────────────────────────────────────────────────────────────────
  let showSetup   = $state(false);
  let showImport  = $state(false);
  let showShareQR = $state(false);
  let showScanQR  = $state(false);
  let importText  = $state('');
  let importError = $state('');
  let qrAlliance  = $state('red');
  let qrImageURL  = $state('');
  let qrByteSize  = $state(0);
  let scanError   = $state('');
  let scanSuccess = $state('');
  let draft = $state({ match: '', r0: '', r1: '', b0: '', b1: '' });

  function openSetup() {
    draft = { match: matchNumber,
      r0: redTeams[0]?.number ?? '', r1: redTeams[1]?.number ?? '',
      b0: blueTeams[0]?.number ?? '', b1: blueTeams[1]?.number ?? '' };
    showSetup = true;
  }
  function applySetup() {
    matchNumber = draft.match;
    teams = teams.map(t => {
      if (t.alliance === 'red'  && t.slot === 0) return { ...t, number: draft.r0 };
      if (t.alliance === 'red'  && t.slot === 1) return { ...t, number: draft.r1 };
      if (t.alliance === 'blue' && t.slot === 0) return { ...t, number: draft.b0 };
      if (t.alliance === 'blue' && t.slot === 1) return { ...t, number: draft.b1 };
      return t;
    });
    showSetup = false;
  }

  function openShareQR(alliance) {
    qrAlliance = alliance;
    qrImageURL = '';
    showShareQR = true;
    const payload = buildQRPayload(alliance);
    const json = JSON.stringify(payload);
    qrByteSize = json.length;
    if (json.length > 2800) { qrImageURL = '__toobig__'; return; }
    const encoded = btoa(unescape(encodeURIComponent(json)));
    qrImageURL = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&ecc=L&data=${encodeURIComponent(encoded)}`;
  }

  function doImport() {
    importError = '';
    try {
      const data = JSON.parse(importText);
      if (data.alliance && data.teams) {
        mergeFromPayload(data);
      } else if (data.alliances) {
        // full export format
        const fromField = p => p.map(ftf);
        ['red', 'blue'].forEach(a => {
          (data.alliances[a] ?? []).forEach((src, slot) => {
            const t = teams.find(t => t.alliance === a && t.slot === slot);
            if (!t) return;
            teams = teams.map(x => x.id !== t.id ? x : {
              ...x, number: src.team ?? x.number, cycles: src.cycles ?? x.cycles,
              notes: { auto: src.auto?.notes ?? '', teleop: src.teleop?.notes ?? '' },
              auto: { close: src.auto?.close ?? false, far: src.auto?.far ?? false,
                      scored: src.auto?.scored ?? 0, classified: src.auto?.classified ?? 0 },
              paths: { auto: (src.auto?.paths ?? []).map(fromField), teleop: (src.teleop?.paths ?? []).map(fromField) },
            });
          });
        });
        if (data.match) matchNumber = data.match;
        if (data.score) score = data.score;
      } else throw new Error('Unrecognised format');
      showImport = false; importText = '';
    } catch(e) { importError = e.message; }
  }

  function loadFromFile(e) {
    const f = e.target.files?.[0]; if (!f) return;
    const fr = new FileReader();
    fr.onload = ev => { importText = ev.target.result; };
    fr.readAsText(f);
  }

  // ── QR scanner ────────────────────────────────────────────────────────────────
  let videoEl  = $state(null);
  let scanCanvas = $state(null);
  let scanStream = null;
  let scanRAF    = null;

  async function startScan() {
    scanError = ''; scanSuccess = '';
    showScanQR = true;
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      await new Promise(r => setTimeout(r, 50));
      if (!videoEl) { scanError = 'Camera element not ready'; return; }
      videoEl.srcObject = scanStream;
      await videoEl.play();
      scanLoop();
    } catch(e) {
      scanError = `Camera error: ${e.message}`;
    }
  }

  function scanLoop() {
    if (!videoEl || !scanCanvas || videoEl.readyState < 2) {
      scanRAF = requestAnimationFrame(scanLoop); return;
    }
    const W = videoEl.videoWidth, H = videoEl.videoHeight;
    if (!W || !H) { scanRAF = requestAnimationFrame(scanLoop); return; }
    scanCanvas.width = W; scanCanvas.height = H;
    const ctx = scanCanvas.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, W, H);
    const imgData = ctx.getImageData(0, 0, W, H);
    const result = jsQR(imgData.data, W, H);
    if (result) {
      try {
        const raw = decodeURIComponent(escape(atob(result.data)));
        const payload = JSON.parse(raw);
        mergeFromPayload(payload);
        scanSuccess = `Merged ${payload.alliance} alliance data!`;
        stopScan();
        setTimeout(() => { scanSuccess = ''; showScanQR = false; }, 1800);
        return;
      } catch {
        // not our QR, keep scanning
      }
    }
    scanRAF = requestAnimationFrame(scanLoop);
  }

  function stopScan() {
    if (scanRAF) { cancelAnimationFrame(scanRAF); scanRAF = null; }
    if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  }

  async function downloadQR() {
    const res = await fetch(qrImageURL);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ftc-${qrAlliance}-alliance-qr.png`;
    a.click();
  }

  // ── Canvas / drawing ──────────────────────────────────────────────────────────
  let canvas = $state(null);
  let isDrawing = false;
  let currentPath = [];
  let FIELD = null;

  function getPos(e) {
    const rect = canvas.getBoundingClientRect(), src = e.touches ? e.touches[0] : e;
    return { x: (src.clientX - rect.left) / rect.width, y: (src.clientY - rect.top) / rect.height };
  }
  function onStart(e) { e.preventDefault(); isDrawing = true; currentPath = [getPos(e)]; }
  function onMove(e) {
    if (!isDrawing) return; e.preventDefault();
    const pos = getPos(e), prev = currentPath.at(-1);
    const dx = (pos.x - prev.x) * 600, dy = (pos.y - prev.y) * 600;
    if (dx * dx + dy * dy < 4) return;
    currentPath = [...currentPath, pos];
    redraw(currentPath);
  }
  function onEnd(e) {
    if (!isDrawing) return; e?.preventDefault?.();
    isDrawing = false;
    const path = [...currentPath]; currentPath = [];
    if (path.length < 2) return;
    pushUndo();
    if (tool === 'draw') {
      teams = teams.map(t => t.id === activeId
        ? { ...t, paths: { ...t.paths, [phase]: [...t.paths[phase], path] } } : t);
    } else {
      teams = teams.map(t => t.id === activeId
        ? { ...t, paths: { ...t.paths, [phase]: t.paths[phase].filter(stroke =>
            !stroke.some(pt => path.some(ep => Math.hypot((pt.x - ep.x) * 600, (pt.y - ep.y) * 600) < 16))
          )}} : t);
    }
  }

  function redraw(live = null) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (FIELD?.complete && FIELD.naturalWidth) {
      ctx.save(); ctx.translate(W, 0); ctx.rotate(Math.PI / 2);
      ctx.drawImage(FIELD, 0, 0, H, W); ctx.restore();
    } else { ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, 0, W, H); }

    teams.filter(t => t.visible).forEach(team => {
      const isActive = team.id === activeId;
      ctx.strokeStyle = team.color; ctx.lineWidth = isActive ? 3 : 2;
      ctx.globalAlpha = isActive ? 1 : 0.45;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      team.paths[phase].forEach(path => {
        if (path.length < 2) return;
        ctx.beginPath(); ctx.moveTo(path[0].x * W, path[0].y * H);
        path.slice(1).forEach(p => ctx.lineTo(p.x * W, p.y * H)); ctx.stroke();
        ctx.beginPath(); ctx.arc(path[0].x * W, path[0].y * H, 4, 0, Math.PI * 2);
        ctx.fillStyle = team.color; ctx.fill();
        const last = path.at(-1), prev = path[Math.max(0, path.length - 4)];
        const ang = Math.atan2((last.y - prev.y) * H, (last.x - prev.x) * W), al = 10;
        ctx.beginPath();
        ctx.moveTo(last.x * W, last.y * H);
        ctx.lineTo(last.x * W - al * Math.cos(ang - 0.4), last.y * H - al * Math.sin(ang - 0.4));
        ctx.moveTo(last.x * W, last.y * H);
        ctx.lineTo(last.x * W - al * Math.cos(ang + 0.4), last.y * H - al * Math.sin(ang + 0.4));
        ctx.stroke();
      });
    });
    ctx.globalAlpha = 1;
    if (live?.length >= 2) {
      ctx.strokeStyle = tool === 'erase' ? 'rgba(255,255,255,0.4)' : (active?.color ?? '#fff');
      ctx.lineWidth = tool === 'erase' ? 18 : 3; ctx.globalAlpha = 0.8;
      ctx.setLineDash(tool === 'erase' ? [6, 3] : []);
      ctx.beginPath(); ctx.moveTo(live[0].x * W, live[0].y * H);
      live.slice(1).forEach(p => ctx.lineTo(p.x * W, p.y * H)); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
  }

  $effect(() => { teams; phase; activeId; redraw(); });

  onMount(() => {
    FIELD = new Image();
    FIELD.src = `${base}/field.png`;
    FIELD.onload = () => redraw();

    const ro = new ResizeObserver(() => {
      canvas.width = canvas.parentElement.clientWidth;
      canvas.height = canvas.parentElement.clientWidth;
      redraw();
    });
    ro.observe(canvas.parentElement);

    const onKey = e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { ro.disconnect(); window.removeEventListener('keydown', onKey); stopScan(); };
  });
</script>

<div class="app">
  <header>
    <span class="logo">FTC Scout</span>
    {#if matchNumber}<span class="match-chip">Match {matchNumber}</span>{/if}
    <div class="phase-btns">
      <button class:active={phase === 'auto'}   onclick={() => phase = 'auto'}>Auto</button>
      <button class:active={phase === 'teleop'} onclick={() => phase = 'teleop'}>Teleop</button>
    </div>
    <div class="hdr-actions">
      <button onclick={openSetup}>⊞ Setup</button>
      <button onclick={() => { importText = ''; importError = ''; showImport = true; }}>↑ Import</button>
      <button onclick={exportFullJSON}>↓ Export</button>
      <button class="scan-btn" onclick={startScan}>📷 Scan QR</button>
    </div>
  </header>

  <main>
    <section class="field-col">
      <div class="toolbar">
        <button class:active={tool === 'draw'}  onclick={() => tool = 'draw'}>✏ Draw</button>
        <button class:active={tool === 'erase'} onclick={() => tool = 'erase'}>⌫ Erase</button>
        <button class="danger" onclick={clearActive}>Clear</button>
        <button onclick={undo} disabled={!undoStack.length} title="Ctrl+Z">↩ Undo</button>
        <button onclick={redo} disabled={!redoStack.length} title="Ctrl+Y">↪ Redo</button>
        {#if active}
          <span class="cur" style="color:{active.color}">{active.number || '—'} · {phase}</span>
        {/if}
      </div>
      <div class="canvas-wrap">
        <canvas bind:this={canvas}
          onmousedown={onStart} onmousemove={onMove} onmouseup={onEnd} onmouseleave={onEnd}
          ontouchstart={onStart} ontouchmove={onMove} ontouchend={onEnd}></canvas>
      </div>
    </section>

    <aside>
      <!-- Red alliance -->
      <div class="a-header red">
        Red Alliance
        <button class="share-qr-btn" onclick={() => openShareQR('red')}>Share QR</button>
      </div>
      {#each redTeams as team (team.id)}
        <div class="team-row" class:active-row={team.id === activeId} style="--c:{team.color}"
          onclick={() => activeId = team.id} role="button" tabindex="0"
          onkeydown={e => e.key === 'Enter' && (activeId = team.id)}>
          <span class="dot" class:dim={!team.visible}></span>
          <span class="tnum">{team.number || '—'}</span>
          {#if phase === 'teleop'}
            <div class="cycle-ctrl" onclick={e => e.stopPropagation()} onkeydown={() => {}}>
              <button onclick={() => setTeam(team.id, { cycles: Math.max(0, team.cycles - 1) })}>−</button>
              <span class="cycle-num">{team.cycles}</span>
              <button onclick={() => setTeam(team.id, { cycles: team.cycles + 1 })}>+</button>
            </div>
          {:else}
            <span class="pcnt">{team.paths[phase].length}p</span>
          {/if}
          <button class="ico" onclick={e => { e.stopPropagation(); setTeam(team.id, { visible: !team.visible }); }}>
            {team.visible ? '👁' : '🙈'}
          </button>
        </div>
      {/each}

      <!-- Blue alliance -->
      <div class="a-header blue" style="margin-top:10px">
        Blue Alliance
        <button class="share-qr-btn blue" onclick={() => openShareQR('blue')}>Share QR</button>
      </div>
      {#each blueTeams as team (team.id)}
        <div class="team-row" class:active-row={team.id === activeId} style="--c:{team.color}"
          onclick={() => activeId = team.id} role="button" tabindex="0"
          onkeydown={e => e.key === 'Enter' && (activeId = team.id)}>
          <span class="dot" class:dim={!team.visible}></span>
          <span class="tnum">{team.number || '—'}</span>
          {#if phase === 'teleop'}
            <div class="cycle-ctrl" onclick={e => e.stopPropagation()} onkeydown={() => {}}>
              <button onclick={() => setTeam(team.id, { cycles: Math.max(0, team.cycles - 1) })}>−</button>
              <span class="cycle-num">{team.cycles}</span>
              <button onclick={() => setTeam(team.id, { cycles: team.cycles + 1 })}>+</button>
            </div>
          {:else}
            <span class="pcnt">{team.paths[phase].length}p</span>
          {/if}
          <button class="ico" onclick={e => { e.stopPropagation(); setTeam(team.id, { visible: !team.visible }); }}>
            {team.visible ? '👁' : '🙈'}
          </button>
        </div>
      {/each}

      {#if active}
        <div class="sec-title" style="margin-top:14px">
          Notes — <span style="color:{active.color}">{active.number || '—'}</span> · {phase}
        </div>
        {#if phase === 'auto'}
          <div class="auto-grid">
            <label class="cb-label">
              <input type="checkbox" checked={active.auto.close}
                onchange={e => setTeam(activeId, { auto: { ...active.auto, close: e.target.checked } })} />
              Close auto
            </label>
            <label class="cb-label">
              <input type="checkbox" checked={active.auto.far}
                onchange={e => setTeam(activeId, { auto: { ...active.auto, far: e.target.checked } })} />
              Far auto
            </label>
            <label class="count-label">
              <span>Scored</span>
              <input type="number" min="0" max="20" value={active.auto.scored}
                oninput={e => setTeam(activeId, { auto: { ...active.auto, scored: +e.target.value } })} />
            </label>
            <label class="count-label">
              <span>Classified</span>
              <input type="number" min="0" max="20" value={active.auto.classified}
                oninput={e => setTeam(activeId, { auto: { ...active.auto, classified: +e.target.value } })} />
            </label>
          </div>
        {/if}
        <textarea value={active.notes[phase]}
          oninput={e => setTeam(activeId, { notes: { ...active.notes, [phase]: e.target.value } })}
          placeholder={phase === 'auto' ? 'Route, starting position, strategy...' : 'Teleop strategy, endgame, notes...'}></textarea>
      {/if}

      <div class="sec-title" style="margin-top:14px">Final Score</div>
      <div class="score-grid">
        <label class="score-label red">
          <span>Red</span>
          <input type="number" min="0" bind:value={score.red} placeholder="0" />
        </label>
        <label class="score-label blue">
          <span>Blue</span>
          <input type="number" min="0" bind:value={score.blue} placeholder="0" />
        </label>
      </div>
      {#if score.red !== '' && score.blue !== ''}
        <div class="winner" class:red-win={+score.red > +score.blue} class:blue-win={+score.blue > +score.red}>
          {+score.red > +score.blue ? '🔴 Red wins' : +score.blue > +score.red ? '🔵 Blue wins' : '🤝 Tie'}
          &nbsp;·&nbsp;{Math.abs(+score.red - +score.blue)} pt margin
        </div>
      {/if}
      <textarea class="score-notes" bind:value={score.notes} placeholder="Post-match observations..."></textarea>
    </aside>
  </main>
</div>

<!-- Match Setup -->
{#if showSetup}
  <div class="overlay" onclick={() => showSetup = false} role="dialog" aria-modal="true">
    <div class="modal" onclick={e => e.stopPropagation()} onkeydown={() => {}}>
      <div class="modal-title">Match Setup</div>
      <label class="field-label">Match Number</label>
      <input class="mi" bind:value={draft.match} placeholder="e.g. 42" />
      <div class="a-section">
        <div class="a-header red" style="border:none;padding:0">Red Alliance</div>
        <div class="two-col">
          <input class="mi" bind:value={draft.r0} placeholder="Team 1" />
          <input class="mi" bind:value={draft.r1} placeholder="Team 2" />
        </div>
      </div>
      <div class="a-section">
        <div class="a-header blue" style="border:none;padding:0">Blue Alliance</div>
        <div class="two-col">
          <input class="mi" bind:value={draft.b0} placeholder="Team 1" />
          <input class="mi" bind:value={draft.b1} placeholder="Team 2" />
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" onclick={() => showSetup = false}>Cancel</button>
        <button class="btn-apply" onclick={applySetup}>Apply</button>
      </div>
    </div>
  </div>
{/if}

<!-- Import JSON -->
{#if showImport}
  <div class="overlay" onclick={() => showImport = false} role="dialog" aria-modal="true">
    <div class="modal import-modal" onclick={e => e.stopPropagation()} onkeydown={() => {}}>
      <div class="modal-title">Import JSON</div>
      <label class="field-label">Load from file</label>
      <input type="file" accept=".json" class="file-input" onchange={loadFromFile} />
      <label class="field-label" style="margin-top:10px">Or paste JSON</label>
      <textarea class="import-ta" bind:value={importText} placeholder="Paste exported JSON here..."></textarea>
      {#if importError}<div class="import-error">⚠ {importError}</div>{/if}
      <div class="modal-actions">
        <button class="btn-cancel" onclick={() => showImport = false}>Cancel</button>
        <button class="btn-apply" onclick={doImport} disabled={!importText.trim()}>Import</button>
      </div>
    </div>
  </div>
{/if}

<!-- Share QR -->
{#if showShareQR}
  <div class="overlay" onclick={() => showShareQR = false} role="dialog" aria-modal="true">
    <div class="modal qr-modal" onclick={e => e.stopPropagation()} onkeydown={() => {}}>
      <div class="modal-title">
        Share {qrAlliance === 'red' ? '🔴 Red' : '🔵 Blue'} Alliance
      </div>
      <p class="qr-note">Have the main laptop scan this with "📷 Scan QR".</p>
      <div class="qr-frame">
        {#if qrImageURL === '__toobig__'}
          <div class="qr-error">
            Too much data ({qrByteSize} bytes).<br>
            Try drawing fewer paths or use Export JSON.
          </div>
        {:else if qrImageURL}
          <img src={qrImageURL} alt="QR code" class="qr-img" />
        {:else}
          <div class="qr-loading">Generating…</div>
        {/if}
      </div>
      <div class="qr-size">{qrByteSize} bytes</div>
      <div class="modal-actions">
        <button class="btn-apply" onclick={() => showShareQR = false}>Done</button>
      </div>
    </div>
  </div>
{/if}

<!-- Scan QR -->
{#if showScanQR}
  <div class="overlay" role="dialog" aria-modal="true">
    <div class="modal scan-modal" onkeydown={() => {}}>
      <div class="modal-title">📷 Scan Alliance QR</div>
      {#if scanError}
        <div class="import-error">⚠ {scanError}</div>
      {:else if scanSuccess}
        <div class="scan-success">✓ {scanSuccess}</div>
      {:else}
        <p class="qr-note">Point camera at the alliance QR code.</p>
      {/if}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={videoEl} class="scan-video" playsinline></video>
      <canvas bind:this={scanCanvas} class="scan-canvas"></canvas>
      <div class="modal-actions">
        <button class="btn-cancel" onclick={closeScan}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) { font-family: system-ui, sans-serif; background: #111; color: #eee; overflow: hidden; }

  .app { display: flex; flex-direction: column; height: 100dvh; }

  header { display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: #1a1a1a; border-bottom: 1px solid #2e2e2e; flex-shrink: 0; flex-wrap: wrap; }
  .logo { font-weight: 700; font-size: 15px; }
  .match-chip { font-size: 12px; color: #888; background: #252525; padding: 3px 8px; border-radius: 3px; }
  .phase-btns { display: flex; gap: 4px; margin-left: auto; }
  .hdr-actions { display: flex; gap: 4px; }
  .phase-btns button, .hdr-actions button {
    padding: 5px 11px; background: #252525; color: #aaa; border: 1px solid #3a3a3a;
    border-radius: 4px; cursor: pointer; font-size: 12px; font-family: inherit; transition: .1s;
  }
  .phase-btns button.active { background: #eee; color: #111; border-color: #eee; font-weight: 600; }
  .hdr-actions button:hover { background: #333; color: #eee; }
  .scan-btn { color: #ffd700 !important; border-color: #554400 !important; }
  .scan-btn:hover { background: #332200 !important; }

  main { display: flex; flex: 1; overflow: hidden; min-height: 0; }

  .field-col { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 10px; gap: 8px; min-width: 0; overflow: hidden; }
  .toolbar { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; width: 100%; max-width: 600px; }
  .toolbar button { padding: 5px 10px; background: #252525; color: #ccc; border: 1px solid #3a3a3a; border-radius: 4px; cursor: pointer; font-size: 12px; font-family: inherit; transition: .1s; }
  .toolbar button:disabled { opacity: .3; cursor: default; }
  .toolbar button.active { background: #eee; color: #111; border-color: #eee; font-weight: 600; }
  .toolbar button.danger { color: #e74c3c; border-color: #4a2020; }
  .toolbar button.danger:hover { background: #e74c3c; color: #fff; }
  .cur { margin-left: auto; font-size: 12px; font-weight: 600; }

  .canvas-wrap { width: 100%; max-width: 600px; aspect-ratio: 1/1; position: relative; border-radius: 4px; overflow: hidden; border: 1px solid #2e2e2e; flex-shrink: 0; }
  canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: crosshair; }

  aside { width: 240px; flex-shrink: 0; overflow-y: auto; padding: 10px; border-left: 1px solid #2a2a2a; background: #161616; display: flex; flex-direction: column; gap: 5px; }

  .a-header { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; padding: 3px 0; border-bottom: 1px solid; display: flex; align-items: center; justify-content: space-between; }
  .a-header.red  { color: #ef5350; border-color: #3a1a1a; }
  .a-header.blue { color: #42a5f5; border-color: #1a2a3a; }
  .share-qr-btn { font-size: 9px; padding: 2px 7px; background: #2a1a1a; border: 1px solid #5a2a2a; color: #ef5350; border-radius: 3px; cursor: pointer; font-family: inherit; text-transform: uppercase; letter-spacing: .06em; }
  .share-qr-btn.blue { background: #1a1a2a; border-color: #2a3a5a; color: #42a5f5; }
  .share-qr-btn:hover { opacity: .8; }

  .team-row { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 4px; cursor: pointer; border: 1px solid transparent; background: #1e1e1e; transition: .1s; }
  .team-row:hover { background: #252525; }
  .team-row.active-row { border-color: color-mix(in srgb, var(--c) 55%, transparent); background: color-mix(in srgb, var(--c) 10%, #1e1e1e); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); flex-shrink: 0; }
  .dot.dim { opacity: .2; }
  .tnum { flex: 1; font-size: 13px; font-weight: 600; color: var(--c); }
  .pcnt { font-size: 11px; color: #555; }
  .ico { background: none; border: none; cursor: pointer; font-size: 13px; padding: 0 2px; line-height: 1; }

  .cycle-ctrl { display: flex; align-items: center; gap: 4px; }
  .cycle-ctrl button { width: 22px; height: 22px; background: #2a2a2a; border: 1px solid #444; border-radius: 3px; color: #eee; cursor: pointer; font-size: 15px; line-height: 1; display: flex; align-items: center; justify-content: center; padding: 0; font-family: inherit; }
  .cycle-num { font-size: 14px; font-weight: 700; color: var(--c); min-width: 20px; text-align: center; }

  .sec-title { font-size: 10px; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: .08em; }

  .auto-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .cb-label { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #aaa; cursor: pointer; }
  .count-label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: #666; }
  .count-label span { text-transform: uppercase; letter-spacing: .06em; }
  .count-label input[type=number] { width: 100%; background: #222; border: 1px solid #333; border-radius: 4px; padding: 5px 7px; color: #eee; font-family: inherit; font-size: 13px; font-weight: 600; }

  textarea { width: 100%; min-height: 80px; background: #1e1e1e; border: 1px solid #2e2e2e; border-radius: 4px; padding: 8px; color: #ccc; font-family: inherit; font-size: 12px; line-height: 1.6; resize: vertical; }
  textarea:focus, input[type=number]:focus { outline: none; border-color: #444; }

  .score-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .score-label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; }
  .score-label.red span  { color: #ef5350; text-transform: uppercase; letter-spacing: .06em; }
  .score-label.blue span { color: #42a5f5; text-transform: uppercase; letter-spacing: .06em; }
  .score-label input[type=number] { width: 100%; background: #222; border: 1px solid #333; border-radius: 4px; padding: 6px 8px; color: #eee; font-family: inherit; font-size: 15px; font-weight: 700; }
  .winner { font-size: 12px; font-weight: 600; padding: 5px 8px; border-radius: 4px; background: #1e1e1e; border: 1px solid #333; color: #aaa; }
  .winner.red-win  { color: #ef5350; border-color: #3a1a1a; }
  .winner.blue-win { color: #42a5f5; border-color: #1a2a3a; }
  .score-notes { min-height: 60px; }

  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.7); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal { background: #1e1e1e; border: 1px solid #333; border-radius: 8px; padding: 20px; width: 320px; display: flex; flex-direction: column; gap: 10px; max-height: 90dvh; overflow-y: auto; }
  .import-modal { width: 420px; max-width: 95vw; }
  .qr-modal { width: 320px; align-items: center; }
  @media (max-width: 580px) {
    .qr-modal {
      width: 100dvw; height: 100dvh; border-radius: 0; border: none;
      justify-content: center; max-height: 100dvh;
    }
    .qr-frame { width: 85vw; height: 85vw; }
  }
  .scan-modal { width: 340px; align-items: center; }
  .modal-title { font-size: 15px; font-weight: 700; }
  .field-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: .08em; }
  .mi { width: 100%; background: #141414; border: 1px solid #333; border-radius: 4px; padding: 7px 9px; color: #eee; font-family: inherit; font-size: 13px; }
  .mi:focus { outline: none; border-color: #555; }
  .a-section { display: flex; flex-direction: column; gap: 6px; }
  .two-col { display: flex; gap: 8px; }
  .two-col .mi { flex: 1; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; width: 100%; }
  .btn-cancel { padding: 6px 14px; background: #2a2a2a; color: #aaa; border: 1px solid #444; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 13px; }
  .btn-apply { padding: 6px 14px; background: #eee; color: #111; border: none; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 13px; font-weight: 600; }
  .btn-apply:disabled { opacity: .4; cursor: default; }
  .file-input { font-size: 12px; color: #aaa; }
  .import-ta { width: 100%; height: 140px; background: #141414; border: 1px solid #333; border-radius: 4px; padding: 8px; color: #ccc; font-family: monospace; font-size: 11px; resize: vertical; }
  .import-ta:focus { outline: none; border-color: #555; }
  .import-error { font-size: 12px; color: #e74c3c; background: #2a1a1a; border: 1px solid #4a2020; border-radius: 4px; padding: 6px 8px; width: 100%; }
  .scan-success { font-size: 13px; color: #2ed573; background: #1a2a1a; border: 1px solid #2a4a2a; border-radius: 4px; padding: 8px 12px; width: 100%; text-align: center; }

  .qr-note { font-size: 12px; color: #777; text-align: center; }
  .qr-frame { width: 280px; height: 280px; background: #fff; border-radius: 6px; display: flex; align-items: center; justify-content: center; }
  .qr-img { width: 100%; height: 100%; border-radius: 6px; }
  .qr-loading { color: #999; font-size: 13px; }
  .qr-error { color: #e74c3c; font-size: 12px; text-align: center; padding: 16px; line-height: 1.6; }
  .qr-size { font-size: 10px; color: #444; }

  .scan-video { width: 300px; height: 300px; object-fit: cover; border-radius: 6px; background: #000; }
  .scan-canvas { display: none; }

  @media (max-width: 580px) {
    main { flex-direction: column; }
    aside { width: 100%; border-left: none; border-top: 1px solid #2a2a2a; max-height: 44dvh; }
  }
</style>