/**
 * LÉA STUDIO — Клиентское приложение и интегрированная панель администратора
 * На чистом JavaScript (Vanilla ES Modules) без сторонних библиотек.
 */

const API_BASE_URL = (window.LEA_API_BASE_URL || '').replace(/\/+$/, '');

const MONTH_NAMES_NOMINATIVE = [
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

const MONTH_NAMES_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

const WEEKDAY_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const state = {
  catalogLoaded: false,
  salon: null,
  categories: [],
  services: [],
  masters: [],

  // Фильтр витрины услуг
  catalogCategoryFilter: 'all',

  // Состояние пошаговой формы онлайн-записи
  wizardCategoryFilter: 'all',
  currentStep: 1,
  selectedServiceId: null,
  selectedMasterId: null,
  preselectedMasterFilterId: null,
  selectedDate: null,
  selectedSlot: null,
  calendarYear: null,
  calendarMonth: null,

  // Сессия временного удержания слота и идемпотентность
  holdToken: getOrCreateHoldToken(),
  holdExpiresAt: null,
  holdIntervalId: null,
  activeIdempotencyKey: null,
  isSubmitting: false,
  confirmedBooking: null,
};

const adminState = {
  authenticated: false,
  csrfToken: '',
  login: '',
  serverToday: '',
  bookings: [],
  masters: [],
  services: [],
  filterDate: '',
  filterStatus: 'all',
  filterMasterId: 'all',
  filterSearch: '',
  pollTimerId: null,
};

function getOrCreateHoldToken() {
  try {
    const existing = sessionStorage.getItem('lea_hold_token');
    if (existing && existing.length >= 12) return existing;
    const token = generateRandomToken('hold');
    sessionStorage.setItem('lea_hold_token', token);
    return token;
  } catch {
    return generateRandomToken('hold');
  }
}

function generateRandomToken(prefix = 'idemp') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPriceRub(price) {
  return `${Number(price || 0).toLocaleString('ru-RU')} ₽`;
}

function formatHumanDate(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return 'Не выбрана';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = WEEKDAY_SHORT[dt.getUTCDay()];
  return `${d} ${MONTH_NAMES_GENITIVE[m - 1]} ${y} (${wd})`;
}

/**
 * Авторские художественные портреты мастеров в тёплой эстетике LÉA STUDIO
 */
function renderMasterPortraitSvg(portraitKey) {
  const palettes = {
    anna: { bg: '#F6ECEA', arch: '#EAE0D7', hair: '#4A3630', outfit: '#D8B7B5', accent: '#A86874' },
    maria: { bg: '#EAE0D7', arch: '#F6ECEA', hair: '#352824', outfit: '#C9929C', accent: '#925560' },
    elena: { bg: '#F4DFDE', arch: '#FAF6F2', hair: '#826452', outfit: '#E2D4C8', accent: '#A86874' },
    sofia: { bg: '#F6ECEA', arch: '#F4DFDE', hair: '#45332E', outfit: '#D4C0B2', accent: '#A86874' },
  };
  const p = palettes[portraitKey] || palettes.anna;

  return `
    <svg class="master-portrait-svg" viewBox="0 0 180 220" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="180" height="220" fill="${p.bg}" />
      <path d="M24 220V96C24 59.5492 53.5492 30 90 30C126.451 30 156 59.5492 156 96V220H24Z" fill="${p.arch}" />
      <path d="M52 102C52 68 68 48 90 48C112 48 128 68 128 102C128 126 122 146 116 154H64C58 146 52 126 52 102Z" fill="${p.hair}" />
      <path d="M28 220C32 178 56 158 90 158C124 158 148 178 152 220H28Z" fill="${p.outfit}" />
      <path d="M74 158L90 186L106 158" fill="#FAF6F2" opacity="0.8" />
      <rect x="80" y="130" width="20" height="34" rx="10" fill="#F5DFD5" />
      <ellipse cx="90" cy="102" rx="27" ry="34" fill="#F9E6DD" />
      <path d="M63 96C65 74 78 62 94 64C108 66 116 78 117 96C110 84 100 76 86 76C74 76 67 84 63 96Z" fill="${p.hair}" />
      <path d="M76 98C79 95 83 95 85 98" stroke="#2C221E" stroke-width="1.6" stroke-linecap="round" />
      <path d="M95 98C97 95 101 95 104 98" stroke="#2C221E" stroke-width="1.6" stroke-linecap="round" />
      <path d="M90 100V110C90 111.5 88.5 112.5 87 112.5" stroke="#B89B92" stroke-width="1.4" stroke-linecap="round" />
      <path d="M83 120C87 123 93 123 97 120" stroke="${p.accent}" stroke-width="1.8" stroke-linecap="round" />
      <circle cx="62" cy="112" r="2.8" fill="#FAF6F2" />
      <circle cx="118" cy="112" r="2.8" fill="#FAF6F2" />
    </svg>
  `;
}

async function apiRequest(path, options = {}) {
  const url = `${API_BASE_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (adminState.csrfToken && options.method && options.method !== 'GET') {
    headers['X-CSRF-Token'] = adminState.csrfToken;
  }

  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    throw new Error('Сервер вернул некорректный ответ.');
  }

  if (!response.ok || !data || data.ok === false) {
    const err = new Error(
      (data && data.error && data.error.message) ||
        `Ошибка запроса (${response.status})`
    );
    err.code = (data && data.error && data.error.code) || `HTTP_${response.status}`;
    err.status = response.status;
    throw err;
  }

  return data;
}

// ============================================================================
// ЗАГРУЗКА КАТАЛОГА И ОТРИСОВКА РАЗДЕЛОВ САЙТА
// ============================================================================

async function loadCatalog() {
  const banner = document.getElementById('api-error-banner');
  const bannerText = document.getElementById('api-error-text');

  try {
    if (banner) banner.hidden = true;
    const data = await apiRequest('/api/catalog', { method: 'GET' });

    state.catalogLoaded = true;
    state.salon = data.salon;
    state.categories = data.categories || [];
    state.services = data.services || [];
    state.masters = data.masters || [];

    const todayParts = (state.salon.serverToday || '2026-10-29').split('-').map(Number);
    state.calendarYear = todayParts[0];
    state.calendarMonth = todayParts[1] - 1;

    renderContactsFromConfig();
    renderCatalogCategoryTabs();
    renderServicesCatalog();
    renderMastersCatalog();

    renderWizardStep1();
    updateBookingSummary();
  } catch (err) {
    if (banner) {
      banner.hidden = false;
      if (bannerText) {
        bannerText.textContent =
          err.message ||
          'Не удалось загрузить каталог услуг. Убедитесь, что серверная часть запущена.';
      }
    }
    const srvGrid = document.getElementById('services-grid');
    if (srvGrid) {
      srvGrid.innerHTML = `<div class="loading-skeleton">Не удалось загрузить список услуг с сервера. Нажмите «Повторить загрузку» в верхней панели.</div>`;
    }
  }
}

function renderContactsFromConfig() {
  if (!state.salon) return;
  const addrEl = document.getElementById('contact-address');
  const phoneEl = document.getElementById('contact-phone');
  const hoursEl = document.getElementById('contact-hours');
  const footerAddrEl = document.getElementById('footer-contact-address');
  const footerPhoneEl = document.getElementById('footer-contact-phone');
  const footerHoursEl = document.getElementById('footer-contact-hours');

  const rawAddress = state.salon.addressPlaceholder || '';
  const cleanAddress = rawAddress.includes('[')
    ? 'г. Москва, ул. Малая Бронная, д. 24, стр. 1'
    : rawAddress;

  const rawPhone = state.salon.phonePlaceholder || '';
  const cleanPhone =
    rawPhone.includes('[') || rawPhone.includes('000-00-00')
      ? '+7 (495) 128-45-90'
      : rawPhone;

  if (cleanAddress) {
    if (addrEl) addrEl.textContent = cleanAddress;
    if (footerAddrEl) footerAddrEl.textContent = cleanAddress;
  }
  if (cleanPhone) {
    if (phoneEl) phoneEl.textContent = cleanPhone;
    if (footerPhoneEl) footerPhoneEl.textContent = cleanPhone;
  }
  if (state.salon.workHoursLabel) {
    if (hoursEl) hoursEl.textContent = state.salon.workHoursLabel;
    if (footerHoursEl) footerHoursEl.textContent = state.salon.workHoursLabel;
  }
}

function renderCatalogCategoryTabs() {
  const container = document.getElementById('service-category-tabs');
  if (!container) return;

  const allBtn = `
    <button
      type="button"
      role="tab"
      aria-selected="${state.catalogCategoryFilter === 'all'}"
      class="category-tab-btn ${state.catalogCategoryFilter === 'all' ? 'is-active' : ''}"
      data-cat-filter="all"
    >
      Все направления
    </button>
  `;

  const catBtns = state.categories
    .map(
      (cat) => `
      <button
        type="button"
        role="tab"
        aria-selected="${state.catalogCategoryFilter === cat.id}"
        class="category-tab-btn ${state.catalogCategoryFilter === cat.id ? 'is-active' : ''}"
        data-cat-filter="${escapeHtml(cat.id)}"
      >
        ${escapeHtml(cat.title)}
      </button>
    `
    )
    .join('');

  container.innerHTML = allBtn + catBtns;

  container.querySelectorAll('[data-cat-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.catalogCategoryFilter = btn.getAttribute('data-cat-filter') || 'all';
      renderCatalogCategoryTabs();
      renderServicesCatalog();
    });
  });
}

function renderServicesCatalog() {
  const grid = document.getElementById('services-grid');
  if (!grid) return;

  const categoryMap = {};
  for (const c of state.categories) {
    categoryMap[c.id] = c.title;
  }

  const filtered =
    state.catalogCategoryFilter === 'all'
      ? state.services
      : state.services.filter((s) => s.categoryId === state.catalogCategoryFilter);

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="loading-skeleton">В выбранной категории пока нет услуг.</div>`;
    return;
  }

  grid.innerHTML = filtered
    .map((srv) => {
      const catTitle = categoryMap[srv.categoryId] || 'Ритуал ухода';
      return `
        <article class="service-card">
          <div class="service-card-top">
            <div class="service-meta-line">
              <span>${escapeHtml(catTitle)}</span>
              <span aria-hidden="true">·</span>
              <span class="tabular-nums">${srv.durationMinutes} мин.</span>
            </div>
            <h3 class="service-card-title">${escapeHtml(srv.title)}</h3>
            <p class="service-card-desc">${escapeHtml(srv.description)}</p>
          </div>
          <div class="service-card-footer">
            <span class="service-price tabular-nums">${formatPriceRub(srv.priceRub)}</span>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              data-book-service="${escapeHtml(srv.id)}"
            >
              Записаться
            </button>
          </div>
        </article>
      `;
    })
    .join('');

  grid.querySelectorAll('[data-book-service]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const serviceId = btn.getAttribute('data-book-service');
      startBookingWithService(serviceId);
    });
  });
}

function renderMastersCatalog() {
  const grid = document.getElementById('masters-grid');
  if (!grid) return;

  const serviceById = {};
  for (const s of state.services) {
    serviceById[s.id] = s;
  }

  grid.innerHTML = state.masters
    .map((mst) => {
      const performedTitles = (mst.serviceIds || [])
        .map((id) => serviceById[id]?.title)
        .filter(Boolean);

      return `
        <article class="master-card">
          <div class="master-portrait-box">
            ${renderMasterPortraitSvg(mst.portraitKey)}
          </div>
          <div class="master-content">
            <div class="master-meta">
              <span>${escapeHtml(mst.role)}</span>
              <span aria-hidden="true">·</span>
              <span class="tabular-nums">Опыт ${mst.experienceYears} лет</span>
            </div>
            <h3 class="master-name">${escapeHtml(mst.name)}</h3>
            <p class="master-spec">${escapeHtml(mst.specialization)}</p>
            <p class="master-bio">${escapeHtml(mst.bio)}</p>
            <div class="master-services-caption">Выполняемые процедуры:</div>
            <div class="master-services-inline">
              ${performedTitles.map(escapeHtml).join(' · ')}
            </div>
            <button
              type="button"
              class="btn btn-secondary btn-sm master-book-btn"
              data-book-master="${escapeHtml(mst.id)}"
            >
              Записаться к мастеру
            </button>
          </div>
        </article>
      `;
    })
    .join('');

  grid.querySelectorAll('[data-book-master]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const masterId = btn.getAttribute('data-book-master');
      startBookingWithMaster(masterId);
    });
  });
}

// ============================================================================
// ПОШАГОВАЯ ФОРМА ОНЛАЙН-ЗАПИСИ (ШАГИ 1 — 6)
// ============================================================================

function showFormAlert(message) {
  const alertEl = document.getElementById('booking-form-alert');
  if (!alertEl) return;
  if (!message) {
    alertEl.hidden = true;
    alertEl.textContent = '';
    return;
  }
  alertEl.textContent = message;
  alertEl.hidden = false;
}

function goToStep(stepNumber) {
  state.currentStep = stepNumber;
  showFormAlert('');

  for (let i = 1; i <= 6; i++) {
    const pane = document.getElementById(`step-pane-${i}`);
    if (pane) {
      pane.hidden = i !== stepNumber;
    }

    const indicator = document.querySelector(`[data-step-indicator="${i}"]`);
    const btn = document.querySelector(`[data-goto-step="${i}"]`);
    if (indicator && btn) {
      indicator.classList.toggle('is-active', i === stepNumber);
      indicator.classList.toggle('is-completed', i < stepNumber);

      if (stepNumber === 6) {
        btn.disabled = true;
      } else {
        btn.disabled = i > stepNumber;
      }
    }
  }

  updateBookingSummary();
}

function startBookingWithService(serviceId) {
  const srv = state.services.find((s) => s.id === serviceId);
  if (!srv) return;

  state.preselectedMasterFilterId = null;
  selectServiceInWizard(serviceId, true);

  const bookingSection = document.getElementById('booking');
  if (bookingSection) {
    bookingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function startBookingWithMaster(masterId) {
  const master = state.masters.find((m) => m.id === masterId);
  if (!master) return;

  state.preselectedMasterFilterId = master.id;
  state.selectedMasterId = master.id;

  if (
    state.selectedServiceId &&
    !master.serviceIds.includes(state.selectedServiceId)
  ) {
    state.selectedServiceId = null;
    state.selectedDate = null;
    state.selectedSlot = null;
  }

  state.wizardCategoryFilter = 'all';
  renderWizardStep1();
  goToStep(1);
  showFormAlert(
    `Выбран специалист ${master.name}. Показаны процедуры, которые выполняет этот мастер.`
  );

  const bookingSection = document.getElementById('booking');
  if (bookingSection) {
    bookingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function renderWizardStep1() {
  const filterWrap = document.getElementById('wizard-category-filter');
  const listWrap = document.getElementById('wizard-service-list');
  if (!filterWrap || !listWrap) return;

  const preMaster = state.preselectedMasterFilterId
    ? state.masters.find((m) => m.id === state.preselectedMasterFilterId)
    : null;

  const availableServices = preMaster
    ? state.services.filter((s) => preMaster.serviceIds.includes(s.id))
    : state.services;

  const allTab = `
    <button
      type="button"
      class="category-tab-btn ${state.wizardCategoryFilter === 'all' ? 'is-active' : ''}"
      data-wiz-cat="all"
    >
      Все (${availableServices.length})
    </button>
  `;

  const catTabs = state.categories
    .map((cat) => {
      const count = availableServices.filter((s) => s.categoryId === cat.id).length;
      if (count === 0) return '';
      return `
        <button
          type="button"
          class="category-tab-btn ${state.wizardCategoryFilter === cat.id ? 'is-active' : ''}"
          data-wiz-cat="${escapeHtml(cat.id)}"
        >
          ${escapeHtml(cat.title)} (${count})
        </button>
      `;
    })
    .join('');

  const clearMasterBtn = preMaster
    ? `<button type="button" class="category-tab-btn" id="clear-premaster-btn">Показать все услуги ✕</button>`
    : '';

  filterWrap.innerHTML = allTab + catTabs + clearMasterBtn;

  filterWrap.querySelectorAll('[data-wiz-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.wizardCategoryFilter = btn.getAttribute('data-wiz-cat') || 'all';
      renderWizardStep1();
    });
  });

  const clearBtn = document.getElementById('clear-premaster-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      state.preselectedMasterFilterId = null;
      renderWizardStep1();
      showFormAlert('');
    });
  }

  const displayedServices =
    state.wizardCategoryFilter === 'all'
      ? availableServices
      : availableServices.filter((s) => s.categoryId === state.wizardCategoryFilter);

  listWrap.innerHTML = displayedServices
    .map((srv) => {
      const isSelected = state.selectedServiceId === srv.id;
      return `
        <button
          type="button"
          role="radio"
          aria-checked="${isSelected}"
          class="wizard-option-card ${isSelected ? 'is-selected' : ''}"
          data-select-service="${escapeHtml(srv.id)}"
        >
          <div class="option-main">
            <span class="option-title">${escapeHtml(srv.title)}</span>
            <span class="option-sub">${escapeHtml(srv.description)}</span>
          </div>
          <div class="option-right">
            <span class="option-price tabular-nums">${formatPriceRub(srv.priceRub)}</span>
            <span class="option-duration tabular-nums">${srv.durationMinutes} мин.</span>
          </div>
        </button>
      `;
    })
    .join('');

  listWrap.querySelectorAll('[data-select-service]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const serviceId = btn.getAttribute('data-select-service');
      selectServiceInWizard(serviceId, true);
    });
  });
}

function selectServiceInWizard(serviceId, advance = true) {
  const srv = state.services.find((s) => s.id === serviceId);
  if (!srv) return;

  const serviceChanged = state.selectedServiceId !== serviceId;
  state.selectedServiceId = serviceId;

  if (serviceChanged) {
    state.selectedSlot = null;
    releaseActiveHoldSilently();
  }

  const eligibleMasters = state.masters.filter((m) =>
    (m.serviceIds || []).includes(serviceId)
  );

  if (
    state.selectedMasterId &&
    state.selectedMasterId !== 'any' &&
    !eligibleMasters.some((m) => m.id === state.selectedMasterId)
  ) {
    state.selectedMasterId = null;
  }

  renderWizardStep1();
  renderWizardStep2Masters();

  if (advance) {
    if (
      state.preselectedMasterFilterId &&
      eligibleMasters.some((m) => m.id === state.preselectedMasterFilterId)
    ) {
      state.selectedMasterId = state.preselectedMasterFilterId;
      renderWizardStep3Calendar();
      goToStep(3);
    } else {
      goToStep(2);
    }
  } else {
    updateBookingSummary();
  }
}

function renderWizardStep2Masters() {
  const listWrap = document.getElementById('wizard-master-list');
  const hintEl = document.getElementById('step-2-service-hint');
  if (!listWrap) return;

  const srv = state.services.find((s) => s.id === state.selectedServiceId);
  if (hintEl && srv) {
    hintEl.textContent = `Для услуги «${srv.title}» (${srv.durationMinutes} мин.) доступны следующие специалисты:`;
  }

  const eligibleMasters = state.masters.filter((m) =>
    (m.serviceIds || []).includes(state.selectedServiceId)
  );

  const anySelected = state.selectedMasterId === 'any';
  const anyCard = `
    <button
      type="button"
      role="radio"
      aria-checked="${anySelected}"
      class="wizard-option-card ${anySelected ? 'is-selected' : ''}"
      data-select-master="any"
    >
      <div class="option-main">
        <span class="option-title">Любой свободный специалист</span>
        <span class="option-sub">Покажем все доступные интервалы и автоматически подберём профильного мастера</span>
      </div>
      <div class="option-right">
        <span class="option-price">Быстрый подбор</span>
      </div>
    </button>
  `;

  const masterCards = eligibleMasters
    .map((mst) => {
      const isSelected = state.selectedMasterId === mst.id;
      return `
        <button
          type="button"
          role="radio"
          aria-checked="${isSelected}"
          class="wizard-option-card ${isSelected ? 'is-selected' : ''}"
          data-select-master="${escapeHtml(mst.id)}"
        >
          <div class="option-main">
            <span class="option-title">${escapeHtml(mst.name)}</span>
            <span class="option-sub">${escapeHtml(mst.role)} · ${escapeHtml(mst.specialization)}</span>
          </div>
          <div class="option-right">
            <span class="option-duration tabular-nums">Стаж ${mst.experienceYears} лет</span>
          </div>
        </button>
      `;
    })
    .join('');

  listWrap.innerHTML = anyCard + masterCards;

  listWrap.querySelectorAll('[data-select-master]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const masterId = btn.getAttribute('data-select-master');
      selectMasterInWizard(masterId, true);
    });
  });
}

function selectMasterInWizard(masterId, advance = true) {
  if (state.selectedMasterId !== masterId) {
    state.selectedSlot = null;
    releaseActiveHoldSilently();
  }
  state.selectedMasterId = masterId;
  renderWizardStep2Masters();
  renderWizardStep3Calendar();

  if (advance) {
    goToStep(3);
  } else {
    updateBookingSummary();
  }
}

function isWeekdayWorkingForSelection(dayOfWeek) {
  if (!state.selectedMasterId) return true;

  if (state.selectedMasterId === 'any') {
    const eligible = state.masters.filter((m) =>
      (m.serviceIds || []).includes(state.selectedServiceId)
    );
    return eligible.some((m) =>
      (m.workingDays || []).some((wd) => Number(wd.dayOfWeek) === dayOfWeek)
    );
  }

  const mst = state.masters.find((m) => m.id === state.selectedMasterId);
  if (!mst || !mst.workingDays) return true;
  return mst.workingDays.some((wd) => Number(wd.dayOfWeek) === dayOfWeek);
}

function renderWizardStep3Calendar() {
  const monthLabel = document.getElementById('cal-month-label');
  const grid = document.getElementById('calendar-days-grid');
  const quickRow = document.getElementById('calendar-quick-row');
  if (!monthLabel || !grid) return;

  const serverTodayStr = state.salon?.serverToday || '2026-10-29';
  const [tY, tM, tD] = serverTodayStr.split('-').map(Number);
  const todayUtcMs = Date.UTC(tY, tM - 1, tD);
  const horizonDays = Number(state.salon?.bookingHorizonDays || 45);
  const maxUtcMs = todayUtcMs + horizonDays * 86400000;

  if (quickRow) {
    const quickButtons = [];
    for (let offset = 0; offset < 14 && quickButtons.length < 5; offset++) {
      const dt = new Date(todayUtcMs + offset * 86400000);
      const dow = dt.getUTCDay();
      if (!isWeekdayWorkingForSelection(dow)) continue;

      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const d = String(dt.getUTCDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${d}`;

      let label = `${dt.getUTCDate()} ${MONTH_NAMES_GENITIVE[dt.getUTCMonth()]} (${WEEKDAY_SHORT[dow]})`;
      if (offset === 0) label = `Сегодня, ${dt.getUTCDate()} ${MONTH_NAMES_GENITIVE[dt.getUTCMonth()]}`;
      else if (offset === 1) label = `Завтра, ${dt.getUTCDate()} ${MONTH_NAMES_GENITIVE[dt.getUTCMonth()]}`;

      const isSel = state.selectedDate === dateStr;
      quickButtons.push(`
        <button
          type="button"
          class="quick-date-btn ${isSel ? 'is-selected' : ''}"
          data-quick-date="${dateStr}"
        >
          ${escapeHtml(label)}
        </button>
      `);
    }
    quickRow.innerHTML = quickButtons.join('');
    quickRow.querySelectorAll('[data-quick-date]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dStr = btn.getAttribute('data-quick-date');
        selectDateInWizard(dStr);
      });
    });
  }

  const year = state.calendarYear || tY;
  const month = state.calendarMonth != null ? state.calendarMonth : tM - 1;
  monthLabel.textContent = `${MONTH_NAMES_NOMINATIVE[month]} ${year}`;

  const prevBtn = document.getElementById('cal-prev-month');
  if (prevBtn) {
    prevBtn.disabled = year < tY || (year === tY && month <= tM - 1);
  }

  const firstDayOfMonth = new Date(Date.UTC(year, month, 1));
  const firstWeekdayMonBased = (firstDayOfMonth.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  const cells = [];
  for (let i = 0; i < firstWeekdayMonBased; i++) {
    cells.push(`<div class="cal-day-empty" aria-hidden="true"></div>`);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const cellDate = new Date(Date.UTC(year, month, day));
    const cellMs = cellDate.getTime();
    const dow = cellDate.getUTCDay();
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const isPast = cellMs < todayUtcMs;
    const isTooFar = cellMs > maxUtcMs;
    const isWorkingDow = isWeekdayWorkingForSelection(dow);
    const isDisabled = isPast || isTooFar || !isWorkingDow;
    const isSelected = state.selectedDate === dateStr;

    let note = '';
    if (isPast) {
      note = 'прошло';
    } else if (!isWorkingDow) {
      note = 'выходной';
    } else if (dateStr === serverTodayStr) {
      note = 'сегодня';
    }

    cells.push(`
      <button
        type="button"
        class="cal-day-btn ${isSelected ? 'is-selected' : ''}"
        data-pick-date="${dateStr}"
        ${isDisabled ? 'disabled aria-disabled="true"' : ''}
        aria-label="${day} ${MONTH_NAMES_GENITIVE[month]} ${year}${note ? ', ' + note : ''}"
      >
        <span class="cal-day-num tabular-nums">${day}</span>
        ${note ? `<span class="cal-day-note">${escapeHtml(note)}</span>` : ''}
      </button>
    `);
  }

  grid.innerHTML = cells.join('');

  grid.querySelectorAll('[data-pick-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      selectDateInWizard(btn.getAttribute('data-pick-date'));
    });
  });
}

async function selectDateInWizard(dateStr) {
  if (!dateStr) return;
  if (state.selectedDate !== dateStr) {
    state.selectedSlot = null;
    releaseActiveHoldSilently();
  }
  state.selectedDate = dateStr;
  renderWizardStep3Calendar();
  goToStep(4);
  await loadAvailableSlotsForStep4();
}

async function loadAvailableSlotsForStep4() {
  const container = document.getElementById('slots-container');
  const subtitle = document.getElementById('step-4-date-subtitle');
  if (!container) return;

  if (!state.selectedServiceId || !state.selectedMasterId || !state.selectedDate) {
    container.innerHTML = `<div class="loading-skeleton">Выберите услугу, мастера и дату.</div>`;
    return;
  }

  if (subtitle) {
    subtitle.textContent = `Доступные интервалы на ${formatHumanDate(state.selectedDate)} (время московское):`;
  }

  container.innerHTML = `<div class="loading-skeleton">Загрузка актуальных свободных интервалов...</div>`;

  try {
    const query = new URLSearchParams({
      serviceId: state.selectedServiceId,
      masterId: state.selectedMasterId,
      date: state.selectedDate,
      holdToken: state.holdToken,
    });

    const data = await apiRequest(`/api/availability?${query.toString()}`, {
      method: 'GET',
    });

    if (!data.isWorkingDay || !data.slots || data.slots.length === 0) {
      container.innerHTML = `
        <div class="loading-skeleton">
          ${escapeHtml(data.dayOffReason || 'В выбранный день нет доступных интервалов. Пожалуйста, выберите другую дату.')}
        </div>
      `;
      return;
    }

    const reasonLabels = {
      available: 'Свободно',
      booked: 'Занято',
      held: 'Бронируется',
      break: 'Перерыв',
      past_or_too_soon: 'Прошло',
      outside_working_hours: 'Нерабочее время',
      day_off: 'Выходной',
    };

    container.innerHTML = data.slots
      .map((slot) => {
        const isSelected =
          state.selectedSlot && state.selectedSlot.time === slot.time;
        const statusText = slot.available
          ? `${slot.time}–${slot.endTime}`
          : reasonLabels[slot.reason] || 'Недоступно';

        return `
          <button
            type="button"
            class="slot-btn ${isSelected ? 'is-selected' : ''}"
            data-slot-time="${escapeHtml(slot.time)}"
            data-slot-end="${escapeHtml(slot.endTime)}"
            data-suggested-master-id="${escapeHtml(slot.suggestedMaster?.id || '')}"
            data-suggested-master-name="${escapeHtml(slot.suggestedMaster?.name || '')}"
            ${!slot.available ? 'disabled aria-disabled="true"' : ''}
          >
            <span class="slot-time-main tabular-nums">${escapeHtml(slot.time)}</span>
            <span class="slot-status-sub tabular-nums">${escapeHtml(statusText)}</span>
          </button>
        `;
      })
      .join('');

    container.querySelectorAll('[data-slot-time]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const time = btn.getAttribute('data-slot-time');
        const endTime = btn.getAttribute('data-slot-end');
        const suggestedMasterId = btn.getAttribute('data-suggested-master-id');
        const suggestedMasterName = btn.getAttribute('data-suggested-master-name');

        selectTimeSlotAndHold({
          time,
          endTime,
          suggestedMaster: suggestedMasterId
            ? { id: suggestedMasterId, name: suggestedMasterName }
            : null,
        });
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="loading-skeleton">${escapeHtml(err.message || 'Ошибка загрузки интервалов.')}</div>`;
  }
}

async function selectTimeSlotAndHold(slotObj) {
  showFormAlert('');
  try {
    const holdRes = await apiRequest('/api/holds', {
      method: 'POST',
      body: JSON.stringify({
        serviceId: state.selectedServiceId,
        masterId: state.selectedMasterId,
        date: state.selectedDate,
        time: slotObj.time,
        holdToken: state.holdToken,
      }),
    });

    state.selectedSlot = {
      time: slotObj.time,
      endTime: holdRes.hold.endTime || slotObj.endTime,
      heldMasterId: holdRes.hold.masterId,
      heldMasterName: holdRes.hold.masterName,
    };
    state.holdExpiresAt = holdRes.hold.expiresAt * 1000;
    state.activeIdempotencyKey = generateRandomToken('booking');

    startHoldCountdownTimer();
    goToStep(5);
  } catch (err) {
    showFormAlert(
      err.message ||
        'Это время уже занято. Пожалуйста, выберите другое.'
    );
    await loadAvailableSlotsForStep4();
  }
}

function startHoldCountdownTimer() {
  if (state.holdIntervalId) {
    clearInterval(state.holdIntervalId);
    state.holdIntervalId = null;
  }

  const banner = document.getElementById('hold-timer-banner');
  const countdownEl = document.getElementById('hold-timer-countdown');
  if (!banner || !countdownEl || !state.holdExpiresAt) return;

  banner.hidden = false;

  const updateTick = () => {
    const remainingSec = Math.max(
      0,
      Math.floor((state.holdExpiresAt - Date.now()) / 1000)
    );
    const mins = String(Math.floor(remainingSec / 60)).padStart(2, '0');
    const secs = String(remainingSec % 60).padStart(2, '0');
    countdownEl.textContent = `${mins}:${secs}`;

    if (remainingSec <= 0) {
      clearInterval(state.holdIntervalId);
      state.holdIntervalId = null;
      if (state.currentStep === 5) {
        banner.hidden = true;
        showFormAlert(
          'Время временного удержания слота истекло. При подтверждении записи доступность времени будет проверена повторно.'
        );
      }
    }
  };

  updateTick();
  state.holdIntervalId = setInterval(updateTick, 1000);
}

function releaseActiveHoldSilently() {
  if (state.holdIntervalId) {
    clearInterval(state.holdIntervalId);
    state.holdIntervalId = null;
  }
  state.holdExpiresAt = null;
  const banner = document.getElementById('hold-timer-banner');
  if (banner) banner.hidden = true;

  if (state.holdToken) {
    fetch(`${API_BASE_URL}/api/holds?holdToken=${encodeURIComponent(state.holdToken)}`, {
      method: 'DELETE',
    }).catch(() => {});
  }
}

function updateBookingSummary() {
  const srv = state.services.find((s) => s.id === state.selectedServiceId);
  const mst =
    state.selectedMasterId && state.selectedMasterId !== 'any'
      ? state.masters.find((m) => m.id === state.selectedMasterId)
      : null;

  const sumService = document.getElementById('sum-service');
  const sumMaster = document.getElementById('sum-master');
  const sumDate = document.getElementById('sum-date');
  const sumTime = document.getElementById('sum-time');
  const sumDuration = document.getElementById('sum-duration');
  const sumClient = document.getElementById('sum-client');
  const sumPrice = document.getElementById('sum-price');

  if (sumService) sumService.textContent = srv ? srv.title : 'Не выбрана';

  if (sumMaster) {
    if (state.selectedMasterId === 'any') {
      sumMaster.textContent = state.selectedSlot?.heldMasterName
        ? `Любой свободный (${state.selectedSlot.heldMasterName})`
        : 'Любой свободный мастер';
    } else if (mst) {
      sumMaster.textContent = mst.name;
    } else {
      sumMaster.textContent = 'Не выбран';
    }
  }

  if (sumDate) {
    sumDate.textContent = state.selectedDate
      ? formatHumanDate(state.selectedDate)
      : 'Не выбрана';
  }

  if (sumTime) {
    sumTime.textContent = state.selectedSlot
      ? `${state.selectedSlot.time} – ${state.selectedSlot.endTime}`
      : 'Не выбрано';
  }

  if (sumDuration) {
    sumDuration.textContent = srv ? `${srv.durationMinutes} мин.` : '—';
  }

  const nameInput = document.getElementById('client-name-input');
  const lastNameInput = document.getElementById('client-lastname-input');
  const phoneInput = document.getElementById('client-phone-input');
  if (sumClient) {
    const firstVal = nameInput ? nameInput.value.trim() : '';
    const lastVal = lastNameInput ? lastNameInput.value.trim() : '';
    const fullName = [firstVal, lastVal].filter(Boolean).join(' ');
    const phoneVal = phoneInput ? phoneInput.value.trim() : '';
    sumClient.textContent =
      fullName || phoneVal
        ? `${fullName || 'Имя не указано'}${phoneVal ? ', ' + phoneVal : ''}`
        : '—';
  }

  if (sumPrice) {
    sumPrice.textContent = srv ? formatPriceRub(srv.priceRub) : '—';
  }
}

async function handleClientFormSubmit(event) {
  event.preventDefault();
  if (state.isSubmitting) return;

  const nameInput = document.getElementById('client-name-input');
  const lastNameInput = document.getElementById('client-lastname-input');
  const phoneInput = document.getElementById('client-phone-input');
  const commentInput = document.getElementById('client-comment-input');
  const consentCheckbox = document.getElementById('client-consent-checkbox');
  const submitBtn = document.getElementById('submit-booking-btn');

  const nameErr = document.getElementById('client-name-error');
  const phoneErr = document.getElementById('client-phone-error');
  const consentErr = document.getElementById('client-consent-error');

  if (nameErr) nameErr.hidden = true;
  if (phoneErr) phoneErr.hidden = true;
  if (consentErr) consentErr.hidden = true;
  showFormAlert('');

  const clientFirstName = (nameInput?.value || '').trim();
  const clientLastName = (lastNameInput?.value || '').trim();
  const clientPhone = (phoneInput?.value || '').trim();
  const clientComment = (commentInput?.value || '').trim();
  const consentAccepted = Boolean(consentCheckbox?.checked);

  let hasValidationErrors = false;
  if (clientFirstName.length < 2) {
    if (nameErr) {
      nameErr.textContent = 'Пожалуйста, укажите ваше имя (минимум 2 символа).';
      nameErr.hidden = false;
    }
    hasValidationErrors = true;
  }

  const phoneDigits = clientPhone.replace(/\D/g, '');
  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    if (phoneErr) {
      phoneErr.textContent = 'Введите корректный 10- или 11-значный номер телефона.';
      phoneErr.hidden = false;
    }
    hasValidationErrors = true;
  }

  if (!consentAccepted) {
    if (consentErr) {
      consentErr.textContent = 'Необходимо согласие на обработку персональных данных.';
      consentErr.hidden = false;
    }
    hasValidationErrors = true;
  }

  if (hasValidationErrors) return;

  if (!state.activeIdempotencyKey) {
    state.activeIdempotencyKey = generateRandomToken('booking');
  }

  state.isSubmitting = true;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохранение записи...';
  }

  try {
    const response = await apiRequest('/api/bookings', {
      method: 'POST',
      headers: {
        'X-Idempotency-Key': state.activeIdempotencyKey,
      },
      body: JSON.stringify({
        idempotencyKey: state.activeIdempotencyKey,
        serviceId: state.selectedServiceId,
        masterId: state.selectedMasterId,
        date: state.selectedDate,
        time: state.selectedSlot?.time,
        clientName: clientFirstName,
        clientLastName,
        clientPhone,
        clientComment,
        consentAccepted: true,
        holdToken: state.holdToken,
      }),
    });

    if (state.holdIntervalId) {
      clearInterval(state.holdIntervalId);
      state.holdIntervalId = null;
    }

    state.confirmedBooking = response.booking;
    renderStep6Confirmation(response.booking);
    goToStep(6);
  } catch (err) {
    if (err.status === 409) {
      state.selectedSlot = null;
      goToStep(4);
      showFormAlert(
        err.message ||
          'Это время уже занято. Пожалуйста, выберите другое'
      );
      await loadAvailableSlotsForStep4();
    } else {
      showFormAlert(
        err.message ||
          'Не удалось отправить запись. Проверьте соединение с интернетом и попробуйте снова.'
      );
    }
  } finally {
    state.isSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Подтвердить запись';
    }
  }
}

function renderStep6Confirmation(booking) {
  const card = document.getElementById('confirmation-card');
  if (!card || !booking) return;

  card.innerHTML = `
    <span class="confirmation-badge">Запись подтверждена</span>
    <h3 class="step-pane-title">Ждём вас в LÉA STUDIO, ${escapeHtml(booking.clientName)}!</h3>
    <p class="step-pane-subtitle">
      Выбранное время атомарно закреплено за вами в расписании специалиста.
    </p>

    <div class="confirmation-number-box">
      <div>
        <div class="field-hint">Номер бронирования</div>
        <div class="confirmation-code tabular-nums">${escapeHtml(booking.id)}</div>
      </div>
      <div class="field-hint">Запись сохранена в базе салона</div>
    </div>

    <dl class="summary-list">
      <div class="summary-row">
        <dt>Услуга</dt>
        <dd>${escapeHtml(booking.serviceTitle)}</dd>
      </div>
      <div class="summary-row">
        <dt>Мастер</dt>
        <dd>${escapeHtml(booking.masterName)}</dd>
      </div>
      <div class="summary-row">
        <dt>Дата и время</dt>
        <dd class="tabular-nums">${escapeHtml(formatHumanDate(booking.date))}, ${escapeHtml(booking.startTime)}–${escapeHtml(booking.endTime)}</dd>
      </div>
      <div class="summary-row">
        <dt>Длительность</dt>
        <dd class="tabular-nums">${booking.durationMinutes} мин.</dd>
      </div>
      <div class="summary-row">
        <dt>Клиент</dt>
        <dd>${escapeHtml(booking.clientName)} (${escapeHtml(booking.clientPhone)})</dd>
      </div>
      ${
        booking.clientComment
          ? `<div class="summary-row"><dt>Комментарий</dt><dd>${escapeHtml(booking.clientComment)}</dd></div>`
          : ''
      }
      <div class="summary-row summary-row-total">
        <dt>Стоимость</dt>
        <dd class="tabular-nums">${formatPriceRub(booking.priceRub)}</dd>
      </div>
    </dl>

    <div class="step-nav-footer">
      <button type="button" class="btn btn-secondary" id="new-booking-btn">
        Оформить ещё одну запись
      </button>
    </div>
  `;

  const newBtn = document.getElementById('new-booking-btn');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      state.selectedSlot = null;
      state.activeIdempotencyKey = null;
      state.confirmedBooking = null;
      goToStep(1);
    });
  }
}

// ============================================================================
// ОКНО АВТОРИЗАЦИИ И ИНТЕГРИРОВАННАЯ ПАНЕЛЬ АДМИНИСТРАТОРА
// ============================================================================

function showInlineAdminAlert(message, isError = false) {
  const el = document.getElementById('inline-admin-alert');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('is-success');
    return;
  }
  el.textContent = message;
  el.classList.toggle('is-success', !isError);
  el.hidden = false;
}

async function handleFooterAdminButtonClick() {
  // Проверяем, есть ли уже активная серверная сессия
  try {
    const sess = await apiRequest('/api/admin/session', { method: 'GET' });
    if (sess && sess.authenticated) {
      adminState.authenticated = true;
      adminState.csrfToken = sess.csrfToken || adminState.csrfToken;
      adminState.login = sess.login || 'admin';
      openInlineAdminWorkspace();
      return;
    }
  } catch {
    // Сессия не активна — открываем окно входа
  }

  const loginModal = document.getElementById('admin-login-modal');
  const errEl = document.getElementById('main-admin-login-error');
  const loginInput = document.getElementById('main-admin-login-input');
  const passInput = document.getElementById('main-admin-password-input');

  if (errEl) errEl.hidden = true;
  if (passInput) passInput.value = '';
  if (loginModal) {
    loginModal.hidden = false;
    setTimeout(() => {
      if (loginInput) loginInput.focus();
    }, 50);
  }
}

async function handleMainAdminLoginSubmit(event) {
  event.preventDefault();
  const loginInput = document.getElementById('main-admin-login-input');
  const passInput = document.getElementById('main-admin-password-input');
  const errEl = document.getElementById('main-admin-login-error');
  const submitBtn = document.getElementById('main-admin-login-submit');
  const spinner = document.getElementById('main-admin-login-spinner');
  const submitText = document.getElementById('main-admin-login-submit-text');

  const login = (loginInput?.value || '').trim();
  const password = passInput?.value || '';

  if (errEl) errEl.hidden = true;

  if (!login || !password) {
    if (errEl) {
      errEl.textContent = 'Пожалуйста, введите логин и пароль администратора.';
      errEl.hidden = false;
    }
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (spinner) spinner.hidden = false;
  if (submitText) submitText.textContent = 'Проверка...';

  try {
    const res = await apiRequest('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ login, password }),
    });

    adminState.authenticated = true;
    adminState.csrfToken = res.csrfToken || '';
    adminState.login = res.login || login;

    if (passInput) passInput.value = '';
    const loginModal = document.getElementById('admin-login-modal');
    if (loginModal) loginModal.hidden = true;

    openInlineAdminWorkspace();
  } catch (err) {
    if (errEl) {
      errEl.textContent =
        err.status === 401
          ? 'Неверный логин или пароль. Проверьте введённые учётные данные.'
          : err.message || 'Ошибка проверки учётных данных на сервере.';
      errEl.hidden = false;
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (spinner) spinner.hidden = true;
    if (submitText) submitText.textContent = 'Войти';
  }
}

function openInlineAdminWorkspace() {
  const publicWrapper = document.getElementById('public-site-wrapper');
  const adminPanel = document.getElementById('inline-admin-panel');

  if (publicWrapper) publicWrapper.hidden = true;
  if (adminPanel) adminPanel.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  loadInlineAdminData();

  if (adminState.pollTimerId) {
    clearInterval(adminState.pollTimerId);
  }
  adminState.pollTimerId = setInterval(() => {
    const panel = document.getElementById('inline-admin-panel');
    if (panel && !panel.hidden && adminState.authenticated) {
      loadInlineAdminData(true);
    }
  }, 15000);
}

function closeInlineAdminWorkspace() {
  if (adminState.pollTimerId) {
    clearInterval(adminState.pollTimerId);
    adminState.pollTimerId = null;
  }

  const publicWrapper = document.getElementById('public-site-wrapper');
  const adminPanel = document.getElementById('inline-admin-panel');

  if (adminPanel) adminPanel.hidden = true;
  if (publicWrapper) publicWrapper.hidden = false;
}

async function handleInlineAdminLogout() {
  try {
    await apiRequest('/api/admin/logout', { method: 'POST', body: JSON.stringify({}) });
  } catch {
    // Игнорируем сетевую ошибку при выходе
  }
  adminState.authenticated = false;
  adminState.csrfToken = '';
  closeInlineAdminWorkspace();
}

async function loadInlineAdminData(silent = false) {
  const container = document.getElementById('inline-admin-bookings-container');
  const syncLabel = document.getElementById('inline-admin-sync-status');

  if (!silent && container && adminState.bookings.length === 0) {
    container.innerHTML = `<div class="loading-skeleton">Загрузка реальных записей из базы данных...</div>`;
  }

  try {
    const data = await apiRequest('/api/admin/overview', { method: 'GET' });
    adminState.serverToday = data.serverToday || '2026-10-29';
    adminState.bookings = data.bookings || [];
    adminState.masters = data.masters || state.masters || [];
    adminState.services = data.services || state.services || [];

    if (syncLabel) {
      const nowTime = new Date().toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      syncLabel.textContent = `База данных D1 синхронизирована · Обновлено в ${nowTime}`;
    }

    populateInlineAdminMasterFilter();
    renderInlineAdminKpis();
    renderInlineAdminBookings();
  } catch (err) {
    if (err.status === 401) {
      adminState.authenticated = false;
      closeInlineAdminWorkspace();
      handleFooterAdminButtonClick();
      return;
    }
    if (!silent) {
      showInlineAdminAlert(err.message || 'Не удалось загрузить список записей.', true);
    }
  }
}

function populateInlineAdminMasterFilter() {
  const sel = document.getElementById('inline-admin-filter-master');
  if (!sel) return;
  const currentVal = adminState.filterMasterId || 'all';
  const options = [`<option value="all">Все мастера</option>`];
  for (const m of adminState.masters) {
    options.push(
      `<option value="${escapeHtml(m.id)}" ${currentVal === m.id ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
    );
  }
  sel.innerHTML = options.join('');
}

function renderInlineAdminKpis() {
  const todayStr = adminState.serverToday || '2026-10-29';
  const all = adminState.bookings || [];

  const todayCount = all.filter(
    (b) => b.date === todayStr && b.status !== 'cancelled'
  ).length;
  const upcomingCount = all.filter(
    (b) => b.date >= todayStr && (b.status === 'confirmed' || b.status === 'pending')
  ).length;
  const confirmedCount = all.filter((b) => b.status === 'confirmed').length;
  const cancelledCount = all.filter((b) => b.status === 'cancelled').length;

  const elToday = document.getElementById('inline-kpi-today');
  const elTodayDate = document.getElementById('inline-kpi-today-date');
  const elUpcoming = document.getElementById('inline-kpi-upcoming');
  const elConfirmed = document.getElementById('inline-kpi-confirmed');
  const elCancelled = document.getElementById('inline-kpi-cancelled');

  if (elToday) elToday.textContent = String(todayCount);
  if (elTodayDate) elTodayDate.textContent = formatHumanDate(todayStr);
  if (elUpcoming) elUpcoming.textContent = String(upcomingCount);
  if (elConfirmed) elConfirmed.textContent = String(confirmedCount);
  if (elCancelled) elCancelled.textContent = String(cancelledCount);
}

function getStatusBadgeHtml(status) {
  const map = {
    pending: { label: 'Ожидает', cls: 'status-pending' },
    confirmed: { label: 'Подтверждена', cls: 'status-confirmed' },
    completed: { label: 'Завершена', cls: 'status-completed' },
    cancelled: { label: 'Отменена', cls: 'status-cancelled' },
  };
  const info = map[status] || { label: status || 'Неизвестно', cls: 'status-pending' };
  return `<span class="booking-status-text ${info.cls}">${escapeHtml(info.label)}</span>`;
}

function renderInlineAdminBookings() {
  const container = document.getElementById('inline-admin-bookings-container');
  if (!container) return;

  const searchLower = (adminState.filterSearch || '').trim().toLowerCase();
  const filtered = (adminState.bookings || []).filter((b) => {
    if (adminState.filterDate && b.date !== adminState.filterDate) return false;
    if (adminState.filterStatus !== 'all' && b.status !== adminState.filterStatus) return false;
    if (adminState.filterMasterId !== 'all' && b.masterId !== adminState.filterMasterId) return false;
    if (searchLower) {
      const hay = `${b.clientName || ''} ${b.clientFirstName || ''} ${b.clientLastName || ''} ${b.clientPhone || ''} ${b.id || ''}`.toLowerCase();
      if (!hay.includes(searchLower)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="admin-empty-state">
        <h3 class="admin-empty-title">Записи по выбранным фильтрам не найдены</h3>
        <p class="admin-empty-desc">Попробуйте сбросить фильтры или создайте новую запись через форму на сайте.</p>
      </div>
    `;
    return;
  }

  const rowsHtml = filtered
    .map((b) => {
      const canConfirm = b.status === 'pending';
      const canCancel = b.status !== 'cancelled';
      const canReschedule = b.status !== 'cancelled';

      return `
        <tr>
          <td>
            <div class="admin-cell-main">${escapeHtml(b.clientName)}</div>
            <div class="admin-cell-sub tabular-nums">${escapeHtml(b.clientPhone)}</div>
            ${b.clientComment ? `<div class="admin-cell-comment">«${escapeHtml(b.clientComment)}»</div>` : ''}
          </td>
          <td>
            <div class="admin-cell-main">${escapeHtml(b.serviceTitle)}</div>
            <div class="admin-cell-sub tabular-nums">${formatPriceRub(b.priceRub)} · ${b.durationMinutes} мин.</div>
          </td>
          <td>
            <div class="admin-cell-main">${escapeHtml(b.masterName)}</div>
          </td>
          <td class="tabular-nums">
            <div class="admin-cell-main">${escapeHtml(formatHumanDate(b.date))}</div>
            <div class="admin-cell-sub">${escapeHtml(b.startTime)} – ${escapeHtml(b.endTime)}</div>
          </td>
          <td>
            ${getStatusBadgeHtml(b.status)}
          </td>
          <td>
            <div class="admin-row-actions">
              ${
                canConfirm
                  ? `<button type="button" class="btn btn-primary btn-xs" data-inline-confirm="${escapeHtml(b.id)}">Подтвердить</button>`
                  : ''
              }
              ${
                canReschedule
                  ? `<button type="button" class="btn btn-secondary btn-xs" data-inline-reschedule="${escapeHtml(b.id)}">Перенести</button>`
                  : ''
              }
              ${
                canCancel
                  ? `<button type="button" class="btn btn-outline-danger btn-xs" data-inline-cancel="${escapeHtml(b.id)}">Отменить</button>`
                  : '<span class="admin-cell-sub">Слот свободен</span>'
              }
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  const mobileCardsHtml = filtered
    .map((b) => {
      const canConfirm = b.status === 'pending';
      const canCancel = b.status !== 'cancelled';
      const canReschedule = b.status !== 'cancelled';

      return `
        <article class="admin-mobile-booking-card">
          <div class="admin-mobile-card-top">
            <div>
              <h3 class="admin-cell-main">${escapeHtml(b.clientName)}</h3>
              <p class="admin-cell-sub tabular-nums">${escapeHtml(b.clientPhone)}</p>
            </div>
            ${getStatusBadgeHtml(b.status)}
          </div>
          <dl class="admin-mobile-dl">
            <div>
              <dt>Услуга</dt>
              <dd>${escapeHtml(b.serviceTitle)} (${formatPriceRub(b.priceRub)})</dd>
            </div>
            <div>
              <dt>Мастер</dt>
              <dd>${escapeHtml(b.masterName)}</dd>
            </div>
            <div>
              <dt>Дата и время</dt>
              <dd class="tabular-nums">${escapeHtml(formatHumanDate(b.date))}, ${escapeHtml(b.startTime)}–${escapeHtml(b.endTime)}</dd>
            </div>
          </dl>
          ${b.clientComment ? `<p class="admin-cell-comment">Комментарий: «${escapeHtml(b.clientComment)}»</p>` : ''}
          <div class="admin-mobile-card-actions">
            ${
              canConfirm
                ? `<button type="button" class="btn btn-primary btn-xs" data-inline-confirm="${escapeHtml(b.id)}">Подтвердить</button>`
                : ''
            }
            ${
              canReschedule
                ? `<button type="button" class="btn btn-secondary btn-xs" data-inline-reschedule="${escapeHtml(b.id)}">Перенести</button>`
                : ''
            }
            ${
              canCancel
                ? `<button type="button" class="btn btn-outline-danger btn-xs" data-inline-cancel="${escapeHtml(b.id)}">Отменить</button>`
                : ''
            }
          </div>
        </article>
      `;
    })
    .join('');

  container.innerHTML = `
    <div class="admin-desktop-table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Клиент и телефон</th>
            <th>Услуга</th>
            <th>Мастер</th>
            <th>Дата и время</th>
            <th>Статус</th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
    <div class="admin-mobile-cards-wrap">
      ${mobileCardsHtml}
    </div>
  `;

  container.querySelectorAll('[data-inline-confirm]').forEach((btn) => {
    btn.addEventListener('click', () =>
      handleInlineBookingConfirm(btn.getAttribute('data-inline-confirm'), btn)
    );
  });

  container.querySelectorAll('[data-inline-cancel]').forEach((btn) => {
    btn.addEventListener('click', () =>
      handleInlineBookingCancel(btn.getAttribute('data-inline-cancel'), btn)
    );
  });

  container.querySelectorAll('[data-inline-reschedule]').forEach((btn) => {
    btn.addEventListener('click', () =>
      openInlineRescheduleModal(btn.getAttribute('data-inline-reschedule'))
    );
  });
}

async function handleInlineBookingConfirm(bookingId, btn) {
  if (!bookingId) return;
  if (btn) btn.disabled = true;
  showInlineAdminAlert('');
  try {
    await apiRequest(`/api/admin/bookings/${encodeURIComponent(bookingId)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    showInlineAdminAlert('Запись успешно подтверждена.', false);
    await loadInlineAdminData(true);
  } catch (err) {
    showInlineAdminAlert(err.message || 'Ошибка подтверждения записи.', true);
    if (btn) btn.disabled = false;
  }
}

async function handleInlineBookingCancel(bookingId, btn) {
  if (!bookingId) return;
  if (btn) btn.disabled = true;
  showInlineAdminAlert('');
  try {
    await apiRequest(`/api/admin/bookings/${encodeURIComponent(bookingId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    showInlineAdminAlert('Запись отменена, временной интервал освобождён.', false);
    await loadInlineAdminData(true);
    if (state.currentStep === 4) {
      await loadAvailableSlotsForStep4();
    }
  } catch (err) {
    showInlineAdminAlert(err.message || 'Ошибка отмены записи.', true);
    if (btn) btn.disabled = false;
  }
}

async function openInlineRescheduleModal(bookingId) {
  const booking = (adminState.bookings || []).find((b) => b.id === bookingId);
  if (!booking) return;

  const modal = document.getElementById('inline-admin-reschedule-modal');
  const idInput = document.getElementById('inline-reschedule-booking-id');
  const srvInput = document.getElementById('inline-reschedule-service-id');
  const infoEl = document.getElementById('inline-reschedule-current-info');
  const masterSel = document.getElementById('inline-reschedule-master');
  const dateInput = document.getElementById('inline-reschedule-date');
  const errEl = document.getElementById('inline-reschedule-error');

  if (errEl) errEl.hidden = true;
  if (idInput) idInput.value = booking.id;
  if (srvInput) srvInput.value = booking.serviceId;
  if (infoEl) {
    infoEl.textContent = `${booking.clientName} · ${booking.serviceTitle} (${booking.durationMinutes} мин.). Текущее время: ${formatHumanDate(booking.date)}, ${booking.startTime}–${booking.endTime}.`;
  }

  // Заполняем список подходящих мастеров
  const eligibleMasters = (state.masters || []).filter(
    (m) => !m.serviceIds || m.serviceIds.length === 0 || m.serviceIds.includes(booking.serviceId)
  );
  const mastersList = eligibleMasters.length > 0 ? eligibleMasters : adminState.masters;

  if (masterSel) {
    masterSel.innerHTML = mastersList
      .map(
        (m) =>
          `<option value="${escapeHtml(m.id)}" ${m.id === booking.masterId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
      )
      .join('');
  }

  if (dateInput) {
    dateInput.min = adminState.serverToday || '2026-10-29';
    dateInput.value = booking.date;
  }

  if (modal) modal.hidden = false;
  await loadInlineRescheduleFreeSlots();
}

async function loadInlineRescheduleFreeSlots() {
  const srvInput = document.getElementById('inline-reschedule-service-id');
  const masterSel = document.getElementById('inline-reschedule-master');
  const dateInput = document.getElementById('inline-reschedule-date');
  const timeSel = document.getElementById('inline-reschedule-time');
  if (!timeSel) return;

  const serviceId = srvInput?.value || '';
  const masterId = masterSel?.value || '';
  const date = dateInput?.value || '';

  if (!serviceId || !masterId || !date) {
    timeSel.innerHTML = `<option value="">Выберите мастера и дату...</option>`;
    return;
  }

  timeSel.innerHTML = `<option value="">Загрузка свободных интервалов...</option>`;

  try {
    const q = new URLSearchParams({ serviceId, masterId, date });
    const data = await apiRequest(`/api/availability?${q.toString()}`, { method: 'GET' });
    const freeSlots = (data.slots || []).filter((s) => s.available);

    if (freeSlots.length === 0) {
      timeSel.innerHTML = `<option value="">Нет свободных слотов на выбранную дату</option>`;
      return;
    }

    timeSel.innerHTML = freeSlots
      .map(
        (s) =>
          `<option value="${escapeHtml(s.time)}">${escapeHtml(s.time)} – ${escapeHtml(s.endTime)}</option>`
      )
      .join('');
  } catch (err) {
    timeSel.innerHTML = `<option value="">${escapeHtml(err.message || 'Ошибка загрузки слотов')}</option>`;
  }
}

async function handleInlineRescheduleSubmit(event) {
  event.preventDefault();
  const idInput = document.getElementById('inline-reschedule-booking-id');
  const masterSel = document.getElementById('inline-reschedule-master');
  const dateInput = document.getElementById('inline-reschedule-date');
  const timeSel = document.getElementById('inline-reschedule-time');
  const errEl = document.getElementById('inline-reschedule-error');
  const submitBtn = document.getElementById('inline-reschedule-submit');

  const bookingId = idInput?.value || '';
  const masterId = masterSel?.value || '';
  const date = dateInput?.value || '';
  const time = timeSel?.value || '';

  if (errEl) errEl.hidden = true;
  if (!bookingId || !masterId || !date || !time) {
    if (errEl) {
      errEl.textContent = 'Пожалуйста, выберите специалиста, дату и доступное время.';
      errEl.hidden = false;
    }
    return;
  }

  if (submitBtn) submitBtn.disabled = true;

  try {
    await apiRequest(`/api/admin/bookings/${encodeURIComponent(bookingId)}/reschedule`, {
      method: 'POST',
      body: JSON.stringify({ masterId, date, time }),
    });

    const modal = document.getElementById('inline-admin-reschedule-modal');
    if (modal) modal.hidden = true;
    showInlineAdminAlert(`Запись успешно перенесена на ${formatHumanDate(date)} в ${time}.`, false);
    await loadInlineAdminData(true);
    if (state.currentStep === 4) {
      await loadAvailableSlotsForStep4();
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || 'Не удалось перенести запись на выбранное время.';
      errEl.hidden = false;
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ============================================================================
// ИНИЦИАЛИЗАЦИЯ СОБЫТИЙ ИНТЕРФЕЙСА
// ============================================================================

function initUiListeners() {
  const mobileToggle = document.getElementById('mobile-menu-toggle');
  const mobileDrawer = document.getElementById('mobile-nav-drawer');

  if (mobileToggle && mobileDrawer) {
    mobileToggle.addEventListener('click', () => {
      const isExpanded = mobileToggle.getAttribute('aria-expanded') === 'true';
      mobileToggle.setAttribute('aria-expanded', String(!isExpanded));
      mobileDrawer.hidden = isExpanded;
    });

    mobileDrawer.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => {
        mobileToggle.setAttribute('aria-expanded', 'false');
        mobileDrawer.hidden = true;
      });
    });
  }

  const retryBtn = document.getElementById('retry-catalog-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => loadCatalog());
  }

  document.querySelectorAll('[data-goto-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const targetStep = Number(btn.getAttribute('data-goto-step'));
      if (targetStep >= 1 && targetStep < state.currentStep) {
        goToStep(targetStep);
      }
    });
  });

  document.querySelectorAll('[data-prev-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetStep = Number(btn.getAttribute('data-prev-step'));
      goToStep(targetStep);
    });
  });

  const calPrev = document.getElementById('cal-prev-month');
  const calNext = document.getElementById('cal-next-month');
  if (calPrev) {
    calPrev.addEventListener('click', () => {
      if (state.calendarMonth === 0) {
        state.calendarYear -= 1;
        state.calendarMonth = 11;
      } else {
        state.calendarMonth -= 1;
      }
      renderWizardStep3Calendar();
    });
  }
  if (calNext) {
    calNext.addEventListener('click', () => {
      if (state.calendarMonth === 11) {
        state.calendarYear += 1;
        state.calendarMonth = 0;
      } else {
        state.calendarMonth += 1;
      }
      renderWizardStep3Calendar();
    });
  }

  const refreshSlotsBtn = document.getElementById('refresh-slots-btn');
  if (refreshSlotsBtn) {
    refreshSlotsBtn.addEventListener('click', () => loadAvailableSlotsForStep4());
  }

  const nameInput = document.getElementById('client-name-input');
  const lastNameInput = document.getElementById('client-lastname-input');
  const phoneInput = document.getElementById('client-phone-input');
  if (nameInput) nameInput.addEventListener('input', () => updateBookingSummary());
  if (lastNameInput) lastNameInput.addEventListener('input', () => updateBookingSummary());
  if (phoneInput) phoneInput.addEventListener('input', () => updateBookingSummary());

  const clientForm = document.getElementById('booking-client-form');
  if (clientForm) {
    clientForm.addEventListener('submit', handleClientFormSubmit);
  }

  // Модальные окна
  document.querySelectorAll('[data-open-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-open-modal');
      const modal = document.getElementById(modalId);
      if (modal) modal.hidden = false;
    });
  });

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-close-modal');
      const modal = document.getElementById(modalId);
      if (modal) modal.hidden = true;
    });
  });

  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        backdrop.hidden = true;
      }
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop').forEach((m) => {
        m.hidden = true;
      });
    }
  });

  // Кнопка «Вход для администратора» в подвале сайта
  const footerAdminBtn = document.getElementById('footer-admin-login-btn');
  if (footerAdminBtn) {
    footerAdminBtn.addEventListener('click', handleFooterAdminButtonClick);
  }

  const mainAdminLoginForm = document.getElementById('main-admin-login-form');
  if (mainAdminLoginForm) {
    mainAdminLoginForm.addEventListener('submit', handleMainAdminLoginSubmit);
  }

  const backToSiteBtn = document.getElementById('inline-admin-back-to-site');
  if (backToSiteBtn) {
    backToSiteBtn.addEventListener('click', closeInlineAdminWorkspace);
  }

  const logoutBtn = document.getElementById('inline-admin-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleInlineAdminLogout);
  }

  const refreshAdminBtn = document.getElementById('inline-admin-refresh-btn');
  if (refreshAdminBtn) {
    refreshAdminBtn.addEventListener('click', () => loadInlineAdminData(false));
  }

  // Фильтры панели администратора
  const fDate = document.getElementById('inline-admin-filter-date');
  const fStatus = document.getElementById('inline-admin-filter-status');
  const fMaster = document.getElementById('inline-admin-filter-master');
  const fSearch = document.getElementById('inline-admin-filter-search');
  const fReset = document.getElementById('inline-admin-filter-reset');

  if (fDate) {
    fDate.addEventListener('change', () => {
      adminState.filterDate = fDate.value || '';
      renderInlineAdminBookings();
    });
  }
  if (fStatus) {
    fStatus.addEventListener('change', () => {
      adminState.filterStatus = fStatus.value || 'all';
      renderInlineAdminBookings();
    });
  }
  if (fMaster) {
    fMaster.addEventListener('change', () => {
      adminState.filterMasterId = fMaster.value || 'all';
      renderInlineAdminBookings();
    });
  }
  if (fSearch) {
    fSearch.addEventListener('input', () => {
      adminState.filterSearch = fSearch.value || '';
      renderInlineAdminBookings();
    });
  }
  if (fReset) {
    fReset.addEventListener('click', () => {
      adminState.filterDate = '';
      adminState.filterStatus = 'all';
      adminState.filterMasterId = 'all';
      adminState.filterSearch = '';
      if (fDate) fDate.value = '';
      if (fStatus) fStatus.value = 'all';
      if (fMaster) fMaster.value = 'all';
      if (fSearch) fSearch.value = '';
      renderInlineAdminBookings();
    });
  }

  // События модального окна переноса записи
  const reschedMaster = document.getElementById('inline-reschedule-master');
  const reschedDate = document.getElementById('inline-reschedule-date');
  const reschedForm = document.getElementById('inline-admin-reschedule-form');

  if (reschedMaster) {
    reschedMaster.addEventListener('change', () => loadInlineRescheduleFreeSlots());
  }
  if (reschedDate) {
    reschedDate.addEventListener('change', () => loadInlineRescheduleFreeSlots());
  }
  if (reschedForm) {
    reschedForm.addEventListener('submit', handleInlineRescheduleSubmit);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initUiListeners();
  loadCatalog();
});
