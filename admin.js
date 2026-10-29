/**
 * LÉA STUDIO — Клиентский модуль защищённой панели администратора (/admin)
 * Чистый JavaScript без сторонних фреймворков.
 * Все проверки доступа, изменения статусов, перенос записей и управление каталогом
 * выполняются на сервере Cloudflare Worker с проверкой сессии и CSRF-токена.
 */

const API_BASE_URL = (window.LEA_API_BASE_URL || '').replace(/\/+$/, '');
const AUTO_REFRESH_INTERVAL_MS = 15000;

const MONTH_NAMES = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

const WEEKDAY_NAMES_FULL = [
  'Воскресенье',
  'Понедельник',
  'Вторник',
  'Среда',
  'Четверг',
  'Пятница',
  'Суббота',
];

const adminState = {
  authenticated: false,
  csrfToken: sessionStorage.getItem('lea_admin_csrf') || '',
  sessionToken: sessionStorage.getItem('lea_admin_token') || '',
  serverToday: '',
  stats: null,
  bookings: [],
  categories: [],
  services: [],
  masters: [],
  notificationLogs: [],
  telegramIntegration: null,

  // Фильтры
  filterSearch: '',
  filterDate: '',
  filterMasterId: 'all',
  filterServiceId: 'all',
  filterStatus: 'all',

  // Календарь
  calYear: null,
  calMonth: null,

  // Автообновление
  autoRefreshEnabled: true,
  autoRefreshTimer: null,
  activeBookingModalId: null,
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildAdminHeaders(extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...extra,
  };
  if (adminState.csrfToken) {
    headers['X-CSRF-Token'] = adminState.csrfToken;
  }
  if (adminState.sessionToken) {
    headers['Authorization'] = `Bearer ${adminState.sessionToken}`;
  }
  return headers;
}

async function adminApiFetch(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: buildAdminHeaders(options.headers || {}),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (response.status === 401) {
    handleUnauthenticatedState();
  }
  return { response, data };
}

function showFeedback(message, isError = false) {
  const box = document.getElementById('admin-action-feedback');
  if (!box) return;
  box.hidden = false;
  box.textContent = message;
  box.className = isError ? 'form-alert is-error' : 'form-alert is-success';
  setTimeout(() => {
    box.hidden = true;
  }, 5500);
}

function formatStatusLabel(status) {
  switch (status) {
    case 'confirmed':
      return { text: 'Подтверждена', cls: 'status-badge status-confirmed' };
    case 'pending':
      return { text: 'Ожидает', cls: 'status-badge status-pending' };
    case 'completed':
      return { text: 'Выполнена', cls: 'status-badge status-completed' };
    case 'cancelled':
      return { text: 'Отменена', cls: 'status-badge status-cancelled' };
    default:
      return { text: status, cls: 'status-badge' };
  }
}

function handleUnauthenticatedState() {
  adminState.authenticated = false;
  adminState.csrfToken = '';
  adminState.sessionToken = '';
  sessionStorage.removeItem('lea_admin_csrf');
  sessionStorage.removeItem('lea_admin_token');

  stopAutoRefresh();

  const loginSection = document.getElementById('admin-login-section');
  const dashboardSection = document.getElementById('admin-dashboard-section');
  const logoutBtn = document.getElementById('admin-logout-btn');
  if (loginSection) loginSection.hidden = false;
  if (dashboardSection) dashboardSection.hidden = true;
  if (logoutBtn) logoutBtn.hidden = true;
}

function handleAuthenticatedState() {
  adminState.authenticated = true;
  const loginSection = document.getElementById('admin-login-section');
  const dashboardSection = document.getElementById('admin-dashboard-section');
  const logoutBtn = document.getElementById('admin-logout-btn');
  if (loginSection) loginSection.hidden = true;
  if (dashboardSection) dashboardSection.hidden = false;
  if (logoutBtn) logoutBtn.hidden = false;

  startAutoRefresh();
}

async function loadDashboardData({ silent = false } = {}) {
  const params = new URLSearchParams();
  if (adminState.filterDate) params.set('date', adminState.filterDate);
  if (adminState.filterMasterId && adminState.filterMasterId !== 'all') {
    params.set('masterId', adminState.filterMasterId);
  }
  if (adminState.filterServiceId && adminState.filterServiceId !== 'all') {
    params.set('serviceId', adminState.filterServiceId);
  }
  if (adminState.filterStatus && adminState.filterStatus !== 'all') {
    params.set('status', adminState.filterStatus);
  }
  if (adminState.filterSearch) {
    params.set('search', adminState.filterSearch);
  }

  const queryStr = params.toString() ? `?${params.toString()}` : '';
  const { response, data } = await adminApiFetch(`/api/admin/overview${queryStr}`, {
    method: 'GET',
  });

  if (!response.ok || !data || !data.ok) {
    if (!silent && response.status !== 401) {
      showFeedback(
        data?.error?.message || 'Не удалось загрузить данные панели администратора.',
        true
      );
    }
    return false;
  }

  if (data.csrfToken) {
    adminState.csrfToken = data.csrfToken;
    sessionStorage.setItem('lea_admin_csrf', data.csrfToken);
  }

  adminState.serverToday = data.serverToday || '';
  adminState.stats = data.stats || {};
  adminState.bookings = data.bookings || [];
  adminState.categories = data.categories || [];
  adminState.services = data.services || [];
  adminState.masters = data.masters || [];
  adminState.notificationLogs = data.notificationLogs || [];
  adminState.telegramIntegration = data.telegramIntegration || null;

  if (adminState.calYear === null && adminState.serverToday) {
    const [y, m] = adminState.serverToday.split('-').map(Number);
    adminState.calYear = y;
    adminState.calMonth = m - 1;
  }

  handleAuthenticatedState();
  renderAllDashboardSections();

  const syncText = document.getElementById('admin-last-sync-text');
  if (syncText) {
    const nowTime = new Date().toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    syncText.textContent = `Синхронизировано в ${nowTime}`;
  }

  return true;
}

function renderAllDashboardSections() {
  renderKpiSummary();
  populateFilterDropdowns();
  renderAdminCalendar();
  renderUpcomingClients();
  renderBookingsTableAndCards();
  renderServicesManagement();
  renderMastersManagement();
  renderTelegramLogs();
}

function renderKpiSummary() {
  const stats = adminState.stats || {};
  const todayEl = document.getElementById('kpi-today-count');
  const upcomingEl = document.getElementById('kpi-upcoming-count');
  const confirmedEl = document.getElementById('kpi-confirmed-count');
  const cancelledEl = document.getElementById('kpi-cancelled-count');
  const serverDateLabel = document.getElementById('admin-server-date-label');

  if (todayEl) todayEl.textContent = String(stats.todayCount ?? 0);
  if (upcomingEl) upcomingEl.textContent = String(stats.upcomingCount ?? 0);
  if (confirmedEl) confirmedEl.textContent = String(stats.confirmedCount ?? 0);
  if (cancelledEl) cancelledEl.textContent = String(stats.cancelledCount ?? 0);
  if (serverDateLabel && adminState.serverToday) {
    serverDateLabel.textContent = `Текущая дата салона: ${adminState.serverToday} (МСК)`;
  }
}

function populateFilterDropdowns() {
  const masterSelect = document.getElementById('filter-master-select');
  if (masterSelect) {
    const currentVal = adminState.filterMasterId;
    masterSelect.innerHTML =
      `<option value="all">Все мастера</option>` +
      adminState.masters
        .map(
          (m) =>
            `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`
        )
        .join('');
    masterSelect.value = currentVal;
  }

  const serviceSelect = document.getElementById('filter-service-select');
  if (serviceSelect) {
    const currentVal = adminState.filterServiceId;
    serviceSelect.innerHTML =
      `<option value="all">Все услуги</option>` +
      adminState.services
        .map(
          (s) =>
            `<option value="${escapeHtml(s.id)}">${escapeHtml(s.title)}</option>`
        )
        .join('');
    serviceSelect.value = currentVal;
  }
}

function renderAdminCalendar() {
  const grid = document.getElementById('admin-calendar-grid');
  const label = document.getElementById('admin-cal-month-label');
  if (!grid || adminState.calYear === null || adminState.calMonth === null) return;

  const year = adminState.calYear;
  const month = adminState.calMonth;
  if (label) {
    label.textContent = `${MONTH_NAMES[month]} ${year}`;
  }

  // Подсчёт активных записей по датам
  const countsByDate = {};
  for (const b of adminState.bookings) {
    if (b.status !== 'cancelled') {
      countsByDate[b.date] = (countsByDate[b.date] || 0) + 1;
    }
  }

  const firstDayUtc = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const startOffset = (firstDayUtc.getUTCDay() + 6) % 7; // Пн = 0 .. Вс = 6

  let html = '';
  for (let i = 0; i < startOffset; i++) {
    html += `<div class="cal-day is-empty" aria-hidden="true"></div>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const count = countsByDate[dateStr] || 0;
    const isSelected = adminState.filterDate === dateStr;
    const isToday = adminState.serverToday === dateStr;

    const classes = [
      'cal-day',
      isSelected ? 'is-selected' : '',
      isToday ? 'is-today' : '',
      count > 0 ? 'has-bookings' : '',
    ]
      .filter(Boolean)
      .join(' ');

    html += `
      <button type="button" class="${classes}" data-cal-date="${dateStr}" title="Записей: ${count}">
        <span>${day}</span>
        ${count > 0 ? `<small class="cal-day-dot">${count}</small>` : ''}
      </button>
    `;
  }

  grid.innerHTML = html;

  grid.querySelectorAll('[data-cal-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const clickedDate = btn.getAttribute('data-cal-date');
      adminState.filterDate =
        adminState.filterDate === clickedDate ? '' : clickedDate;
      const dateInput = document.getElementById('filter-date-input');
      if (dateInput) dateInput.value = adminState.filterDate;
      loadDashboardData();
    });
  });
}

function renderUpcomingClients() {
  const container = document.getElementById('admin-upcoming-list');
  if (!container) return;

  const list = adminState.stats?.upcomingClients || [];
  if (list.length === 0) {
    container.innerHTML = `<p class="empty-state-text">На ближайшие дни активных записей пока нет.</p>`;
    return;
  }

  container.innerHTML = list
    .slice(0, 6)
    .map(
      (b) => `
      <div class="upcoming-client-item">
        <div>
          <strong>${escapeHtml(b.date)} • ${escapeHtml(b.startTime)}–${escapeHtml(b.endTime)}</strong>
          <p>${escapeHtml(b.clientFirstName)} ${escapeHtml(b.clientLastName)} — ${escapeHtml(b.serviceTitle)}</p>
          <small>Мастер: ${escapeHtml(b.masterName)} • <a href="tel:${escapeHtml(b.clientPhone)}">${escapeHtml(b.clientPhone)}</a></small>
        </div>
        <button type="button" class="btn btn-outline btn-sm" data-open-booking="${escapeHtml(b.id)}">
          Открыть
        </button>
      </div>
    `
    )
    .join('');

  container.querySelectorAll('[data-open-booking]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openBookingModal(btn.getAttribute('data-open-booking'));
    });
  });
}

function renderBookingsTableAndCards() {
  const tbody = document.getElementById('admin-bookings-tbody');
  const cardsContainer = document.getElementById('admin-bookings-cards');
  const countSpan = document.getElementById('admin-bookings-shown-count');

  const list = adminState.bookings || [];
  if (countSpan) countSpan.textContent = String(list.length);

  if (list.length === 0) {
    const emptyHtml = `<tr><td colspan="8" class="empty-state-cell">По выбранным фильтрам записей не найдено.</td></tr>`;
    if (tbody) tbody.innerHTML = emptyHtml;
    if (cardsContainer) {
      cardsContainer.innerHTML = `<p class="empty-state-text">По выбранным фильтрам записей не найдено.</p>`;
    }
    return;
  }

  if (tbody) {
    tbody.innerHTML = list
      .map((b) => {
        const badge = formatStatusLabel(b.status);
        const createdShort = b.createdAt
          ? b.createdAt.replace('T', ' ').slice(0, 16)
          : '—';
        const fullNameDisplay = [b.clientFirstName, b.clientLastName]
          .filter(Boolean)
          .join(' ') || b.clientName;

        return `
        <tr>
          <td>
            <strong>${escapeHtml(b.id)}</strong>
            <div class="cell-sub">${escapeHtml(createdShort)}</div>
          </td>
          <td>
            <div><strong>Имя:</strong> ${escapeHtml(b.clientFirstName || b.clientName)}</div>
            <div><strong>Фамилия:</strong> ${escapeHtml(b.clientLastName || '—')}</div>
            ${
              b.clientComment
                ? `<div class="cell-sub">💬 ${escapeHtml(b.clientComment)}</div>`
                : ''
            }
          </td>
          <td>
            <a href="tel:${escapeHtml(b.clientPhone)}" class="phone-link">${escapeHtml(b.clientPhone)}</a>
          </td>
          <td>
            <div>${escapeHtml(b.serviceTitle)}</div>
            <div class="cell-sub">${Number(b.priceRub).toLocaleString('ru-RU')} ₽ • ${b.durationMinutes} мин</div>
          </td>
          <td>${escapeHtml(b.masterName)}</td>
          <td>
            <div><strong>${escapeHtml(b.date)}</strong></div>
            <div class="cell-sub">${escapeHtml(b.startTime)}–${escapeHtml(b.endTime)}</div>
          </td>
          <td>
            <span class="${badge.cls}">${badge.text}</span>
          </td>
          <td class="admin-actions-cell">
            ${
              b.status !== 'confirmed'
                ? `<button type="button" class="btn btn-primary btn-xs" data-confirm-booking="${escapeHtml(b.id)}">Подтвердить</button>`
                : ''
            }
            ${
              b.status !== 'cancelled'
                ? `<button type="button" class="btn btn-outline btn-xs" data-cancel-booking="${escapeHtml(b.id)}">Отменить</button>`
                : ''
            }
            <button type="button" class="btn btn-ghost btn-xs" data-open-booking="${escapeHtml(b.id)}">
              Перенос / Детали
            </button>
          </td>
        </tr>
      `;
      })
      .join('');
  }

  if (cardsContainer) {
    cardsContainer.innerHTML = list
      .map((b) => {
        const badge = formatStatusLabel(b.status);
        return `
        <article class="admin-booking-mobile-card">
          <div class="mobile-card-top">
            <strong>${escapeHtml(b.date)} • ${escapeHtml(b.startTime)}–${escapeHtml(b.endTime)}</strong>
            <span class="${badge.cls}">${badge.text}</span>
          </div>
          <p class="mobile-card-client">
            <strong>${escapeHtml(b.clientFirstName || b.clientName)} ${escapeHtml(b.clientLastName || '')}</strong>
            • <a href="tel:${escapeHtml(b.clientPhone)}">${escapeHtml(b.clientPhone)}</a>
          </p>
          <p class="mobile-card-service">
            ${escapeHtml(b.serviceTitle)} — <strong>${Number(b.priceRub).toLocaleString('ru-RU')} ₽</strong> (${b.durationMinutes} мин)
          </p>
          <p class="mobile-card-meta">
            Мастер: ${escapeHtml(b.masterName)} • ID: ${escapeHtml(b.id)}
          </p>
          <div class="mobile-card-actions">
            ${
              b.status !== 'confirmed'
                ? `<button type="button" class="btn btn-primary btn-xs" data-confirm-booking="${escapeHtml(b.id)}">Подтвердить</button>`
                : ''
            }
            ${
              b.status !== 'cancelled'
                ? `<button type="button" class="btn btn-outline btn-xs" data-cancel-booking="${escapeHtml(b.id)}">Отменить</button>`
                : ''
            }
            <button type="button" class="btn btn-ghost btn-xs" data-open-booking="${escapeHtml(b.id)}">
              Перенос / Детали
            </button>
          </div>
        </article>
      `;
      })
      .join('');
  }

  document.querySelectorAll('[data-confirm-booking]').forEach((btn) => {
    btn.addEventListener('click', () =>
      confirmBookingAction(btn.getAttribute('data-confirm-booking'))
    );
  });

  document.querySelectorAll('[data-cancel-booking]').forEach((btn) => {
    btn.addEventListener('click', () =>
      cancelBookingAction(btn.getAttribute('data-cancel-booking'))
    );
  });

  document.querySelectorAll('[data-open-booking]').forEach((btn) => {
    btn.addEventListener('click', () =>
      openBookingModal(btn.getAttribute('data-open-booking'))
    );
  });
}

async function confirmBookingAction(bookingId) {
  if (!bookingId) return;
  const { response, data } = await adminApiFetch(
    `/api/admin/bookings/${encodeURIComponent(bookingId)}/confirm`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  if (!response.ok || !data?.ok) {
    showFeedback(
      data?.error?.message || 'Не удалось подтвердить запись.',
      true
    );
    return;
  }
  showFeedback(`Запись ${bookingId} успешно подтверждена.`);
  await loadDashboardData({ silent: true });
}

async function cancelBookingAction(bookingId) {
  if (!bookingId) return;
  const { response, data } = await adminApiFetch(
    `/api/admin/bookings/${encodeURIComponent(bookingId)}/cancel`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  if (!response.ok || !data?.ok) {
    showFeedback(
      data?.error?.message || 'Не удалось отменить запись.',
      true
    );
    return;
  }
  showFeedback(`Запись ${bookingId} отменена, слоты времени освобождены.`);
  await loadDashboardData({ silent: true });
}

// ============================================================================
// МОДАЛЬНОЕ ОКНО: ДЕТАЛИ, СМЕНА СТАТУСА, ПЕРЕНОС И ИСТОРИЯ ЗАПИСИ
// ============================================================================

function openBookingModal(bookingId) {
  const booking = adminState.bookings.find((b) => b.id === bookingId);
  if (!booking) return;

  adminState.activeBookingModalId = booking.id;
  const modal = document.getElementById('admin-booking-modal');
  const idLabel = document.getElementById('modal-booking-id-label');
  const detailsBox = document.getElementById('modal-booking-details');
  const auditList = document.getElementById('modal-booking-audit-list');
  const reschedIdInput = document.getElementById('reschedule-booking-id');
  const reschedMasterSelect = document.getElementById('reschedule-master-select');
  const reschedDateInput = document.getElementById('reschedule-date-input');
  const reschedErrorBox = document.getElementById('reschedule-error-box');

  if (idLabel) idLabel.textContent = `Номер записи: ${booking.id}`;
  if (reschedIdInput) reschedIdInput.value = booking.id;
  if (reschedErrorBox) reschedErrorBox.hidden = true;

  if (detailsBox) {
    const badge = formatStatusLabel(booking.status);
    detailsBox.innerHTML = `
      <div class="booking-detail-card">
        <div class="detail-row"><span>Статус:</span> <span class="${badge.cls}">${badge.text}</span></div>
        <div class="detail-row"><span>Имя клиента:</span> <strong>${escapeHtml(booking.clientFirstName || booking.clientName)}</strong></div>
        <div class="detail-row"><span>Фамилия:</span> <strong>${escapeHtml(booking.clientLastName || '—')}</strong></div>
        <div class="detail-row"><span>Телефон:</span> <a href="tel:${escapeHtml(booking.clientPhone)}">${escapeHtml(booking.clientPhone)}</a></div>
        <div class="detail-row"><span>Услуга:</span> <strong>${escapeHtml(booking.serviceTitle)}</strong></div>
        <div class="detail-row"><span>Мастер:</span> <strong>${escapeHtml(booking.masterName)}</strong></div>
        <div class="detail-row"><span>Дата и время:</span> <strong>${escapeHtml(booking.date)} (${escapeHtml(booking.startTime)}–${escapeHtml(booking.endTime)})</strong></div>
        <div class="detail-row"><span>Длительность / Цена:</span> <strong>${booking.durationMinutes} мин • ${Number(booking.priceRub).toLocaleString('ru-RU')} ₽</strong></div>
        <div class="detail-row"><span>Комментарий:</span> <span>${escapeHtml(booking.clientComment || 'нет')}</span></div>
        <div class="detail-row"><span>Дата создания заявки:</span> <span>${escapeHtml(booking.createdAt || '—')}</span></div>
        <div class="detail-row"><span>Статус Telegram:</span> <span>${escapeHtml(booking.telegramStatus)} (попыток: ${booking.telegramAttempts})</span></div>
      </div>

      <div class="form-field" style="margin-top: 1rem;">
        <label for="modal-status-select" class="field-label">Изменить статус записи</label>
        <div class="modal-status-row">
          <select id="modal-status-select" class="field-input">
            <option value="confirmed" ${booking.status === 'confirmed' ? 'selected' : ''}>Подтверждена</option>
            <option value="pending" ${booking.status === 'pending' ? 'selected' : ''}>Ожидает подтверждения</option>
            <option value="completed" ${booking.status === 'completed' ? 'selected' : ''}>Выполнена (визит завершён)</option>
            <option value="cancelled" ${booking.status === 'cancelled' ? 'selected' : ''}>Отменена</option>
          </select>
          <button type="button" class="btn btn-outline btn-sm" id="modal-save-status-btn">Сохранить статус</button>
        </div>
      </div>
    `;

    const saveStatusBtn = document.getElementById('modal-save-status-btn');
    if (saveStatusBtn) {
      saveStatusBtn.addEventListener('click', async () => {
        const selectEl = document.getElementById('modal-status-select');
        const nextStatus = selectEl ? selectEl.value : booking.status;
        const { response, data } = await adminApiFetch(
          `/api/admin/bookings/${encodeURIComponent(booking.id)}/status`,
          {
            method: 'POST',
            body: JSON.stringify({ status: nextStatus }),
          }
        );
        if (!response.ok || !data?.ok) {
          showFeedback(
            data?.error?.message || 'Не удалось обновить статус.',
            true
          );
          return;
        }
        showFeedback(`Статус записи ${booking.id} обновлён.`);
        await loadDashboardData({ silent: true });
        openBookingModal(booking.id);
      });
    }
  }

  // Заполняем мастеров, оказывающих эту услугу
  if (reschedMasterSelect) {
    const eligibleMasters = adminState.masters.filter(
      (m) => m.isActive && (m.serviceIds || []).includes(booking.serviceId)
    );
    const listToUse = eligibleMasters.length > 0 ? eligibleMasters : adminState.masters;
    reschedMasterSelect.innerHTML = listToUse
      .map(
        (m) =>
          `<option value="${escapeHtml(m.id)}" ${
            m.id === booking.masterId ? 'selected' : ''
          }>${escapeHtml(m.name)}</option>`
      )
      .join('');
  }

  if (reschedDateInput) {
    reschedDateInput.value = booking.date;
  }

  loadAvailableSlotsForReschedule(booking.serviceId, booking.masterId, booking.date, booking.id, booking.startTime);

  if (auditList) {
    const logs = booking.auditLogs || [];
    if (logs.length === 0) {
      auditList.innerHTML = `<p class="field-hint">Запись создана ${escapeHtml(booking.createdAt || '')}.</p>`;
    } else {
      auditList.innerHTML = logs
        .map(
          (l) => `
          <div class="audit-log-item">
            <small>${escapeHtml(l.createdAt.replace('T', ' ').slice(0, 19))} • ${escapeHtml(l.actor)}</small>
            <div>${escapeHtml(l.details)}</div>
          </div>
        `
        )
        .join('');
    }
  }

  if (modal) modal.hidden = false;
}

async function loadAvailableSlotsForReschedule(serviceId, masterId, dateStr, bookingId, currentStartTime = '') {
  const timeSelect = document.getElementById('reschedule-time-select');
  if (!timeSelect || !serviceId || !dateStr) return;

  timeSelect.innerHTML = `<option value="">Загрузка свободного времени...</option>`;
  const params = new URLSearchParams({
    serviceId,
    masterId: masterId || 'any',
    date: dateStr,
    excludeBookingId: bookingId || '',
  });

  const { response, data } = await adminApiFetch(
    `/api/availability?${params.toString()}`,
    { method: 'GET' }
  );

  if (!response.ok || !data?.ok) {
    timeSelect.innerHTML = `<option value="">Нет доступных слотов (${escapeHtml(data?.error?.message || 'выходной')})</option>`;
    return;
  }

  const freeSlots = (data.slots || []).filter((s) => s.available);
  if (freeSlots.length === 0) {
    timeSelect.innerHTML = `<option value="">На выбранную дату свободных интервалов нет</option>`;
    return;
  }

  timeSelect.innerHTML = freeSlots
    .map(
      (s) =>
        `<option value="${escapeHtml(s.time)}" ${
          s.time === currentStartTime ? 'selected' : ''
        }>${escapeHtml(s.time)}–${escapeHtml(s.endTime)} (свободно)</option>`
    )
    .join('');
}

// ============================================================================
// УПРАВЛЕНИЕ УСЛУГАМИ И МАСТЕРАМИ (РАЗДЕЛ 5)
// ============================================================================

function renderServicesManagement() {
  const catSelect = document.getElementById('srv-category-select');
  if (catSelect && catSelect.options.length === 0) {
    catSelect.innerHTML = adminState.categories
      .map(
        (c) =>
          `<option value="${escapeHtml(c.id)}">${escapeHtml(c.title)}</option>`
      )
      .join('');
  }

  const listEl = document.getElementById('admin-services-list');
  if (!listEl) return;

  listEl.innerHTML = adminState.services
    .map(
      (s) => `
      <div class="admin-entity-item ${s.isActive ? '' : 'is-disabled'}">
        <div>
          <strong>${escapeHtml(s.title)}</strong>
          <div class="cell-sub">
            ${Number(s.priceRub).toLocaleString('ru-RU')} ₽ • ${s.durationMinutes} мин •
            ${s.isActive ? 'Включена на сайте' : 'Отключена (скрыта)'}
          </div>
        </div>
        <div class="admin-entity-actions">
          <button type="button" class="btn btn-outline btn-xs" data-edit-service="${escapeHtml(s.id)}">
            Изменить
          </button>
          <button type="button" class="btn btn-ghost btn-xs" data-toggle-service="${escapeHtml(s.id)}">
            ${s.isActive ? 'Отключить' : 'Включить'}
          </button>
        </div>
      </div>
    `
    )
    .join('');

  listEl.querySelectorAll('[data-edit-service]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const srv = adminState.services.find(
        (s) => s.id === btn.getAttribute('data-edit-service')
      );
      if (!srv) return;
      document.getElementById('srv-id-input').value = srv.id;
      document.getElementById('srv-title-input').value = srv.title;
      document.getElementById('srv-category-select').value = srv.categoryId;
      document.getElementById('srv-duration-input').value = srv.durationMinutes;
      document.getElementById('srv-price-input').value = srv.priceRub;
      document.getElementById('srv-active-select').value = srv.isActive ? '1' : '0';
      document.getElementById('srv-desc-input').value = srv.description || '';
    });
  });

  listEl.querySelectorAll('[data-toggle-service]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const srv = adminState.services.find(
        (s) => s.id === btn.getAttribute('data-toggle-service')
      );
      if (!srv) return;
      const { response, data } = await adminApiFetch('/api/admin/services', {
        method: 'POST',
        body: JSON.stringify({
          ...srv,
          isActive: !srv.isActive,
        }),
      });
      if (response.ok && data?.ok) {
        showFeedback(
          `Услуга «${srv.title}» ${!srv.isActive ? 'включена' : 'отключена'}.`
        );
        loadDashboardData({ silent: true });
      }
    });
  });
}

function renderMastersManagement() {
  const checkboxesContainer = document.getElementById('mst-services-checkboxes');
  if (checkboxesContainer) {
    const selectedId = document.getElementById('mst-id-input')?.value || '';
    const existingMaster = adminState.masters.find((m) => m.id === selectedId);
    const assignedSet = new Set(existingMaster?.serviceIds || []);

    checkboxesContainer.innerHTML = adminState.services
      .map(
        (s) => `
        <label class="admin-checkbox-item">
          <input type="checkbox" name="masterServiceIds" value="${escapeHtml(s.id)}" ${
          assignedSet.has(s.id) || !selectedId ? 'checked' : ''
        } />
          <span>${escapeHtml(s.title)}</span>
        </label>
      `
      )
      .join('');
  }

  const listEl = document.getElementById('admin-masters-list');
  if (!listEl) return;

  listEl.innerHTML = adminState.masters
    .map(
      (m) => `
      <div class="admin-entity-item ${m.isActive ? '' : 'is-disabled'}">
        <div>
          <strong>${escapeHtml(m.name)}</strong>
          <div class="cell-sub">
            ${escapeHtml(m.role)} • Услуг: ${(m.serviceIds || []).length} •
            ${m.isActive ? 'Принимает записи' : 'Отключён'}
          </div>
        </div>
        <div class="admin-entity-actions">
          <button type="button" class="btn btn-outline btn-xs" data-edit-master="${escapeHtml(m.id)}">
            Профиль
          </button>
          <button type="button" class="btn btn-primary btn-xs" data-schedule-master="${escapeHtml(m.id)}">
            График и перерывы
          </button>
        </div>
      </div>
    `
    )
    .join('');

  listEl.querySelectorAll('[data-edit-master]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mst = adminState.masters.find(
        (m) => m.id === btn.getAttribute('data-edit-master')
      );
      if (!mst) return;
      document.getElementById('mst-id-input').value = mst.id;
      document.getElementById('mst-name-input').value = mst.name;
      document.getElementById('mst-role-input').value = mst.role;
      document.getElementById('mst-exp-input').value = mst.experienceYears || 5;
      document.getElementById('mst-active-select').value = mst.isActive ? '1' : '0';
      renderMastersManagement();
    });
  });

  listEl.querySelectorAll('[data-schedule-master]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openScheduleEditor(btn.getAttribute('data-schedule-master'));
    });
  });
}

function openScheduleEditor(masterId) {
  const master = adminState.masters.find((m) => m.id === masterId);
  if (!master) return;

  const editor = document.getElementById('admin-schedule-editor');
  const titleEl = document.getElementById('schedule-editor-title');
  const masterIdInput = document.getElementById('schedule-master-id');
  const rowsContainer = document.getElementById('schedule-days-rows');
  const excList = document.getElementById('schedule-exceptions-list');

  if (titleEl) titleEl.textContent = `Расписание и перерывы: ${master.name}`;
  if (masterIdInput) masterIdInput.value = master.id;

  const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Пн..Вс
  if (rowsContainer) {
    rowsContainer.innerHTML = dayOrder
      .map((d) => {
        const sched = master.weeklySchedule?.[d] || {
          isWorking: true,
          startTime: '10:00',
          endTime: '21:00',
          breakStart: '14:00',
          breakEnd: '15:00',
        };
        return `
        <div class="schedule-day-row" data-day-row="${d}">
          <label class="schedule-day-name">
            <input type="checkbox" class="sched-working-cb" ${
              sched.isWorking ? 'checked' : ''
            } />
            <strong>${WEEKDAY_NAMES_FULL[d]}</strong>
          </label>
          <div class="schedule-time-inputs">
            <span>Смена:</span>
            <input type="time" class="field-input sched-start" value="${escapeHtml(
              sched.startTime || '10:00'
            )}" />
            <span>—</span>
            <input type="time" class="field-input sched-end" value="${escapeHtml(
              sched.endTime || '21:00'
            )}" />
            <span>Перерыв:</span>
            <input type="time" class="field-input sched-break-start" value="${escapeHtml(
              sched.breakStart || ''
            )}" />
            <span>—</span>
            <input type="time" class="field-input sched-break-end" value="${escapeHtml(
              sched.breakEnd || ''
            )}" />
          </div>
        </div>
      `;
      })
      .join('');
  }

  if (excList) {
    const exs = master.exceptions || [];
    excList.innerHTML =
      exs.length === 0
        ? `<p class="field-hint">Дополнительных выходных по датам не назначено.</p>`
        : exs
            .map(
              (ex) => `
          <div class="admin-entity-item">
            <div>
              <strong>${escapeHtml(ex.date)}</strong> — ${
                ex.isDayOff ? 'Выходной день' : 'Особая смена'
              } (${escapeHtml(ex.reason)})
            </div>
            <button type="button" class="btn btn-ghost btn-xs" data-remove-exc="${escapeHtml(
              ex.date
            )}">Удалить</button>
          </div>
        `
            )
            .join('');

    excList.querySelectorAll('[data-remove-exc]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const removeDate = btn.getAttribute('data-remove-exc');
        await adminApiFetch(
          `/api/admin/masters/${encodeURIComponent(master.id)}/schedule`,
          {
            method: 'PUT',
            body: JSON.stringify({ removeExceptionDate: removeDate }),
          }
        );
        await loadDashboardData({ silent: true });
        openScheduleEditor(master.id);
      });
    });
  }

  if (editor) {
    editor.hidden = false;
    editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function renderTelegramLogs() {
  const statusEl = document.getElementById('admin-tg-status-text');
  const listEl = document.getElementById('admin-tg-logs-list');
  const tg = adminState.telegramIntegration;

  if (statusEl && tg) {
    statusEl.textContent = tg.configured
      ? 'Секреты TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID подключены. Уведомления активны.'
      : 'Секреты Telegram ещё не заданы в окружении Worker. Все записи сохраняются в БД со статусом awaiting_configuration.';
  }

  if (!listEl) return;
  const logs = adminState.notificationLogs || [];
  if (logs.length === 0) {
    listEl.innerHTML = `<p class="field-hint">Журнал отправок Telegram пока пуст.</p>`;
    return;
  }

  listEl.innerHTML = logs
    .slice(0, 30)
    .map(
      (l) => `
      <div class="admin-entity-item">
        <div>
          <strong>Запись ${escapeHtml(l.booking_id)}</strong> • Статус: <code>${escapeHtml(
        l.status
      )}</code> (попытка #${l.attempt || 1})
          <div class="cell-sub">${escapeHtml(l.error_message || 'Доставлено успешно')}</div>
        </div>
        <small>${escapeHtml((l.created_at || '').replace('T', ' ').slice(0, 19))}</small>
      </div>
    `
    )
    .join('');
}

// ============================================================================
// АВТООБНОВЛЕНИЕ И ИНИЦИАЛИЗАЦИЯ СОБЫТИЙ
// ============================================================================

function startAutoRefresh() {
  stopAutoRefresh();
  adminState.autoRefreshTimer = setInterval(() => {
    if (
      adminState.authenticated &&
      adminState.autoRefreshEnabled &&
      document.visibilityState === 'visible'
    ) {
      loadDashboardData({ silent: true });
    }
  }, AUTO_REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (adminState.autoRefreshTimer) {
    clearInterval(adminState.autoRefreshTimer);
    adminState.autoRefreshTimer = null;
  }
}

function initAdminEvents() {
  // 1. Вход администратора
  const loginForm = document.getElementById('admin-login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const loginInput = document.getElementById('admin-username-input');
      const passInput = document.getElementById('admin-password-input');
      const errBox = document.getElementById('admin-login-error');
      const submitBtn = document.getElementById('admin-login-submit');

      if (errBox) errBox.hidden = true;
      if (submitBtn) submitBtn.disabled = true;

      try {
        const response = await fetch(`${API_BASE_URL}/api/admin/login`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            login: loginInput?.value || 'admin',
            password: passInput?.value || '',
          }),
        });
        const data = await response.json();

        if (!response.ok || !data?.ok) {
          if (errBox) {
            errBox.hidden = false;
            errBox.textContent =
              data?.error?.message || 'Ошибка авторизации.';
          }
          return;
        }

        adminState.csrfToken = data.csrfToken || '';
        adminState.sessionToken = data.sessionToken || '';
        sessionStorage.setItem('lea_admin_csrf', adminState.csrfToken);
        sessionStorage.setItem('lea_admin_token', adminState.sessionToken);
        if (passInput) passInput.value = '';

        await loadDashboardData();
      } catch {
        if (errBox) {
          errBox.hidden = false;
          errBox.textContent = 'Не удалось связаться с сервером.';
        }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  // 2. Выход из аккаунта
  const logoutBtn = document.getElementById('admin-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await adminApiFetch('/api/admin/logout', { method: 'POST', body: '{}' });
      handleUnauthenticatedState();
    });
  }

  // 3. Переключение вкладок
  document.querySelectorAll('[data-admin-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-admin-tab');
      document.querySelectorAll('[data-admin-tab]').forEach((b) => {
        b.classList.toggle('is-active', b === btn);
      });
      ['bookings', 'services', 'masters', 'notifications'].forEach((t) => {
        const panel = document.getElementById(`admin-tab-${t}`);
        if (panel) panel.hidden = t !== targetTab;
      });
    });
  });

  // 4. Фильтры и поиск
  const searchInput = document.getElementById('filter-search-input');
  let searchDebounce = null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        adminState.filterSearch = searchInput.value.trim();
        loadDashboardData({ silent: true });
      }, 250);
    });
  }

  const dateInput = document.getElementById('filter-date-input');
  if (dateInput) {
    dateInput.addEventListener('change', () => {
      adminState.filterDate = dateInput.value;
      loadDashboardData();
    });
  }

  const masterSelect = document.getElementById('filter-master-select');
  if (masterSelect) {
    masterSelect.addEventListener('change', () => {
      adminState.filterMasterId = masterSelect.value;
      loadDashboardData();
    });
  }

  const serviceSelect = document.getElementById('filter-service-select');
  if (serviceSelect) {
    serviceSelect.addEventListener('change', () => {
      adminState.filterServiceId = serviceSelect.value;
      loadDashboardData();
    });
  }

  const statusSelect = document.getElementById('filter-status-select');
  if (statusSelect) {
    statusSelect.addEventListener('change', () => {
      adminState.filterStatus = statusSelect.value;
      loadDashboardData();
    });
  }

  const resetBtn = document.getElementById('filter-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      adminState.filterSearch = '';
      adminState.filterDate = '';
      adminState.filterMasterId = 'all';
      adminState.filterServiceId = 'all';
      adminState.filterStatus = 'all';
      if (searchInput) searchInput.value = '';
      if (dateInput) dateInput.value = '';
      if (masterSelect) masterSelect.value = 'all';
      if (serviceSelect) serviceSelect.value = 'all';
      if (statusSelect) statusSelect.value = 'all';
      loadDashboardData();
    });
  }

  // Быстрые кнопки календаря
  document.getElementById('admin-cal-prev')?.addEventListener('click', () => {
    if (adminState.calMonth === 0) {
      adminState.calMonth = 11;
      adminState.calYear -= 1;
    } else {
      adminState.calMonth -= 1;
    }
    renderAdminCalendar();
  });

  document.getElementById('admin-cal-next')?.addEventListener('click', () => {
    if (adminState.calMonth === 11) {
      adminState.calMonth = 0;
      adminState.calYear += 1;
    } else {
      adminState.calMonth += 1;
    }
    renderAdminCalendar();
  });

  document.getElementById('admin-filter-all-dates-btn')?.addEventListener('click', () => {
    adminState.filterDate = '';
    if (dateInput) dateInput.value = '';
    loadDashboardData();
  });

  document.getElementById('admin-filter-today-btn')?.addEventListener('click', () => {
    adminState.filterDate = adminState.serverToday;
    if (dateInput) dateInput.value = adminState.serverToday;
    loadDashboardData();
  });

  // Автообновление и ручное обновление
  document.getElementById('admin-autorefresh-checkbox')?.addEventListener('change', (e) => {
    adminState.autoRefreshEnabled = Boolean(e.target.checked);
  });

  document.getElementById('admin-refresh-now-btn')?.addEventListener('click', () => {
    loadDashboardData();
  });

  // Закрытие модального окна записи и форма переноса
  document.getElementById('modal-booking-close')?.addEventListener('click', () => {
    document.getElementById('admin-booking-modal').hidden = true;
  });

  const reschedMasterSelect = document.getElementById('reschedule-master-select');
  const reschedDateInput = document.getElementById('reschedule-date-input');
  const triggerRescheduleSlotsReload = () => {
    const bId = document.getElementById('reschedule-booking-id')?.value;
    const b = adminState.bookings.find((x) => x.id === bId);
    if (!b) return;
    loadAvailableSlotsForReschedule(
      b.serviceId,
      reschedMasterSelect?.value || b.masterId,
      reschedDateInput?.value || b.date,
      b.id
    );
  };
  reschedMasterSelect?.addEventListener('change', triggerRescheduleSlotsReload);
  reschedDateInput?.addEventListener('change', triggerRescheduleSlotsReload);

  const reschedForm = document.getElementById('admin-reschedule-form');
  if (reschedForm) {
    reschedForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const bId = document.getElementById('reschedule-booking-id')?.value;
      const newMasterId = reschedMasterSelect?.value;
      const newDate = reschedDateInput?.value;
      const newTime = document.getElementById('reschedule-time-select')?.value;
      const errBox = document.getElementById('reschedule-error-box');

      if (!bId || !newDate || !newTime) {
        if (errBox) {
          errBox.hidden = false;
          errBox.textContent = 'Выберите доступную дату и свободный интервал времени.';
        }
        return;
      }

      const { response, data } = await adminApiFetch(
        `/api/admin/bookings/${encodeURIComponent(bId)}/reschedule`,
        {
          method: 'POST',
          body: JSON.stringify({
            masterId: newMasterId,
            date: newDate,
            time: newTime,
          }),
        }
      );

      if (!response.ok || !data?.ok) {
        if (errBox) {
          errBox.hidden = false;
          errBox.textContent =
            data?.error?.message || 'Не удалось перенести запись.';
        }
        return;
      }

      showFeedback(`Запись ${bId} успешно перенесена на ${newDate} в ${newTime}.`);
      await loadDashboardData({ silent: true });
      openBookingModal(bId);
    });
  }

  // Сохранение услуги
  const serviceForm = document.getElementById('admin-service-form');
  if (serviceForm) {
    serviceForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        id: document.getElementById('srv-id-input').value.trim(),
        title: document.getElementById('srv-title-input').value.trim(),
        categoryId: document.getElementById('srv-category-select').value,
        durationMinutes: Number(document.getElementById('srv-duration-input').value),
        priceRub: Number(document.getElementById('srv-price-input').value),
        isActive: document.getElementById('srv-active-select').value === '1',
        description: document.getElementById('srv-desc-input').value.trim(),
      };
      const { response, data } = await adminApiFetch('/api/admin/services', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!response.ok || !data?.ok) {
        showFeedback(data?.error?.message || 'Ошибка сохранения услуги.', true);
        return;
      }
      showFeedback(`Услуга «${payload.title}» сохранена.`);
      serviceForm.reset();
      document.getElementById('srv-id-input').value = '';
      await loadDashboardData({ silent: true });
    });
  }

  document.getElementById('srv-form-clear-btn')?.addEventListener('click', () => {
    document.getElementById('admin-service-form')?.reset();
    document.getElementById('srv-id-input').value = '';
  });

  // Сохранение мастера
  const masterForm = document.getElementById('admin-master-form');
  if (masterForm) {
    masterForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const checkedServices = Array.from(
        document.querySelectorAll('input[name="masterServiceIds"]:checked')
      ).map((cb) => cb.value);

      const payload = {
        id: document.getElementById('mst-id-input').value.trim(),
        name: document.getElementById('mst-name-input').value.trim(),
        role: document.getElementById('mst-role-input').value.trim(),
        experienceYears: Number(document.getElementById('mst-exp-input').value || 5),
        isActive: document.getElementById('mst-active-select').value === '1',
        serviceIds: checkedServices,
      };

      const { response, data } = await adminApiFetch('/api/admin/masters', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!response.ok || !data?.ok) {
        showFeedback(data?.error?.message || 'Ошибка сохранения мастера.', true);
        return;
      }
      showFeedback(`Профиль мастера «${payload.name}» сохранён.`);
      masterForm.reset();
      document.getElementById('mst-id-input').value = '';
      await loadDashboardData({ silent: true });
    });
  }

  document.getElementById('mst-form-clear-btn')?.addEventListener('click', () => {
    document.getElementById('admin-master-form')?.reset();
    document.getElementById('mst-id-input').value = '';
    renderMastersManagement();
  });

  // Сохранение расписания мастера
  const scheduleForm = document.getElementById('admin-schedule-form');
  if (scheduleForm) {
    scheduleForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const masterId = document.getElementById('schedule-master-id').value;
      const rows = Array.from(document.querySelectorAll('[data-day-row]'));
      const schedules = rows.map((row) => ({
        dayOfWeek: Number(row.getAttribute('data-day-row')),
        isWorking: row.querySelector('.sched-working-cb').checked,
        startTime: row.querySelector('.sched-start').value || '10:00',
        endTime: row.querySelector('.sched-end').value || '21:00',
        breakStart: row.querySelector('.sched-break-start').value || null,
        breakEnd: row.querySelector('.sched-break-end').value || null,
      }));

      const { response, data } = await adminApiFetch(
        `/api/admin/masters/${encodeURIComponent(masterId)}/schedule`,
        {
          method: 'PUT',
          body: JSON.stringify({ schedules }),
        }
      );
      if (response.ok && data?.ok) {
        showFeedback('Расписание мастера успешно сохранено.');
        await loadDashboardData({ silent: true });
      }
    });
  }

  document.getElementById('schedule-editor-close-btn')?.addEventListener('click', () => {
    document.getElementById('admin-schedule-editor').hidden = true;
  });

  const excForm = document.getElementById('admin-exception-form');
  if (excForm) {
    excForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const masterId = document.getElementById('schedule-master-id').value;
      const date = document.getElementById('exc-date-input').value;
      const isDayOff = document.getElementById('exc-type-select').value === 'day_off';
      const reason = document.getElementById('exc-reason-input').value.trim();

      const { response, data } = await adminApiFetch(
        `/api/admin/masters/${encodeURIComponent(masterId)}/schedule`,
        {
          method: 'PUT',
          body: JSON.stringify({
            addException: { date, isDayOff, reason },
          }),
        }
      );
      if (response.ok && data?.ok) {
        showFeedback(`Исключение на дату ${date} добавлено.`);
        excForm.reset();
        await loadDashboardData({ silent: true });
        openScheduleEditor(masterId);
      }
    });
  }

  // Повторная отправка очереди Telegram
  document.getElementById('admin-retry-tg-btn')?.addEventListener('click', async () => {
    const { response, data } = await adminApiFetch(
      '/api/admin/notifications/retry',
      { method: 'POST', body: '{}' }
    );
    if (response.ok && data?.ok) {
      showFeedback(
        `Обработано уведомлений: ${data.summary?.processed || 0}, отправлено: ${
          data.summary?.sent || 0
        }.`
      );
      loadDashboardData({ silent: true });
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  initAdminEvents();
  // Проверяем, есть ли уже активная серверная сессия (Cookie или токен)
  await loadDashboardData({ silent: true });
});
