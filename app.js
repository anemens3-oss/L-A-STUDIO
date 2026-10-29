/**
 * LÉA STUDIO — Клиентское приложение на чистом JavaScript (Vanilla ES Modules)
 * Без сторонних фреймворков и библиотек.
 */

// Настраиваемый базовый адрес серверного API:
// При размещении фронтенда отдельно на GitHub Pages укажите адрес вашего Cloudflare Worker
// через window.LEA_API_BASE_URL (или оставьте пустым для работы на едином домене).
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
  selectedMasterId: null, // конкретный ID мастера или 'any'
  preselectedMasterFilterId: null,
  selectedDate: null, // 'YYYY-MM-DD'
  selectedSlot: null, // { time, endTime, suggestedMaster }
  calendarYear: null,
  calendarMonth: null, // 0..11

  // Сессия временного удержания слота и идемпотентность
  holdToken: getOrCreateHoldToken(),
  holdExpiresAt: null,
  holdIntervalId: null,
  activeIdempotencyKey: null,
  isSubmitting: false,
  confirmedBooking: null,
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
 * Авторские векторные иллюстрации портретов мастеров в единой эстетике LÉA STUDIO
 * (исключают любые битые внешние ссылки и работают мгновенно офлайн/онлайн).
 */
function renderMasterPortraitSvg(portraitKey) {
  const palettes = {
    anna: { bg: '#F8E9E8', arch: '#EDE2D7', hair: '#5A443E', outfit: '#D8B7B5', accent: '#B87D88' },
    maria: { bg: '#EDE2D7', arch: '#F8E9E8', hair: '#3B2E2A', outfit: '#C9929C', accent: '#A36772' },
    elena: { bg: '#F4DCDC', arch: '#FFFCFA', hair: '#8A6B58', outfit: '#E5D5CB', accent: '#B87D88' },
    sofia: { bg: '#F8E9E8', arch: '#F4DCDC', hair: '#4B3935', outfit: '#D7C4B6', accent: '#B87D88' },
  };
  const p = palettes[portraitKey] || palettes.anna;

  return `
    <svg class="master-portrait-svg" viewBox="0 0 180 220" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="180" height="220" fill="${p.bg}" />
      <path d="M24 220V96C24 59.5492 53.5492 30 90 30C126.451 30 156 59.5492 156 96V220H24Z" fill="${p.arch}" />
      <!-- Причёска (задний план) -->
      <path d="M52 102C52 68 68 48 90 48C112 48 128 68 128 102C128 126 122 146 116 154H64C58 146 52 126 52 102Z" fill="${p.hair}" />
      <!-- Плечи и льняная форма -->
      <path d="M28 220C32 178 56 158 90 158C124 158 148 178 152 220H28Z" fill="${p.outfit}" />
      <path d="M74 158L90 186L106 158" fill="#FFFCFA" opacity="0.7" />
      <!-- Шея и лицо -->
      <rect x="80" y="130" width="20" height="34" rx="10" fill="#F5DFD5" />
      <ellipse cx="90" cy="102" rx="27" ry="34" fill="#F9E6DD" />
      <!-- Мягкие пряди волос спереди -->
      <path d="M63 96C65 74 78 62 94 64C108 66 116 78 117 96C110 84 100 76 86 76C74 76 67 84 63 96Z" fill="${p.hair}" />
      <!-- Черты лица в минималистичной технике -->
      <path d="M76 98C79 95 83 95 85 98" stroke="#403532" stroke-width="1.6" stroke-linecap="round" />
      <path d="M95 98C97 95 101 95 104 98" stroke="#403532" stroke-width="1.6" stroke-linecap="round" />
      <path d="M90 100V110C90 111.5 88.5 112.5 87 112.5" stroke="#B89B92" stroke-width="1.4" stroke-linecap="round" />
      <path d="M83 120C87 123 93 123 97 120" stroke="${p.accent}" stroke-width="1.8" stroke-linecap="round" />
      <!-- Лаконичная жемчужная серьга -->
      <circle cx="62" cy="112" r="2.8" fill="#FFFCFA" />
      <circle cx="118" cy="112" r="2.8" fill="#FFFCFA" />
    </svg>
  `;
}

async function apiRequest(path, options = {}) {
  const url = `${API_BASE_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
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

    // Установка стартового месяца календаря по серверной дате салона
    const todayParts = (state.salon.serverToday || '2026-10-29').split('-').map(Number);
    state.calendarYear = todayParts[0];
    state.calendarMonth = todayParts[1] - 1;

    renderContactsFromConfig();
    renderCatalogCategoryTabs();
    renderServicesCatalog();
    renderMastersCatalog();

    // Инициализация Шага 1 в форме онлайн-записи
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
  const demoBar = document.getElementById('demo-notice-bar');

  if (state.salon.addressPlaceholder) {
    if (addrEl) addrEl.textContent = state.salon.addressPlaceholder;
    if (footerAddrEl) footerAddrEl.textContent = state.salon.addressPlaceholder;
  }
  if (state.salon.phonePlaceholder) {
    if (phoneEl) phoneEl.textContent = state.salon.phonePlaceholder;
    if (footerPhoneEl) footerPhoneEl.textContent = state.salon.phonePlaceholder;
  }
  if (state.salon.workHoursLabel) {
    if (hoursEl) hoursEl.textContent = state.salon.workHoursLabel;
    if (footerHoursEl) footerHoursEl.textContent = state.salon.workHoursLabel;
  }
  if (demoBar) {
    demoBar.hidden = !state.salon.isDemoData;
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
      const catTitle = categoryMap[srv.categoryId] || 'Услуга';
      return `
        <article class="service-card">
          <div>
            <div class="service-meta-line">
              <span>${escapeHtml(catTitle)}</span>
              <span aria-hidden="true">·</span>
              <span class="tabular-nums">${srv.durationMinutes} мин.</span>
              ${srv.isDemo ? '<span aria-hidden="true">·</span><span>Демо-образец</span>' : ''}
            </div>
            <h3 class="service-card-title">${escapeHtml(srv.title)}</h3>
            <p class="service-card-desc">${escapeHtml(srv.description)}</p>
          </div>
          <div class="service-card-footer">
            <span class="service-price">${formatPriceRub(srv.priceRub)}</span>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              data-book-service="${escapeHtml(srv.id)}"
            >
              Выбрать услугу
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
              <span class="tabular-nums">Стаж ${mst.experienceYears} лет</span>
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
              class="btn btn-secondary btn-sm"
              data-book-master="${escapeHtml(mst.id)}"
            >
              Выбрать мастера
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
    `Выбран специалист ${master.name}. Показаны услуги, которые выполняет этот мастер.`
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
    ? `<button type="button" class="category-tab-btn" id="clear-premaster-btn">Показать услуги всех мастеров ✕</button>`
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
            <span class="option-price">${formatPriceRub(srv.priceRub)}</span>
            <span class="option-duration">${srv.durationMinutes} мин.</span>
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

  if (state.selectedMasterId && state.selectedMasterId !== 'any') {
    const mst = state.masters.find((m) => m.id === state.selectedMasterId);
    if (!mst || !mst.serviceIds.includes(serviceId)) {
      state.selectedMasterId = null;
    }
  }

  if (serviceChanged) {
    state.selectedSlot = null;
    releaseActiveHoldSilently();
  }

  renderWizardStep1();
  renderWizardStep2();

  if (advance) {
    goToStep(2);
  } else {
    updateBookingSummary();
  }
}

function renderWizardStep2() {
  const listWrap = document.getElementById('wizard-master-list');
  const hintEl = document.getElementById('step-2-service-hint');
  if (!listWrap) return;

  const srv = state.services.find((s) => s.id === state.selectedServiceId);
  if (!srv) {
    listWrap.innerHTML = '';
    return;
  }

  if (hintEl) {
    hintEl.textContent = `Услуга «${srv.title}» (${srv.durationMinutes} мин.) — выберите специалиста:`;
  }

  const eligibleMasters = state.masters.filter((m) =>
    m.serviceIds.includes(srv.id)
  );

  const anySelected = state.selectedMasterId === 'any';
  const anyOptionHtml = `
    <button
      type="button"
      role="radio"
      aria-checked="${anySelected}"
      class="wizard-option-card ${anySelected ? 'is-selected' : ''}"
      data-select-master="any"
    >
      <div class="option-main">
        <span class="option-title">Любой свободный мастер</span>
        <span class="option-sub">
          Сервер автоматически проверит расписание всех ${eligibleMasters.length} профильных специалистов и выберет доступного мастера
        </span>
      </div>
      <div class="option-right">
        <span class="option-price">Автоподбор</span>
        <span class="option-duration">${eligibleMasters.length} спец.</span>
      </div>
    </button>
  `;

  const mastersHtml = eligibleMasters
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
            <span class="option-price">Стаж ${mst.experienceYears} лет</span>
            <span class="option-duration">Выбрать →</span>
          </div>
        </button>
      `;
    })
    .join('');

  listWrap.innerHTML = anyOptionHtml + mastersHtml;

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
  renderWizardStep2();
  renderWizardStep3Calendar();

  if (advance) {
    goToStep(3);
  } else {
    updateBookingSummary();
  }
}

function isWeekdayWorkingForSelection(dayOfWeek) {
  const srv = state.services.find((s) => s.id === state.selectedServiceId);
  if (!srv || !state.selectedMasterId) return false;

  if (state.selectedMasterId === 'any') {
    const eligible = state.masters.filter((m) => m.serviceIds.includes(srv.id));
    return eligible.some(
      (m) => m.weeklySchedule && m.weeklySchedule[dayOfWeek]?.isWorking
    );
  }

  const mst = state.masters.find((m) => m.id === state.selectedMasterId);
  if (!mst || !mst.weeklySchedule) return false;
  return Boolean(mst.weeklySchedule[dayOfWeek]?.isWorking);
}

function renderWizardStep3Calendar() {
  const grid = document.getElementById('calendar-days-grid');
  const monthLabel = document.getElementById('cal-month-label');
  const quickRow = document.getElementById('calendar-quick-row');
  const prevBtn = document.getElementById('cal-prev-month');
  const nextBtn = document.getElementById('cal-next-month');

  if (!grid || !monthLabel || !state.salon) return;

  const serverTodayStr = state.salon.serverToday;
  const [todayY, todayM, todayD] = serverTodayStr.split('-').map(Number);
  const todayUtcMs = Date.UTC(todayY, todayM - 1, todayD);
  const horizonDays = Number(state.salon.bookingHorizonDays || 45);
  const maxUtcMs = todayUtcMs + horizonDays * 86400 * 1000;

  const year = state.calendarYear || todayY;
  const month = state.calendarMonth != null ? state.calendarMonth : todayM - 1;

  monthLabel.textContent = `${MONTH_NAMES_NOMINATIVE[month]} ${year}`;

  if (prevBtn) {
    prevBtn.disabled = year === todayY && month === todayM - 1;
  }
  const maxDateObj = new Date(maxUtcMs);
  if (nextBtn) {
    nextBtn.disabled =
      year > maxDateObj.getUTCFullYear() ||
      (year === maxDateObj.getUTCFullYear() && month >= maxDateObj.getUTCMonth());
  }

  if (quickRow) {
    const quickDates = [];
    for (let offset = 0; offset < 14 && quickDates.length < 4; offset++) {
      const dt = new Date(todayUtcMs + offset * 86400 * 1000);
      const dow = dt.getUTCDay();
      if (!isWeekdayWorkingForSelection(dow)) continue;
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const d = String(dt.getUTCDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${d}`;
      let label = `${dt.getUTCDate()} ${MONTH_NAMES_GENITIVE[dt.getUTCMonth()]} (${WEEKDAY_SHORT[dow]})`;
      if (offset === 0) label = `Сегодня, ${dt.getUTCDate()} ${MONTH_NAMES_GENITIVE[dt.getUTCMonth()]}`;
      if (offset === 1) label = `Завтра, ${dt.getUTCDate()} ${MONTH_NAMES_GENITIVE[dt.getUTCMonth()]}`;
      quickDates.push({ dateStr, label });
    }

    quickRow.innerHTML = quickDates
      .map(
        (q) => `
        <button
          type="button"
          class="btn ${state.selectedDate === q.dateStr ? 'btn-primary' : 'btn-secondary'} btn-sm"
          data-pick-date="${q.dateStr}"
        >
          ${escapeHtml(q.label)}
        </button>
      `
      )
      .join('');

    quickRow.querySelectorAll('[data-pick-date]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectDateInWizard(btn.getAttribute('data-pick-date'));
      });
    });
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
        <span class="cal-day-num">${day}</span>
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

  container.innerHTML = `<div class="loading-skeleton">Запрос актуальных свободных интервалов с сервера...</div>`;

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
            <span class="slot-time-main">${escapeHtml(slot.time)}</span>
            <span class="slot-status-sub">${escapeHtml(statusText)}</span>
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
        'Этот интервал только что был занят другим посетителем. Пожалуйста, выберите другое время.'
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
          'Время временного удержания слота истекло. При нажатии «Подтвердить запись» доступность времени будет проверена повторно.'
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
    submitBtn.textContent = 'Сохранение записи на сервере...';
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
      // Если слот был перехвачен или пересекается — возвращаем на шаг выбора времени, сохраняя заполненные контакты клиента
      state.selectedSlot = null;
      goToStep(4);
      showFormAlert(
        err.message ||
          'Выбранный интервал уже занят. Пожалуйста, выберите другое свободное время.'
      );
      await loadAvailableSlotsForStep4();
    } else {
      showFormAlert(
        err.message ||
          'Не удалось отправить запись. Проверьте соединение с интернетом и попробуйте снова (введённые данные сохранены).'
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

  const notifLabels = {
    sent: 'Уведомление администратору в Telegram доставлено',
    awaiting_configuration:
      'Запись сохранена в БД (ожидается подключение секретов TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID владельцем)',
    failed_retry_scheduled:
      'Запись надёжно сохранена в БД (уведомление в Telegram поставлено в очередь повторной отправки)',
    failed_permanent:
      'Запись надёжно сохранена в БД (требуется проверка настроек Telegram администратором)',
    pending: 'Запись сохранена в БД, уведомление обрабатывается',
  };

  const notifText =
    notifLabels[booking.notificationStatus] || 'Запись сохранена в базе данных';

  card.innerHTML = `
    <span class="confirmation-badge">Запись успешно подтверждена сервером</span>
    <h3 class="step-pane-title">Ждём вас в LÉA STUDIO, ${escapeHtml(booking.clientName)}!</h3>
    <p class="step-pane-subtitle">
      Временной интервал атомарно закреплён за вами в расписании мастера.
    </p>

    <div class="confirmation-number-box">
      <div>
        <div class="field-hint">Номер вашей записи</div>
        <div class="confirmation-code">${escapeHtml(booking.id)}</div>
      </div>
      <div class="field-hint">${escapeHtml(notifText)}</div>
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
        <dt>Продолжительность</dt>
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
// ЗАЩИЩЁННАЯ ПАНЕЛЬ АДМИНИСТРАТОРА И УПРАВЛЕНИЕ БРОНЯМИ / TELEGRAM BOT API
// ============================================================================

let adminSessionPassword = '';

async function loadAdminOverview() {
  const errBox = document.getElementById('admin-error-box');
  const contentBox = document.getElementById('admin-dashboard-content');
  const tgSummary = document.getElementById('admin-tg-status-summary');
  const tableWrap = document.getElementById('admin-bookings-table-wrap');

  if (errBox) errBox.hidden = true;

  try {
    const data = await apiRequest('/api/admin/overview', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${adminSessionPassword}`,
      },
    });

    if (contentBox) contentBox.hidden = false;

    if (tgSummary && data.telegramIntegration) {
      tgSummary.innerHTML = data.telegramIntegration.configured
        ? `<strong>Интеграция Telegram Bot API активна:</strong> секреты <code>TELEGRAM_BOT_TOKEN</code> и <code>TELEGRAM_CHAT_ID</code> настроены.`
        : `<strong>Статус Telegram Bot API:</strong> секреты <code>TELEGRAM_BOT_TOKEN</code> и <code>TELEGRAM_CHAT_ID</code> ещё не заданы в окружении сервера. Все новые записи сохраняются со статусом <code>awaiting_configuration</code> и готовы к отправке сразу после настройки.`;
    }

    if (tableWrap) {
      if (!data.bookings || data.bookings.length === 0) {
        tableWrap.innerHTML = `<p class="field-hint">В базе данных пока нет созданных записей.</p>`;
      } else {
        tableWrap.innerHTML = `
          <table class="admin-table">
            <thead>
              <tr>
                <th>Номер</th>
                <th>Дата и время</th>
                <th>Мастер</th>
                <th>Услуга</th>
                <th>Клиент</th>
                <th>Статус</th>
                <th>Telegram</th>
                <th>Действие</th>
              </tr>
            </thead>
            <tbody>
              ${data.bookings
                .map(
                  (b) => `
                <tr>
                  <td><strong>${escapeHtml(b.id)}</strong></td>
                  <td>${escapeHtml(b.date)}<br/>${escapeHtml(b.startTime)}–${escapeHtml(b.endTime)}</td>
                  <td>${escapeHtml(b.masterName)}</td>
                  <td>${escapeHtml(b.serviceTitle)} (${formatPriceRub(b.priceRub)})</td>
                  <td>${escapeHtml(b.clientName)}<br/>${escapeHtml(b.clientPhone)}</td>
                  <td>${b.status === 'confirmed' ? 'Подтверждена' : 'Отменена'}</td>
                  <td>
                    <code>${escapeHtml(b.telegramStatus || b.notificationStatus)}</code>
                    <div class="field-hint">Попыток: ${Number(b.telegramAttempts || 0)}</div>
                    ${
                      b.telegramLastError
                        ? `<div class="field-hint">${escapeHtml(b.telegramLastError)}</div>`
                        : ''
                    }
                  </td>
                  <td>
                    ${
                      b.status === 'confirmed'
                        ? `<button type="button" class="btn btn-secondary btn-sm" data-cancel-booking="${escapeHtml(b.id)}">Отменить и освободить слот</button>`
                        : 'Слот свободен'
                    }
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        `;

        tableWrap.querySelectorAll('[data-cancel-booking]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-cancel-booking');
            btn.disabled = true;
            try {
              await apiRequest(`/api/admin/bookings/${encodeURIComponent(id)}/cancel`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${adminSessionPassword}`,
                },
              });
              await loadAdminOverview();
              if (state.currentStep === 4) {
                await loadAvailableSlotsForStep4();
              }
            } catch (e) {
              if (errBox) {
                errBox.textContent = e.message || 'Ошибка отмены записи';
                errBox.hidden = false;
              }
            }
          });
        });
      }
    }
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message || 'Ошибка авторизации администратора.';
      errBox.hidden = false;
    }
  }
}

// ============================================================================
// ИНИЦИАЛИЦИЯ СОБЫТИЙ ИНТЕРФЕЙСА
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
  if (nameInput) {
    nameInput.addEventListener('input', () => updateBookingSummary());
  }
  if (lastNameInput) {
    lastNameInput.addEventListener('input', () => updateBookingSummary());
  }
  if (phoneInput) {
    phoneInput.addEventListener('input', () => updateBookingSummary());
  }

  const clientForm = document.getElementById('booking-client-form');
  if (clientForm) {
    clientForm.addEventListener('submit', handleClientFormSubmit);
  }

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

  const adminForm = document.getElementById('admin-login-form');
  if (adminForm) {
    adminForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pwdInput = document.getElementById('admin-password-input');
      adminSessionPassword = (pwdInput?.value || '').trim();
      await loadAdminOverview();
    });
  }

  const adminRefreshBtn = document.getElementById('admin-refresh-btn');
  if (adminRefreshBtn) {
    adminRefreshBtn.addEventListener('click', () => loadAdminOverview());
  }

  const adminRetryTgBtn = document.getElementById('admin-retry-tg-btn');
  if (adminRetryTgBtn) {
    adminRetryTgBtn.addEventListener('click', async () => {
      adminRetryTgBtn.disabled = true;
      try {
        await apiRequest('/api/admin/notifications/retry', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminSessionPassword}`,
          },
        });
        await loadAdminOverview();
      } finally {
        adminRetryTgBtn.disabled = false;
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initUiListeners();
  loadCatalog();
});
