(() => {
  const HISTORY_URL = `${location.origin}/sw/mypage/userAnswer/history.do?menuNo=200047`;
  const CACHE_KEY   = 'swm_lectures';
  const SYNC_KEY    = 'swm_synced_gcal'; // { [lectureKey]: { id, cal } }
  const CAL_ID_KEY  = 'swm_gcal_cal_id'; // 선택된 캘린더 ID

  function getLectureKey(l) { return l.href || `${l.date}|${l.title}`; }
  function getSyncedMap()   { try { return JSON.parse(localStorage.getItem(SYNC_KEY) || '{}'); } catch { return {}; } }
  function saveSyncedMap(m) { localStorage.setItem(SYNC_KEY, JSON.stringify(m)); }
  function getSavedCalId()  { return localStorage.getItem(CAL_ID_KEY) || 'primary'; }
  function saveCalId(id)    { localStorage.setItem(CAL_ID_KEY, id); }
  // 구형 포맷(string) 호환
  function getEventInfo(v)  { return typeof v === 'string' ? { id: v, cal: 'primary' } : v; }

  // ── 1. 파싱 ────────────────────────────────────────────────────
  function parseRows(doc) {
    const lectures = [];
    doc.querySelectorAll('.boardlist table tbody tr').forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 7) return;
      if (cells[6].textContent.trim() !== '접수완료') return;
      if (cells[8].textContent.trim() === '삭제') return;

      const rawDate = cells[4].textContent.trim();
      const dateMatch = rawDate.match(/(\d{4}-\d{2}-\d{2})/);
      const timeMatch = rawDate.match(/(\d{1,2}:\d{2}):\d{2}\s*~\s*(\d{1,2}:\d{2}):\d{2}/);
      if (!dateMatch) return;

      const titleEl = cells[2].querySelector('a');
      lectures.push({
        date:   dateMatch[1],
        time:   timeMatch ? `${timeMatch[1]} ~ ${timeMatch[2]}` : '',
        title:  titleEl ? titleEl.textContent.trim() : '(제목 없음)',
        href:   titleEl ? titleEl.href : '#',
        type:   cells[1].textContent.trim(),
        author: cells[3].textContent.trim(),
      });
    });
    return lectures;
  }

  // ── 2. 전체 페이지 fetch ────────────────────────────────────────
  async function loadLectures(forceRefresh = false) {
    if (!forceRefresh) {
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) return JSON.parse(cached);
    }

    const lectures = [];
    const firstRes  = await fetch(HISTORY_URL + '&pageIndex=1', { credentials: 'include' });
    const firstHtml = await firstRes.text();
    const firstDoc  = new DOMParser().parseFromString(firstHtml, 'text/html');
    lectures.push(...parseRows(firstDoc));

    const endEl    = firstDoc.querySelector('.pagination .i.end a');
    const lastPage = endEl ? parseInt(endEl.dataset.endpage || '1', 10) : 1;

    for (let p = 2; p <= lastPage; p++) {
      const res  = await fetch(HISTORY_URL + `&pageIndex=${p}`, { credentials: 'include' });
      const html = await res.text();
      const doc  = new DOMParser().parseFromString(html, 'text/html');
      lectures.push(...parseRows(doc));
    }

    const timeToMin = t => { const m = t.match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };
    lectures.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return timeToMin(a.time) - timeToMin(b.time);
    });
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(lectures));
    return lectures;
  }

  // ── 3. 달력 HTML 생성 ───────────────────────────────────────────
  function buildCalendar(lectures, year, month) {
    const map = {};
    lectures.forEach(l => { (map[l.date] = map[l.date] || []).push(l); });

    const today   = new Date();
    const startWd = new Date(year, month, 1).getDay();
    const days    = new Date(year, month + 1, 0).getDate();
    const DAYS    = ['일','월','화','수','목','금','토'];
    const MONTHS  = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

    let html = `
      <div class="swm-cal-header">
        <button class="swm-nav" id="swm-prev">&#8249;</button>
        <span class="swm-month-title">${year}년 ${MONTHS[month]}</span>
        <button class="swm-nav" id="swm-next">&#8250;</button>
      </div>
      <div class="swm-grid">
        ${DAYS.map((d,i) => `<div class="swm-day-label ${i===0?'sun':i===6?'sat':''}">${d}</div>`).join('')}
    `;

    for (let i = 0; i < startWd; i++) html += `<div class="swm-cell empty"></div>`;

    for (let d = 1; d <= days; d++) {
      const ds    = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const items = map[ds] || [];
      const wd    = (startWd + d - 1) % 7;
      const isToday = today.getFullYear()===year && today.getMonth()===month && today.getDate()===d;
      const dots  = items.length ? `<div class="swm-dots">${items.map(()=>`<span class="swm-dot"></span>`).join('')}</div>` : '';
      html += `<div class="swm-cell ${isToday?'today':''} ${wd===0?'sun':wd===6?'sat':''} ${items.length?'has-event':''}" data-date="${ds}">
        <span class="swm-dnum">${d}</span>${dots}</div>`;
    }

    html += `</div><div class="swm-detail" id="swm-detail"><p class="swm-detail-hint">날짜를 클릭하면 강의 정보를 볼 수 있어요.</p></div>`;
    return { html, map };
  }

  // ── 4. 구글 캘린더 URL 생성 ──────────────────────────────────────
  function googleCalUrl(l) {
    const [start, end] = l.time.split('~').map(s => s.trim());
    const fmt = (t) => l.date.replace(/-/g, '') + 'T' + t.split(':').map(v => v.padStart(2,'0')).join('') + '00';
    const dates = start && end ? `${fmt(start)}/${fmt(end)}` : l.date.replace(/-/g, '');
    const text = encodeURIComponent(`[소마] ${l.title}`);
    const details = encodeURIComponent(`${l.type} · ${l.author}\n${l.href}`);
    return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${dates}&details=${details}`;
  }

  // ── 5. 상세 패널 ────────────────────────────────────────────────
  function renderDetail(el, items, ds) {
    if (!items || !items.length) {
      el.innerHTML = `<p class="swm-detail-hint">이 날은 접수된 강의가 없습니다.</p>`;
      return;
    }
    el.innerHTML = `<p class="swm-detail-date">${ds.replace(/-/g,'.')} 강의 (${items.length}건)</p>
      ${items.map(l => `<div class="swm-item-wrap">
        <a class="swm-item" href="${l.href}" target="_blank">
          <span class="swm-item-type">${l.type}</span>
          <span class="swm-item-title">${l.title}</span>
          <span class="swm-item-meta">${l.author} · ${l.time}</span>
        </a>
        <a class="swm-gcal-btn" href="${googleCalUrl(l)}" target="_blank" title="구글 캘린더에 추가">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            <line x1="12" y1="14" x2="12" y2="18"/><line x1="10" y1="16" x2="14" y2="16"/>
          </svg>
        </a>
      </div>`).join('')}`;
  }

  // ── 6. 구글 캘린더 API ──────────────────────────────────────────
  async function createGcalEvent(token, l) {
    const [startTime, endTime] = l.time ? l.time.split('~').map(s => s.trim()) : [null, null];
    let start, end;
    if (startTime && endTime) {
      const pad = t => t.padStart(5, '0');
      start = { dateTime: `${l.date}T${pad(startTime)}:00`, timeZone: 'Asia/Seoul' };
      end   = { dateTime: `${l.date}T${pad(endTime)}:00`,   timeZone: 'Asia/Seoul' };
    } else {
      const nextDay = new Date(l.date);
      nextDay.setDate(nextDay.getDate() + 1);
      start = { date: l.date };
      end   = { date: nextDay.toISOString().slice(0, 10) };
    }
    const calId = encodeURIComponent(getSavedCalId());
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calId}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: `[소마] ${l.title}`,
        description: `${l.type} · ${l.author}\n${l.href}`,
        start, end,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { id: data.id, cal: getSavedCalId() };
  }

  async function deleteGcalEvent(token, eventInfo) {
    const { id, cal } = getEventInfo(eventInfo);
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events/${id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok && res.status !== 410) throw new Error(`HTTP ${res.status}`);
  }

  async function fetchCalendarList(token) {
    const res = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.items || [];
  }

  async function getTokenSilent() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN', interactive: false }, res => {
        if (chrome.runtime.lastError || res?.error || !res?.token) resolve(null);
        else resolve(res.token);
      });
    });
  }

  async function autoSync(lectures) {
    const syncedMap = getSyncedMap();
    if (Object.keys(syncedMap).length === 0) return; // 수동 싱크 전엔 실행 안 함

    const currentKeys  = new Set(lectures.map(getLectureKey));
    const newLectures  = lectures.filter(l => !syncedMap[getLectureKey(l)]);
    const removedKeys  = Object.keys(syncedMap).filter(k => !currentKeys.has(k));
    if (!newLectures.length && !removedKeys.length) return;

    const token = await getTokenSilent();
    if (!token) return;

    const newMap = { ...syncedMap };
    let added = 0, deleted = 0;

    for (const l of newLectures) {
      try { newMap[getLectureKey(l)] = await createGcalEvent(token, l); added++; } catch {}
    }
    for (const key of removedKeys) {
      try { await deleteGcalEvent(token, getEventInfo(syncedMap[key])); delete newMap[key]; deleted++; } catch {}
    }

    saveSyncedMap(newMap);

    const msgs = [];
    if (added)   msgs.push(`+${added}개 추가`);
    if (deleted) msgs.push(`${deleted}개 삭제`);
    if (msgs.length) showFabBadge(msgs.join(' · '));
  }

  function showFabBadge(text) {
    document.getElementById('swm-fab-badge')?.remove();
    const root = document.getElementById('swm-ext-root');
    if (!root) return;
    const badge = document.createElement('span');
    badge.id = 'swm-fab-badge';
    badge.textContent = text;
    root.appendChild(badge);
    setTimeout(() => badge.remove(), 5000);
  }

  // ── 7. 토스트 알림 ──────────────────────────────────────────────
  function showToast(msg, type = 'ok') {
    document.getElementById('swm-toast')?.remove();
    const t = document.createElement('div');
    t.id = 'swm-toast';
    t.className = type === 'ok' ? 'swm-toast-ok' : 'swm-toast-err';
    t.textContent = msg;
    document.getElementById('swm-popup').appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ── 8. UI 마운트 ────────────────────────────────────────────────
  function mount(lectures) {
    document.getElementById('swm-ext-root')?.remove();

    const root = document.createElement('div');
    root.id = 'swm-ext-root';
    document.body.appendChild(root);

    // FAB
    const fab = document.createElement('button');
    fab.id = 'swm-fab';
    fab.title = '달력으로 보기';
    fab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="4" width="18" height="18" rx="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>`;
    root.appendChild(fab);

    // 팝업
    const popup = document.createElement('div');
    popup.id = 'swm-popup';
    root.appendChild(popup);

    // 헤더
    const header = document.createElement('div');
    header.className = 'swm-popup-header';
    header.innerHTML = `<span>📅 접수 강의 달력</span>
      <div class="swm-header-btns">
        <button id="swm-gcal-all" title="구글 캘린더에 전체 추가">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
            <line x1="12" y1="14" x2="12" y2="18"/><line x1="10" y1="16" x2="14" y2="16"/>
          </svg>
        </button>
        <button id="swm-refresh" title="새로고침">↻</button>
        <button id="swm-close" title="닫기">✕</button>
      </div>`;
    popup.appendChild(header);

    // 캘린더 선택 바
    const calBar = document.createElement('div');
    calBar.className = 'swm-cal-selector-bar';
    const calSelect = document.createElement('select');
    calSelect.id = 'swm-cal-select';
    calSelect.innerHTML = `<option value="${getSavedCalId()}">${getSavedCalId() === 'primary' ? '기본 캘린더' : getSavedCalId()}</option>`;
    const calLoadBtn = document.createElement('button');
    calLoadBtn.id = 'swm-cal-load';
    calLoadBtn.title = '캘린더 목록 불러오기';
    calLoadBtn.textContent = '↻';
    calBar.innerHTML = '<span>캘린더</span>';
    calBar.appendChild(calSelect);
    calBar.appendChild(calLoadBtn);
    popup.appendChild(calBar);

    // 선택 저장
    calSelect.onchange = () => saveCalId(calSelect.value);

    // 불러오기 버튼 클릭 시 인증 후 목록 로드
    calLoadBtn.onclick = async () => {
      calLoadBtn.disabled = true;
      calLoadBtn.classList.add('spinning');
      calListLoaded = false;
      calSelect.innerHTML = '<option>불러오는 중...</option>';

      try {
        if (!chrome.runtime?.sendMessage) throw new Error('페이지를 새로고침 해주세요');
        const token = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN' }, res => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (res.error) reject(new Error(res.error));
            else resolve(res.token);
          });
        });
        await loadCalendarList(token);
      } catch (e) {
        console.error('[소마 달력] 캘린더 목록 로드 실패:', e);
        calSelect.innerHTML = `<option value="${getSavedCalId()}">불러오기 실패 (${e.message})</option>`;
      }

      calLoadBtn.disabled = false;
      calLoadBtn.classList.remove('spinning');
    };

    // 캘린더 목록 로드 (token을 받아서 호출)
    let calListLoaded = false;
    async function loadCalendarList(token) {
      if (calListLoaded) return;
      if (!token) token = await getTokenSilent();
      if (!token) return; // 토큰 없으면 스킵 (다음 기회에 재시도)
      calListLoaded = true;
      const items = await fetchCalendarList(token); // 에러는 호출부로 전파
      const saved = getSavedCalId();
      calSelect.innerHTML = items
        .map(c => `<option value="${c.id}" ${c.id === saved ? 'selected' : ''}>${c.summary}</option>`)
        .join('');
      if (!items.find(c => c.id === saved)) saveCalId(items[0]?.id || 'primary');
    }

    // 달력 바디
    const calBody = document.createElement('div');
    calBody.id = 'swm-cal-body';
    popup.appendChild(calBody);

    // 초기 월 설정 (가장 가까운 강의 날짜)
    const dates = lectures.map(l => new Date(l.date)).filter(d => !isNaN(d));
    const ref   = dates.length
      ? dates.reduce((a,b) => Math.abs(a-Date.now()) < Math.abs(b-Date.now()) ? a : b)
      : new Date();
    let curYear = ref.getFullYear(), curMonth = ref.getMonth();

    function render() {
      const { html, map } = buildCalendar(lectures, curYear, curMonth);
      calBody.innerHTML = html;

      calBody.querySelector('#swm-prev').onclick = () => {
        if (--curMonth < 0) { curMonth = 11; curYear--; } render();
      };
      calBody.querySelector('#swm-next').onclick = () => {
        if (++curMonth > 11) { curMonth = 0; curYear++; } render();
      };
      calBody.querySelectorAll('.swm-cell.has-event').forEach(cell => {
        cell.onclick = () => {
          calBody.querySelectorAll('.swm-cell').forEach(c => c.classList.remove('selected'));
          cell.classList.add('selected');
          renderDetail(calBody.querySelector('#swm-detail'), map[cell.dataset.date], cell.dataset.date);
        };
      });
    }

    render();

    // 팝업 열기/닫기
    function openPopup()  { popup.classList.add('open'); loadCalendarList(); }
    function closePopup() { popup.classList.remove('open'); }

    document.addEventListener('click', e => {
      if (!root.contains(e.target)) closePopup();
    });

    fab.onclick = e => {
      e.stopPropagation();
      popup.classList.contains('open') ? closePopup() : openPopup();
    };

    popup.onclick = e => e.stopPropagation();

    document.getElementById('swm-close').onclick = closePopup;

    let gcalSynced = false;

    document.getElementById('swm-gcal-all').onclick = async () => {
      if (gcalSynced && !confirm('이미 추가된 일정입니다. 다시 추가하면 중복됩니다. 계속할까요?')) return;

      const btn = document.getElementById('swm-gcal-all');
      const originalHTML = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = `0/${lectures.length}`;
      btn.style.fontSize = '10px';

      try {
        // 1. background에서 토큰만 받아옴
        const token = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN' }, res => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (res.error) reject(new Error(res.error));
            else resolve(res.token);
          });
        });

        // 토큰 확보 후 캘린더 목록 로드 (아직 안 된 경우)
        loadCalendarList(token);

        // 2. content script에서 직접 API 호출 + 진행 업데이트
        const total = lectures.length;
        let added = 0, failed = 0;
        const syncedMap = getSyncedMap();
        for (const l of lectures) {
          try {
            syncedMap[getLectureKey(l)] = await createGcalEvent(token, l);
            added++;
          } catch (e) {
            failed++;
          }
          btn.textContent = `${added + failed}/${total}`;
        }
        saveSyncedMap(syncedMap);
        gcalSynced = true;
        showToast(
          `✓ ${added}개 추가됨${failed ? ` (${failed}개 실패)` : ''}`,
          'ok'
        );
      } catch (e) {
        console.error('[소마 달력] 전체 추가 실패:', e);
        showToast(`✗ ${e.message || '연동 중 오류 발생'}`, 'err');
      }

      btn.disabled = false;
      btn.innerHTML = originalHTML;
      btn.style.fontSize = '';
    };

    document.getElementById('swm-refresh').onclick = async () => {
      const btn = document.getElementById('swm-refresh');
      btn.classList.add('spinning'); btn.disabled = true;
      lectures = await loadLectures(true);
      btn.classList.remove('spinning'); btn.disabled = false;
      gcalSynced = false;
      render();
      autoSync(lectures);
    };
  }

  // ── 8. 로딩 FAB ─────────────────────────────────────────────────
  function showLoader() {
    document.getElementById('swm-ext-root')?.remove();
    const root = document.createElement('div');
    root.id = 'swm-ext-root';
    const fab = document.createElement('button');
    fab.id = 'swm-fab';
    fab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="swm-spin">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
    </svg>`;
    root.appendChild(fab);
    (document.body ?? document.documentElement).appendChild(root);
  }

  // ── 9. 진입점 ────────────────────────────────────────────────────
  async function init() {
    if (!location.pathname.includes('/mypage/')) return;
    if (!sessionStorage.getItem(CACHE_KEY)) showLoader();

    try {
      const lectures = await loadLectures();
      if (lectures.length) {
        mount(lectures);
        autoSync(lectures);
      }
    } catch(e) {
      console.warn('[소마 달력] 초기화 실패:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
