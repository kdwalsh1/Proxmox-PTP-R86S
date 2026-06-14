(function () {
  const csrfToken = document.querySelector('meta[name="csrf"]').content;
  const PHC_GROUP_LETTERS = 'ABCDEFGH';
  let charts = {};
  let phcGroups = {};
  let savedConfig = { vlans: {}, profiles: {} };
  let rendered = false;

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

  function renderBanner(status, el) {
    if (status.error) {
      el.className = 'banner banner-error';
      el.textContent = 'ptp4l failed to apply the current configuration: ' + status.error;
      return;
    }
    if (!status.ptp4l_running) {
      el.className = 'banner banner-idle';
      el.textContent = 'ptp4l is not running. Enable at least one interface for this profile below.';
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

  function computePhcGroups(interfaces) {
    const groups = {};
    let next = 0;
    (interfaces || []).forEach((iface) => {
      if (iface.phc_index !== null && !(iface.phc_index in groups)) {
        groups[iface.phc_index] = PHC_GROUP_LETTERS[next++] || '?';
      }
    });
    return groups;
  }

  function ifaceMetaText(iface) {
    const speed = iface.speed_mbps ? `${iface.speed_mbps} Mb/s` : 'no link';
    const hw = iface.phc_index !== null
      ? `HW clock ${phcGroups[iface.phc_index]} (#${iface.phc_index})`
      : 'software timestamping';
    const addrs = (iface.addresses && iface.addresses.length) ? ` - ${iface.addresses.join(', ')}` : '';
    if (iface.is_vlan) {
      return `VLAN of ${iface.parent} - ${speed} - ${hw}${addrs}`;
    }
    return `${iface.driver || 'unknown driver'} - ${speed} - ${hw}${addrs}`;
  }

  function updateRoleVisibility(card) {
    const profile = card.querySelector('select[data-field="profile"]').value;
    card.querySelector('.iface-roles').style.display = profile ? '' : 'none';
  }

  // Builds the interface grid from scratch. Only called on initial load and
  // after a successful save, so it doesn't clobber in-progress edits -
  // periodic status polls go through updateInterfaceBadges instead.
  function renderInterfaces(status) {
    const container = document.getElementById('interfaces');
    container.innerHTML = '';
    phcGroups = computePhcGroups(status.interfaces);
    const profileNames = Object.keys(status.profiles || {});

    (status.interfaces || []).forEach((iface) => {
      const card = document.createElement('div');
      card.className = 'iface-card' + (iface.link ? ' link-up' : ' link-down');
      card.dataset.iface = iface.name;

      const title = document.createElement('h3');
      title.textContent = iface.name;
      card.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'iface-meta';
      meta.textContent = ifaceMetaText(iface);
      card.appendChild(meta);

      const state = document.createElement('span');
      state.className = 'port-state';
      state.style.display = 'none';
      card.appendChild(state);

      const profileLabel = document.createElement('label');
      profileLabel.className = 'iface-profile';
      profileLabel.appendChild(document.createTextNode('Profile '));
      const profileSelect = document.createElement('select');
      profileSelect.dataset.iface = iface.name;
      profileSelect.dataset.field = 'profile';
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = 'Unassigned';
      profileSelect.appendChild(noneOpt);
      profileNames.forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (iface.profile === name) opt.selected = true;
        profileSelect.appendChild(opt);
      });
      profileLabel.appendChild(profileSelect);
      card.appendChild(profileLabel);

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

      const transportLabel = document.createElement('label');
      transportLabel.className = 'iface-transport';
      transportLabel.appendChild(document.createTextNode('Transport '));
      const transportSelect = document.createElement('select');
      transportSelect.dataset.iface = iface.name;
      transportSelect.dataset.field = 'transport';
      [['UDPv4', 'IPv4 (UDPv4)'], ['UDPv6', 'IPv6 (UDPv6)'], ['L2', 'Ethernet (L2)']].forEach(([value, label]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        if ((iface.networkTransport || 'UDPv4') === value) opt.selected = true;
        transportSelect.appendChild(opt);
      });
      transportLabel.appendChild(transportSelect);
      roles.appendChild(transportLabel);

      const unicastListenLabel = document.createElement('label');
      unicastListenLabel.className = 'iface-toggle';
      const unicastListenInput = document.createElement('input');
      unicastListenInput.type = 'checkbox';
      unicastListenInput.checked = !!iface.unicastListen;
      unicastListenInput.dataset.iface = iface.name;
      unicastListenInput.dataset.field = 'unicastListen';
      unicastListenLabel.appendChild(unicastListenInput);
      unicastListenLabel.appendChild(document.createTextNode(' Allow unicast clients (this device can act as a unicast master)'));
      roles.appendChild(unicastListenLabel);

      const targetsLabel = document.createElement('label');
      targetsLabel.className = 'iface-unicast-targets';
      targetsLabel.appendChild(document.createTextNode('Unicast master targets (one address per line)'));
      const targetsArea = document.createElement('textarea');
      targetsArea.dataset.iface = iface.name;
      targetsArea.dataset.field = 'unicastTargets';
      targetsArea.rows = 2;
      targetsArea.value = (iface.unicastTargets || []).join('\n');
      const setTargetsPlaceholder = () => {
        const t = transportSelect.value;
        targetsArea.placeholder = t === 'UDPv6' ? 'e.g. 2001:db8::1'
          : t === 'L2' ? 'e.g. 00:11:22:33:44:55'
          : 'e.g. 192.0.2.1';
      };
      setTargetsPlaceholder();
      transportSelect.addEventListener('change', setTargetsPlaceholder);
      targetsLabel.appendChild(targetsArea);
      roles.appendChild(targetsLabel);

      card.appendChild(roles);

      profileSelect.addEventListener('change', () => updateRoleVisibility(card));
      updateRoleVisibility(card);

      container.appendChild(card);
    });

    updateInterfaceBadges(status);
  }

  // Updates the read-only parts of each card (link state, speed, port
  // state) on every status poll, without touching the profile select,
  // enable checkbox, or role radios so unsaved user changes survive until
  // Save is clicked.
  function updateInterfaceBadges(status) {
    (status.interfaces || []).forEach((iface) => {
      const card = document.querySelector(`#interfaces .iface-card[data-iface="${iface.name}"]`);
      if (!card) return;

      card.classList.toggle('link-up', !!iface.link);
      card.classList.toggle('link-down', !iface.link);

      const meta = card.querySelector('.iface-meta');
      if (meta) meta.textContent = ifaceMetaText(iface);

      const state = card.querySelector('.port-state');
      if (!state) return;
      if (iface.enabled && iface.port_state) {
        state.className = 'port-state port-state-' + iface.port_state.toLowerCase();
        state.textContent = iface.port_state;
        state.style.display = '';
      } else {
        state.className = 'port-state';
        state.textContent = '';
        state.style.display = 'none';
      }
    });
  }

  function renderVlans(status) {
    const container = document.getElementById('vlans');
    container.innerHTML = '';

    const vlans = status.vlans || [];
    if (!vlans.length) {
      container.innerHTML = '<p class="empty-hint">No VLANs configured.</p>';
    }
    vlans.forEach((vlan) => {
      const row = document.createElement('div');
      row.className = 'vlan-row';
      row.dataset.vlan = vlan.name;

      const label = document.createElement('span');
      label.textContent = `${vlan.name} - VLAN ${vlan.vlan_id} on ${vlan.parent}`
        + (vlan.exists ? '' : ' (creating...)');
      row.appendChild(label);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => removeVlan(vlan.name));
      row.appendChild(removeBtn);

      container.appendChild(row);
    });

    const parentSelect = document.querySelector('#vlan-form select[name="parent"]');
    const previous = parentSelect.value;
    parentSelect.innerHTML = '';
    (status.interfaces || []).filter((i) => !i.is_vlan).forEach((iface) => {
      const opt = document.createElement('option');
      opt.value = iface.name;
      opt.textContent = iface.name;
      parentSelect.appendChild(opt);
    });
    if (previous) parentSelect.value = previous;
  }

  function buildProfileCard(name, profile) {
    const card = document.createElement('div');
    card.className = 'profile-card';
    card.dataset.profile = name;

    const header = document.createElement('div');
    header.className = 'profile-header';
    const title = document.createElement('h3');
    title.textContent = name;
    header.appendChild(title);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove profile';
    removeBtn.addEventListener('click', () => removeProfile(name));
    header.appendChild(removeBtn);
    card.appendChild(header);

    const banner = document.createElement('div');
    banner.className = 'banner profile-banner';
    card.appendChild(banner);

    const form = document.createElement('div');
    form.className = 'settings-form profile-settings';
    form.dataset.profile = name;

    const fields = [
      ['domainNumber', 'Domain number', 'number', 0, 127],
      ['priority1', 'Priority 1', 'number', 0, 255],
      ['priority2', 'Priority 2', 'number', 0, 255],
      ['logAnnounceInterval', 'Announce interval', 'select'],
      ['logSyncInterval', 'Sync interval', 'select'],
      ['logMinDelayReqInterval', 'Min delay request interval', 'select'],
    ];
    fields.forEach(([key, labelText, type, lo, hi]) => {
      const label = document.createElement('label');
      label.appendChild(document.createTextNode(labelText));
      let input;
      if (type === 'select') {
        input = document.createElement('select');
        populateIntervalSelect(input, profile.config[key]);
      } else {
        input = document.createElement('input');
        input.type = 'number';
        input.min = String(lo);
        input.max = String(hi);
        input.value = String(profile.config[key]);
        input.required = true;
      }
      input.name = key;
      label.appendChild(input);
      form.appendChild(label);
    });
    card.appendChild(form);

    const canvas = document.createElement('canvas');
    canvas.id = `offset-chart-${name}`;
    canvas.height = 80;
    card.appendChild(canvas);

    renderBanner(profile, banner);
    return card;
  }

  // Builds the profile cards from scratch. Only called on initial load and
  // after a successful save - periodic status polls update banners only.
  function renderProfiles(status) {
    Object.values(charts).forEach((c) => c.destroy());
    charts = {};

    const container = document.getElementById('profiles');
    container.innerHTML = '';

    Object.entries(status.profiles || {}).forEach(([name, profile]) => {
      const card = buildProfileCard(name, profile);
      container.appendChild(card);
      initChart(name);
    });
  }

  function updatePhc2sysInfo(status) {
    const el = document.getElementById('phc2sys-info');
    const bridges = status.phc2sys || [];
    if (!bridges.length) {
      el.textContent = 'No clock bridging in use.';
      return;
    }
    el.innerHTML = '';
    bridges.forEach((b) => {
      const row = document.createElement('div');
      row.textContent = `${b.source} -> ${b.target}: ${b.active ? 'active' : 'inactive'}`;
      el.appendChild(row);
    });
  }

  function addProfileOption(name) {
    document.querySelectorAll('#interfaces select[data-field="profile"]').forEach((select) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
  }

  function removeProfileOption(name) {
    document.querySelectorAll('#interfaces select[data-field="profile"]').forEach((select) => {
      if (select.value === name) {
        select.value = '';
        updateRoleVisibility(select.closest('.iface-card'));
      }
      const opt = select.querySelector(`option[value="${name}"]`);
      if (opt) opt.remove();
    });
  }

  function removeProfile(name) {
    const card = document.querySelector(`#profiles .profile-card[data-profile="${name}"]`);
    if (card) card.remove();
    if (charts[name]) {
      charts[name].destroy();
      delete charts[name];
    }
    removeProfileOption(name);
  }

  function collectConfig() {
    const vlans = {};
    Object.entries(savedConfig.vlans || {}).forEach(([name, vcfg]) => {
      vlans[name] = { ...vcfg };
    });

    const profiles = {};
    document.querySelectorAll('#profiles .profile-settings').forEach((form) => {
      const name = form.dataset.profile;
      profiles[name] = {
        domainNumber: parseInt(form.querySelector('[name="domainNumber"]').value, 10),
        priority1: parseInt(form.querySelector('[name="priority1"]').value, 10),
        priority2: parseInt(form.querySelector('[name="priority2"]').value, 10),
        logAnnounceInterval: parseInt(form.querySelector('[name="logAnnounceInterval"]').value, 10),
        logSyncInterval: parseInt(form.querySelector('[name="logSyncInterval"]').value, 10),
        logMinDelayReqInterval: parseInt(form.querySelector('[name="logMinDelayReqInterval"]').value, 10),
        interfaces: {},
      };
    });

    document.querySelectorAll('#interfaces .iface-card').forEach((card) => {
      const name = card.dataset.iface;
      const profile = card.querySelector('select[data-field="profile"]').value;
      if (!profile || !(profile in profiles)) return;
      const enabled = card.querySelector('input[data-field="enabled"]').checked;
      const roleInput = card.querySelector('input[data-field="role"]:checked');
      const unicastTargets = card.querySelector('textarea[data-field="unicastTargets"]').value
        .split('\n').map((s) => s.trim()).filter(Boolean);
      profiles[profile].interfaces[name] = {
        enabled,
        role: roleInput ? roleInput.value : 'downstream',
        networkTransport: card.querySelector('select[data-field="transport"]').value,
        unicastListen: card.querySelector('input[data-field="unicastListen"]').checked,
        unicastTargets,
      };
    });

    return { vlans, profiles };
  }

  async function saveConfig(body, statusElId) {
    const statusEl = document.getElementById(statusElId);
    if (statusEl) statusEl.textContent = 'Saving...';

    const { ok, data } = await fetchJSON('ajax.php?action=config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csrf: csrfToken, vlans: body.vlans, profiles: body.profiles }),
    });

    if (!ok) {
      if (statusEl) statusEl.textContent = 'Error: ' + (data.error || 'failed to save');
      return false;
    }

    if (statusEl) statusEl.textContent = 'Saved.';
    const cfg = await fetchJSON('ajax.php?action=config');
    if (cfg.ok) savedConfig = cfg.data;
    await refreshStatus(true);
    return true;
  }

  async function removeVlan(name) {
    const cfg = collectConfig();
    delete cfg.vlans[name];
    Object.values(cfg.profiles).forEach((p) => { delete p.interfaces[name]; });
    await saveConfig(cfg, 'vlan-status');
  }

  function initChart(name) {
    const ctx = document.getElementById(`offset-chart-${name}`);
    charts[name] = new Chart(ctx, {
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

  async function refreshHistory(name) {
    const chart = charts[name];
    if (!chart) return;
    const { ok, data } = await fetchJSON(`ajax.php?action=history&minutes=60&profile=${encodeURIComponent(name)}`);
    if (!ok || !Array.isArray(data)) return;
    chart.data.labels = data.map((p) => new Date(p.ts * 1000).toLocaleTimeString());
    chart.data.datasets[0].data = data.map((p) => p.offset_ns);
    chart.update('none');
  }

  async function refreshAllHistory() {
    await Promise.all(Object.keys(charts).map(refreshHistory));
  }

  async function refreshStatus(forceRender) {
    const { ok, data } = await fetchJSON('ajax.php?action=status');
    if (!ok) return;

    if (forceRender || !rendered) {
      renderVlans(data);
      renderInterfaces(data);
      renderProfiles(data);
      updatePhc2sysInfo(data);
      rendered = true;
      await refreshAllHistory();
    } else {
      updateInterfaceBadges(data);
      Object.entries(data.profiles || {}).forEach(([name, profile]) => {
        const card = document.querySelector(`#profiles .profile-card[data-profile="${name}"]`);
        if (!card) return;
        const banner = card.querySelector('.profile-banner');
        if (banner) renderBanner(profile, banner);
      });
      updatePhc2sysInfo(data);
    }
  }

  document.getElementById('interfaces').addEventListener('change', (e) => {
    if (e.target.dataset.field === 'role' && e.target.value === 'uplink') {
      const card = e.target.closest('.iface-card');
      const profile = card.querySelector('select[data-field="profile"]').value;
      document.querySelectorAll('#interfaces .iface-card').forEach((other) => {
        if (other === card) return;
        if (other.querySelector('select[data-field="profile"]').value !== profile) return;
        const otherUplink = other.querySelector('input[data-field="role"][value="uplink"]');
        const otherDownstream = other.querySelector('input[data-field="role"][value="downstream"]');
        if (otherUplink && otherUplink.checked) otherDownstream.checked = true;
      });
    }
  });

  document.getElementById('vlan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const parent = form.parent.value;
    const vlanId = parseInt(form.vlan_id.value, 10);
    const status = document.getElementById('vlan-status');
    if (!parent || !Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) {
      status.textContent = 'Enter a valid VLAN ID (1-4094).';
      return;
    }
    const name = `${parent}.${vlanId}`;
    const cfg = collectConfig();
    if (cfg.vlans[name]) {
      status.textContent = `${name} already exists.`;
      return;
    }
    cfg.vlans[name] = { parent, vlan_id: vlanId };
    const ok = await saveConfig(cfg, 'vlan-status');
    if (ok) form.vlan_id.value = '';
  });

  document.getElementById('add-profile').addEventListener('click', () => {
    let name = prompt('Profile name (letters, digits, - and _, up to 32 chars):');
    if (!name) return;
    name = name.trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
      alert('Invalid profile name - use only letters, digits, - and _, up to 32 characters.');
      return;
    }
    if (document.querySelector(`#profiles .profile-card[data-profile="${name}"]`)) {
      alert('A profile with that name already exists.');
      return;
    }

    const used = new Set();
    document.querySelectorAll('#profiles .profile-settings').forEach((form) => {
      used.add(parseInt(form.querySelector('[name="domainNumber"]').value, 10));
    });
    let domain = 0;
    while (used.has(domain) && domain <= 127) domain++;

    const profile = {
      config: {
        domainNumber: domain,
        priority1: 128,
        priority2: 128,
        logAnnounceInterval: 1,
        logSyncInterval: 0,
        logMinDelayReqInterval: 0,
      },
      ptp4l_running: false,
    };

    document.getElementById('profiles').appendChild(buildProfileCard(name, profile));
    initChart(name);
    addProfileOption(name);
  });

  document.getElementById('save-all').addEventListener('click', async () => {
    await saveConfig(collectConfig(), 'save-status');
  });

  async function init() {
    const cfg = await fetchJSON('ajax.php?action=config');
    if (cfg.ok) savedConfig = cfg.data;
    await refreshStatus(true);
    setInterval(() => refreshStatus(false), 3000);
    setInterval(refreshAllHistory, 5000);
  }

  init();
})();
