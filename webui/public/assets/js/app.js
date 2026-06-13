(function () {
  const csrfToken = document.querySelector('meta[name="csrf"]').content;
  const PHC_GROUP_LETTERS = 'ABCDEFGH';
  let chart;

  async function fetchJSON(path, options) {
    const res = await fetch(path, options);
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  }

  function intervalLabel(n) {
    const seconds = Math.pow(2, n);
    const text = seconds >= 1 ? `${seconds} s` : `${Math.round(seconds * 1000)} ms`;
    return `${text} (${n})`;
  }

  function populateIntervalSelect(select, value) {
    select.innerHTML = '';
    for (let n = -7; n <= 4; n++) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = intervalLabel(n);
      if (n === value) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function renderBanner(status) {
    const el = document.getElementById('banner');
    if (status.error) {
      el.className = 'banner banner-error';
      el.textContent = 'ptp4l failed to apply the current configuration: ' + status.error;
      return;
    }
    if (!status.ptp4l_running) {
      el.className = 'banner banner-idle';
      el.textContent = 'ptp4l is not running. Enable at least one interface below.';
      return;
    }
    if (status.is_grandmaster) {
      el.className = 'banner banner-gm';
      el.textContent = 'This device is the Grandmaster'
        + (status.clock_identity ? ` (${status.clock_identity})` : '');
      return;
    }
    if (status.gm_present) {
      el.className = 'banner banner-synced';
      const offset = status.master_offset_ns === null ? '?' : status.master_offset_ns;
      el.textContent = `Synced to grandmaster ${status.gm_identity || '?'}`
        + ` - ${status.steps_removed ?? '?'} hop(s), offset ${offset} ns`;
      return;
    }
    el.className = 'banner banner-unsynced';
    el.textContent = 'No grandmaster present on the uplink yet.';
  }

  function renderInterfaces(status) {
    const container = document.getElementById('interfaces');
    container.innerHTML = '';

    const phcGroups = {};
    let next = 0;
    (status.interfaces || []).forEach((iface) => {
      if (iface.phc_index !== null && !(iface.phc_index in phcGroups)) {
        phcGroups[iface.phc_index] = PHC_GROUP_LETTERS[next++] || '?';
      }
    });

    (status.interfaces || []).forEach((iface) => {
      const card = document.createElement('div');
      card.className = 'iface-card' + (iface.link ? ' link-up' : ' link-down');

      const title = document.createElement('h3');
      title.textContent = iface.name;
      card.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'iface-meta';
      const speed = iface.speed_mbps ? `${iface.speed_mbps} Mb/s` : 'no link';
      const hw = iface.phc_index !== null
        ? `HW clock ${phcGroups[iface.phc_index]} (#${iface.phc_index})`
        : 'software timestamping';
      meta.textContent = `${iface.driver || 'unknown driver'} - ${speed} - ${hw}`;
      card.appendChild(meta);

      if (iface.enabled && iface.port_state) {
        const state = document.createElement('span');
        state.className = 'port-state port-state-' + iface.port_state.toLowerCase();
        state.textContent = iface.port_state;
        card.appendChild(state);
      }

      const enabledLabel = document.createElement('label');
      enabledLabel.className = 'iface-toggle';
      const enabledInput = document.createElement('input');
      enabledInput.type = 'checkbox';
      enabledInput.checked = iface.enabled;
      enabledInput.dataset.iface = iface.name;
      enabledInput.dataset.field = 'enabled';
      enabledLabel.appendChild(enabledInput);
      enabledLabel.appendChild(document.createTextNode(' Enable PTP'));
      card.appendChild(enabledLabel);

      const roles = document.createElement('div');
      roles.className = 'iface-roles';
      [['uplink', 'Uplink (listen for GM)'], ['downstream', 'Downstream']].forEach(([role, label]) => {
        const wrap = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'role-' + iface.name;
        input.value = role;
        input.checked = iface.role === role;
        input.dataset.iface = iface.name;
        input.dataset.field = 'role';
        wrap.appendChild(input);
        wrap.appendChild(document.createTextNode(' ' + label));
        roles.appendChild(wrap);
      });
      card.appendChild(roles);

      container.appendChild(card);
    });
  }

  function renderSettings(cfg) {
    const form = document.getElementById('settings-form');
    form.domainNumber.value = cfg.domainNumber;
    form.priority1.value = cfg.priority1;
    form.priority2.value = cfg.priority2;
    populateIntervalSelect(form.logAnnounceInterval, cfg.logAnnounceInterval);
    populateIntervalSelect(form.logSyncInterval, cfg.logSyncInterval);
    populateIntervalSelect(form.logMinDelayReqInterval, cfg.logMinDelayReqInterval);
  }

  function collectInterfaces() {
    const interfaces = {};
    document.querySelectorAll('#interfaces .iface-card').forEach((card) => {
      const checkbox = card.querySelector('input[data-field="enabled"]');
      const role = card.querySelector('input[data-field="role"]:checked');
      interfaces[checkbox.dataset.iface] = {
        enabled: checkbox.checked,
        role: role ? role.value : 'downstream',
      };
    });
    return interfaces;
  }

  function initChart() {
    const ctx = document.getElementById('offset-chart');
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Offset from GM (ns)',
          data: [],
          borderColor: '#3b82f6',
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.1,
        }],
      },
      options: {
        animation: false,
        scales: {
          y: { title: { display: true, text: 'nanoseconds' } },
        },
      },
    });
  }

  async function refreshStatus() {
    const { ok, data } = await fetchJSON('ajax.php?action=status');
    if (!ok) return;
    renderBanner(data);
    renderInterfaces(data);
  }

  async function refreshHistory() {
    const { ok, data } = await fetchJSON('ajax.php?action=history&minutes=60');
    if (!ok || !Array.isArray(data)) return;
    chart.data.labels = data.map((p) => new Date(p.ts * 1000).toLocaleTimeString());
    chart.data.datasets[0].data = data.map((p) => p.offset_ns);
    chart.update('none');
  }

  document.getElementById('interfaces').addEventListener('change', (e) => {
    if (e.target.dataset.field === 'role' && e.target.value === 'uplink') {
      document.querySelectorAll('input[data-field="role"][value="uplink"]').forEach((input) => {
        if (input !== e.target) {
          const card = input.closest('.iface-card');
          card.querySelector('input[data-field="role"][value="downstream"]').checked = true;
        }
      });
    }
  });

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = document.getElementById('save-status');
    const body = {
      csrf: csrfToken,
      domainNumber: parseInt(form.domainNumber.value, 10),
      priority1: parseInt(form.priority1.value, 10),
      priority2: parseInt(form.priority2.value, 10),
      logAnnounceInterval: parseInt(form.logAnnounceInterval.value, 10),
      logSyncInterval: parseInt(form.logSyncInterval.value, 10),
      logMinDelayReqInterval: parseInt(form.logMinDelayReqInterval.value, 10),
      interfaces: collectInterfaces(),
    };

    status.textContent = 'Saving...';
    const { ok, data } = await fetchJSON('ajax.php?action=config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (ok) {
      status.textContent = 'Saved.';
      refreshStatus();
    } else {
      status.textContent = 'Error: ' + (data.error || 'failed to save');
    }
  });

  async function init() {
    initChart();
    const { ok, data } = await fetchJSON('ajax.php?action=config');
    if (ok) renderSettings(data);
    await refreshStatus();
    await refreshHistory();
    setInterval(refreshStatus, 3000);
    setInterval(refreshHistory, 5000);
  }

  init();
})();
