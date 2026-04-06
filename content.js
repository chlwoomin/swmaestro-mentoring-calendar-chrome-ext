(() => {
  const HISTORY_URL = 'https://swmaestro.ai/sw/mypage/userAnswer/history.do?menuNo=200047';
  const CACHE_KEY   = 'swm_lectures';

  // ── 1. 파싱 ────────────────────────────────────────────────────
  function parseRows(doc) {
    const lectures = [];
    doc.querySelectorAll('.boardlist table tbody tr').forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 7) return;
      if (cells[6].innerText.trim() !== '접수완료') return;

      const rawDate = cells[4].innerText.trim();
      const dateMatch = rawDate.match(/(\d{4}-\d{2}-\d{2})/);
      const timeMatch = rawDate.match(/(\d{1,2}:\d{2}):\d{2}\s*~\s*(\d{1,2}:\d{2}):\d{2}/);
      if (!dateMatch) return;

      const titleEl = cells[2].querySelector('a');
      lectures.push({
        date:   dateMatch[1],
        time:   timeMatch ? `${timeMatch[1]} ~ ${timeMatch[2]}` : '',
        title:  titleEl ? titleEl.innerText.trim() : '(제목 없음)',
        href:   titleEl ? titleEl.href : '#',
        type:   cells[1].innerText.trim(),
        author: cells[3].innerText.trim(),
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

  // ── 4. 상세 패널 ────────────────────────────────────────────────
  function renderDetail(el, items, ds) {
    if (!items || !items.length) {
      el.innerHTML = `<p class="swm-detail-hint">이 날은 접수된 강의가 없습니다.</p>`;
      return;
    }
    el.innerHTML = `<p class="swm-detail-date">${ds.replace(/-/g,'.')} 강의 (${items.length}건)</p>
      ${items.map(l => `<a class="swm-item" href="${l.href}" target="_blank">
        <span class="swm-item-type">${l.type}</span>
        <span class="swm-item-title">${l.title}</span>
        <span class="swm-item-meta">${l.author} · ${l.time}</span>
      </a>`).join('')}`;
  }

  // ── 5. UI 마운트 ────────────────────────────────────────────────
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
        <button id="swm-refresh" title="새로고침">↻</button>
        <button id="swm-close" title="닫기">✕</button>
      </div>`;
    popup.appendChild(header);

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
    function openPopup()  { popup.classList.add('open'); }
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

    document.getElementById('swm-refresh').onclick = async () => {
      const btn = document.getElementById('swm-refresh');
      btn.classList.add('spinning'); btn.disabled = true;
      lectures = await loadLectures(true);
      btn.classList.remove('spinning'); btn.disabled = false;
      render();
    };
  }

  // ── 6. 로딩 FAB ─────────────────────────────────────────────────
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
    document.body.appendChild(root);
  }

  // ── 7. 진입점 ────────────────────────────────────────────────────
  async function init() {
    if (!location.pathname.includes('/mypage/')) return;
    if (!sessionStorage.getItem(CACHE_KEY)) showLoader();

    try {
      const lectures = await loadLectures();
      if (lectures.length) mount(lectures);
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
