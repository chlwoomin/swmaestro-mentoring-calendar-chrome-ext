(() => {
  // ── 1. HTML(Document)에서 강의 데이터 파싱 ───────────────────────
  function parseRows(doc) {
    const rows = doc.querySelectorAll('.boardlist table tbody tr');
    const lectures = [];

    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 7) return;

      const typeEl   = cells[1];
      const titleEl  = cells[2].querySelector('a');
      const authorEl = cells[3];
      const dateEl   = cells[4];
      const statusEl = cells[6];

      if (!dateEl) return;

      // 접수완료 상태만 포함 (취소/대기 등 제외)
      const status = statusEl ? statusEl.innerText.trim() : '';
      if (status !== '접수완료') return;

      const rawText = dateEl.innerText.trim();
      const dateMatch = rawText.match(/(\d{4}-\d{2}-\d{2})/);
      const timeMatch = rawText.match(/(\d{2}:\d{2}):\d{2}\s*~\s*(\d{2}:\d{2}):\d{2}/);

      if (!dateMatch) return;

      lectures.push({
        date:   dateMatch[1],
        time:   timeMatch ? `${timeMatch[1]} ~ ${timeMatch[2]}` : '',
        title:  titleEl ? titleEl.innerText.trim() : '(제목 없음)',
        href:   titleEl ? titleEl.href : '#',
        type:   typeEl ? typeEl.innerText.trim() : '',
        author: authorEl ? authorEl.innerText.trim() : '',
      });
    });

    return lectures;
  }

  // ── 2. 전체 페이지 fetch ──────────────────────────────────────────
  async function fetchAllLectures() {
    const lectures = parseRows(document);

    const endPageEl = document.querySelector('.pagination .i.end a');
    const lastPage  = endPageEl ? parseInt(endPageEl.dataset.endpage || '1', 10) : 1;

    if (lastPage <= 1) return lectures;

    const baseUrl = location.href.split('?')[0];
    const menuNo  = new URLSearchParams(location.search).get('menuNo') || '200047';

    for (let page = 2; page <= lastPage; page++) {
      try {
        const url = `${baseUrl}?menuNo=${menuNo}&pageIndex=${page}`;
        const res  = await fetch(url, { credentials: 'include' });
        const html = await res.text();
        const doc  = new DOMParser().parseFromString(html, 'text/html');
        lectures.push(...parseRows(doc));
      } catch (e) {
        console.warn(`[소마 달력] ${page}페이지 fetch 실패:`, e);
      }
    }

    return lectures;
  }

  // ── 3. 달력 생성 ──────────────────────────────────────────────────
  function buildCalendar(lectures, year, month) {
    const lectureMap = {};
    lectures.forEach(l => {
      if (!lectureMap[l.date]) lectureMap[l.date] = [];
      lectureMap[l.date].push(l);
    });

    const today    = new Date();
    const firstDay = new Date(year, month, 1);
    const lastDay  = new Date(year, month + 1, 0);
    const startWd  = firstDay.getDay();
    const days     = lastDay.getDate();

    const DAYS   = ['일','월','화','수','목','금','토'];
    const MONTHS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

    let html = `
      <div class="swm-cal-header">
        <button class="swm-nav" id="swm-prev">&#8249;</button>
        <span class="swm-month-title">${year}년 ${MONTHS[month]}</span>
        <button class="swm-nav" id="swm-next">&#8250;</button>
      </div>
      <div class="swm-grid">
        ${DAYS.map((d, i) => `<div class="swm-day-label ${i===0?'sun':i===6?'sat':''}">${d}</div>`).join('')}
    `;

    for (let i = 0; i < startWd; i++) html += `<div class="swm-cell empty"></div>`;

    for (let d = 1; d <= days; d++) {
      const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const items   = lectureMap[dateStr] || [];
      const wd      = (startWd + d - 1) % 7;
      const isToday = (today.getFullYear()===year && today.getMonth()===month && today.getDate()===d);

      const dotHtml = items.length > 0
        ? `<div class="swm-dots">${items.map(() => `<span class="swm-dot"></span>`).join('')}</div>`
        : '';

      html += `
        <div class="swm-cell ${isToday?'today':''} ${wd===0?'sun':wd===6?'sat':''} ${items.length?'has-event':''}"
             data-date="${dateStr}">
          <span class="swm-dnum">${d}</span>
          ${dotHtml}
        </div>`;
    }

    html += `</div>`;
    html += `<div class="swm-detail" id="swm-detail"><p class="swm-detail-hint">날짜를 클릭하면 강의 정보를 볼 수 있어요.</p></div>`;

    return { html, lectureMap };
  }

  // ── 4. 상세 패널 렌더링 ───────────────────────────────────────────
  function renderDetail(detail, items, dateStr) {
    if (!items || items.length === 0) {
      detail.innerHTML = `<p class="swm-detail-hint">이 날은 접수된 강의가 없습니다.</p>`;
      return;
    }
    const fmt = dateStr.replace(/-/g, '.');
    detail.innerHTML = `
      <p class="swm-detail-date">${fmt} 강의 (${items.length}건)</p>
      ${items.map(l => `
        <a class="swm-item" href="${l.href}" target="_blank">
          <span class="swm-item-type">${l.type}</span>
          <span class="swm-item-title">${l.title}</span>
          <span class="swm-item-meta">${l.author} · ${l.time}</span>
        </a>
      `).join('')}
    `;
  }

  // ── 5. 팝업 마운트 ────────────────────────────────────────────────
  function mountPopup(lectures) {
    document.getElementById('swm-ext-root')?.remove();

    const root = document.createElement('div');
    root.id = 'swm-ext-root';

    const fab = document.createElement('button');
    fab.id = 'swm-fab';
    fab.title = '달력으로 보기';
    fab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
    </svg>`;

    const popup = document.createElement('div');
    popup.id = 'swm-popup';
    popup.setAttribute('aria-hidden', 'true');

    const popupHeader = document.createElement('div');
    popupHeader.className = 'swm-popup-header';
    popupHeader.innerHTML = `<span>📅 접수 강의 달력</span><button id="swm-close" title="닫기">✕</button>`;

    const calBody = document.createElement('div');
    calBody.id = 'swm-cal-body';

    popup.appendChild(popupHeader);
    popup.appendChild(calBody);
    root.appendChild(fab);
    root.appendChild(popup);
    document.body.appendChild(root);

    const dates = lectures.map(l => new Date(l.date)).filter(d => !isNaN(d));
    const refDate = dates.length > 0
      ? dates.reduce((a, b) => Math.abs(a - Date.now()) < Math.abs(b - Date.now()) ? a : b)
      : new Date();

    let curYear  = refDate.getFullYear();
    let curMonth = refDate.getMonth();

    function render() {
      const { html, lectureMap } = buildCalendar(lectures, curYear, curMonth);
      calBody.innerHTML = html;

      calBody.querySelector('#swm-prev').addEventListener('click', () => {
        curMonth--;
        if (curMonth < 0) { curMonth = 11; curYear--; }
        render();
      });
      calBody.querySelector('#swm-next').addEventListener('click', () => {
        curMonth++;
        if (curMonth > 11) { curMonth = 0; curYear++; }
        render();
      });

      calBody.querySelectorAll('.swm-cell:not(.empty)').forEach(cell => {
        cell.addEventListener('click', () => {
          calBody.querySelectorAll('.swm-cell').forEach(c => c.classList.remove('selected'));
          cell.classList.add('selected');
          const dateStr = cell.dataset.date;
          renderDetail(calBody.querySelector('#swm-detail'), lectureMap[dateStr], dateStr);
        });
      });
    }

    render();

    fab.addEventListener('click', () => {
      const open = popup.classList.toggle('open');
      popup.setAttribute('aria-hidden', String(!open));
    });

    popup.querySelector('#swm-close').addEventListener('click', () => {
      popup.classList.remove('open');
      popup.setAttribute('aria-hidden', 'true');
    });

    popup.addEventListener('click', e => e.stopPropagation());
    fab.addEventListener('click', e => e.stopPropagation());

    document.addEventListener('click', () => {
      popup.classList.remove('open');
      popup.setAttribute('aria-hidden', 'true');
    });
  }

  // ── 6. 로딩 FAB (멀티페이지 fetch 중 표시) ───────────────────────
  function showLoadingFab() {
    document.getElementById('swm-ext-root')?.remove();
    const root = document.createElement('div');
    root.id = 'swm-ext-root';

    const fab = document.createElement('button');
    fab.id = 'swm-fab';
    fab.title = '강의 데이터 불러오는 중...';
    fab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="swm-spin">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
    </svg>`;

    root.appendChild(fab);
    document.body.appendChild(root);
  }

  // ── 7. 진입점 ─────────────────────────────────────────────────────
  async function init() {
    if (!document.querySelector('.boardlist table tbody tr')) return;

    const endPageEl = document.querySelector('.pagination .i.end a');
    const lastPage  = endPageEl ? parseInt(endPageEl.dataset.endpage || '1', 10) : 1;
    if (lastPage > 1) showLoadingFab();

    const lectures = await fetchAllLectures();
    if (lectures.length === 0) return;

    mountPopup(lectures);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
