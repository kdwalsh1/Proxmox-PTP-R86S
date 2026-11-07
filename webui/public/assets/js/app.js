
window.renderSatTable = function(sats) {
  try {
    const tbody = document.querySelector('#sat-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!sats || !Array.isArray(sats)) return;
    
    const sorted = sats.slice().sort((a,b) => b.ss - a.ss);
    sorted.forEach(s => {
      const tr = document.createElement('tr');
      tr.style.color = s.used ? '#4ade80' : '#94a3b8';
      let sys = 'Other';
      if (s.PRN >= 1 && s.PRN <= 32) sys = 'GPS';
      else if (s.PRN >= 33 && s.PRN <= 64) sys = 'SBAS';
      else if (s.PRN >= 65 && s.PRN <= 96) sys = 'GLONASS';
      else if (s.PRN >= 120 && s.PRN <= 158) sys = 'SBAS';
      else if (s.PRN >= 159 && s.PRN <= 210) sys = 'BeiDou';
      else if (s.PRN >= 211 && s.PRN <= 246) sys = 'Galileo';
      
      tr.innerHTML = `<td>${s.PRN}</td><td>${sys}</td><td>${s.az}&deg;</td><td>${s.el}&deg;</td><td>${s.ss} dB</td>`;
      tbody.appendChild(tr);
    });
  } catch(e) { console.error("SatTable error:", e); }
};

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
    if (iface.is_vlan) {
      return `VLAN of ${iface.parent} - ${speed} - ${hw}`;
    }
    return `${iface.driver || 'unknown driver'} - ${speed} - ${hw}`;
  }

  function updateRoleVisibility(card) {
    const profile = card.querySelector('select[data-field="profile"]').value;
    card.querySelector('.iface-roles').style.display = profile ? '' : 'none';
  }

  function profileClockSource(name) {
    const form = document.querySelector(`#profiles .profile-settings[data-profile="${name}"]`);
    const select = form && form.querySelector('[name="clockSource"]');
    return select ? select.value : 'uplink';
  }

  // A profile sourced from local GPS/PPS is self-sourced - it can't also
  // have an uplink (the agent rejects that server-side too, see
  // validate_desired() in ptp-agent.py). Disable the uplink radio on every
  // interface currently assigned to such a profile as a client-side hint.
  function updateClockSourceVisibility(name) {
    const isGps = profileClockSource(name) === 'gps';
    document.querySelectorAll('#interfaces .iface-card').forEach((card) => {
      if (card.querySelector('select[data-field="profile"]').value !== name) return;
      const uplinkInput = card.querySelector('input[data-field="role"][value="uplink"]');
      const downstreamInput = card.querySelector('input[data-field="role"][value="downstream"]');
      if (!uplinkInput) return;
      uplinkInput.disabled = isGps;
      uplinkInput.closest('label').classList.toggle('role-disabled', isGps);
      if (isGps && uplinkInput.checked) downstreamInput.checked = true;
    });
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
      card.appendChild(roles);

      profileSelect.addEventListener('change', () => {
        updateRoleVisibility(card);
        updateClockSourceVisibility(profileSelect.value);
      });
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
      ['clockSource', 'Clock source', 'clocksource'],
    ];
    fields.forEach(([key, labelText, type, lo, hi]) => {
      const label = document.createElement('label');
      label.appendChild(document.createTextNode(labelText));
      let input;
      if (type === 'select') {
        input = document.createElement('select');
        populateIntervalSelect(input, profile.config[key]);
      } else if (type === 'clocksource') {
        input = document.createElement('select');
        [['uplink', 'Uplink interface'], ['gps', 'Local GPS + PPS']].forEach(([value, text]) => {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = text;
          if (profile.config[key] === value) opt.selected = true;
          input.appendChild(opt);
        });
        input.addEventListener('change', () => updateClockSourceVisibility(name));
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

    // Interfaces are rendered before profiles, so re-apply clock-source
    // driven uplink-disabling now that the profile cards actually exist.
    Object.keys(status.profiles || {}).forEach(updateClockSourceVisibility);
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

  // Leaflet is only needed on boxes with a local GPS source (the Pi5, not
  // the R86S), so it's loaded from CDN lazily on first GPS data rather
  // than unconditionally in index.php.
  let leafletLoading = null;
  function ensureLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.onload = resolve;
      document.head.appendChild(script);
    });
    return leafletLoading;
  }

  const FIX_MODE_LABELS = { 0: 'Unknown', 1: 'No fix', 2: '2D fix', 3: '3D fix' };
  // --- GPS Diagnostics & Wander State ---
let gpsMap = null;
let gpsMarker = null;
let gpsWanderTrail = null;
let gpsErrorCircle = null;
const GPS_TRAIL_MAX_POINTS = 120;
const gpsHistory = [];

/**
 * Draws polar sky projection on the canvas.
 * Projects satellites using:
 *   r = R * cos(elevation) or linear r = R * (1 - el/90)
 *   theta = (azimuth - 90 deg) in radians
 */
window.renderSkyMap = renderSkyMap;
function renderSkyMap(satellites) {
  const canvas = document.getElementById('gps-skymap');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const cx = width / 2;
  const cy = height / 2;
  const maxR = (width / 2) - 20;

  ctx.clearRect(0, 0, width, height);

  // Background disk
  ctx.fillStyle = '#11141a';
  ctx.beginPath();
  ctx.arc(cx, cy, maxR, 0, 2 * Math.PI);
  ctx.fill();

  // Concentric Elevation Rings: 0° (horizon), 30°, 60°
  ctx.strokeStyle = '#4a5568';
  ctx.lineWidth = 1;
  [0, 30, 60].forEach((el) => {
    const r = maxR * (1 - el / 90);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.stroke();

    // Elevation degree label
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '9px monospace';
    ctx.fillText(`${el}°`, cx + 3, cy - r + 10);
  });

  // Crosshairs: N-S, E-W
  ctx.beginPath();
  ctx.moveTo(cx, cy - maxR);
  ctx.lineTo(cx, cy + maxR);
  ctx.moveTo(cx - maxR, cy);
  ctx.lineTo(cx + maxR, cy);
  ctx.stroke();

  // Cardinal Labels
  ctx.fillStyle = '#a0aec0';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - maxR + 9);
  ctx.fillText('S', cx, cy + maxR - 9);
  ctx.fillText('E', cx + maxR - 9, cy);
  ctx.fillText('W', cx - maxR + 9, cy);

  if (!Array.isArray(satellites) || satellites.length === 0) {
    ctx.fillStyle = '#718096';
    ctx.font = '12px sans-serif';
    ctx.fillText('No SV Data', cx, cy);
    return;
  }

  // Plot each Satellite
  satellites.forEach((sat) => {
    const az = sat.az !== undefined ? sat.az : 0;
    const el = sat.el !== undefined ? sat.el : 0;
    if (el < 0) return;

    // Linear projection from zenith (el=90 -> r=0) to horizon (el=0 -> r=maxR)
    const r = maxR * (1 - el / 90);
    const theta = (az - 90) * (Math.PI / 180);
    const x = cx + r * Math.cos(theta);
    const y = cy + r * Math.sin(theta);

    const isUsed = !!sat.used;
    const prn = String(sat.PRN || sat.svid || '?');
    const ss = sat.ss !== undefined && sat.ss !== null ? Math.round(sat.ss) : null;

    // Satellite Dot
    ctx.beginPath();
    ctx.arc(x, y, isUsed ? 6 : 4, 0, 2 * Math.PI);
    if (isUsed) {
      ctx.fillStyle = '#00e676';
      ctx.fill();
      ctx.strokeStyle = '#003311';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.fillStyle = '#374151';
      ctx.fill();
      ctx.strokeStyle = '#6b7280';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Label: PRN & SNR (dB-Hz)
    ctx.fillStyle = isUsed ? '#ffffff' : '#9ca3af';
    ctx.font = isUsed ? 'bold 10px monospace' : '9px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const label = ss !== null ? `${prn} (${ss})` : prn;
    ctx.fillText(label, x + 7, y - 2);
  });
}

/**
 * Updates the Leaflet map, position breadcrumb drift trail, and accuracy circle.
 */
async function renderGpsMap(lat, lon, eph) {
  await ensureLeaflet();
  const mapEl = document.getElementById('gps-map');
  if (!mapEl) return;

  // Add new fix to wander history
  gpsHistory.push([lat, lon]);
  if (gpsHistory.length > GPS_TRAIL_MAX_POINTS) {
    gpsHistory.shift();
  }

  if (!gpsMap) {
    // Initialize Leaflet instance
    gpsMap = L.map(mapEl, {
      zoomControl: true,
      attributionControl: false
    }).setView([lat, lon], 18);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20
    }).addTo(gpsMap);

    // Breadcrumb drift polyline
    gpsWanderTrail = L.polyline(gpsHistory, {
      color: '#e53e3e',
      weight: 2,
      opacity: 0.85,
      smoothFactor: 0
    }).addTo(gpsMap);

    // Accuracy circle (estimated horizontal error in meters)
    const errRadius = eph || 5;
    gpsErrorCircle = L.circle([lat, lon], {
      radius: errRadius,
      color: '#3182ce',
      fillColor: '#63b3ed',
      fillOpacity: 0.15,
      weight: 1
    }).addTo(gpsMap);

    // Live position pin
    gpsMarker = L.circleMarker([lat, lon], {
      radius: 5,
      color: '#ffffff',
      fillColor: '#3182ce',
      fillOpacity: 1,
      weight: 2
    }).addTo(gpsMap);
  } else {
    // Update live positions
    gpsMarker.setLatLng([lat, lon]);
    gpsWanderTrail.setLatLngs(gpsHistory);

    if (eph) {
      gpsErrorCircle.setLatLng([lat, lon]);
      gpsErrorCircle.setRadius(eph);
    }

    // Maintain focus on position without jarring manual pans
    if (!gpsMap.getBounds().contains([lat, lon])) {
      gpsMap.panTo([lat, lon]);
    }
  }
}

/**
 * Main update function called by your poll loop.
 */
  async function renderGpsPanel(status) {
    const panel = document.getElementById('gps-panel');
    const gps = status.gps;
    if (!gps) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';

    const summary = document.getElementById('gps-summary');
    summary.innerHTML = '';

    const locked = (gps.fix_mode || 0) >= 2;
    const fixBadge = document.createElement('span');
    fixBadge.className = 'banner ' + (locked ? 'banner-gm' : 'banner-unsynced');
    fixBadge.textContent = (FIX_MODE_LABELS[gps.fix_mode] || 'Unknown')
      + (gps.satellites_used !== null && gps.satellites_used !== undefined
        ? ` - ${gps.satellites_used}/${gps.satellites_visible} satellites` : '');
    summary.appendChild(fixBadge);

    const ppsBadge = document.createElement('span');
    ppsBadge.className = 'banner ' + (gps.pps_selected ? 'banner-gm' : gps.pps_reachable ? 'banner-unsynced' : 'banner-idle');
    ppsBadge.textContent = gps.pps_selected
      ? 'PPS selected (disciplining clock)'
      : gps.pps_reachable ? 'PPS reachable, not selected' : 'PPS not reachable';
    summary.appendChild(ppsBadge);

    const hasFix = gps.lat !== null && gps.lat !== undefined && gps.lon !== null && gps.lon !== undefined;
    const details = document.createElement('div');
    details.className = 'gps-details';
    details.textContent = hasFix
      ? `Lat ${gps.lat.toFixed(6)}, Lon ${gps.lon.toFixed(6)}`
        + (gps.alt_m !== null && gps.alt_m !== undefined ? `, Alt ${Number(gps.alt_m).toFixed(1)} m` : '')
        + (gps.gps_time ? ` - GPS time ${gps.gps_time}` : '')
      : 'No position fix yet.';
    summary.appendChild(details);
    updateSurveyPanel(gps.survey);
    const satellites = gps.satellites || [];
    if (window.renderSkyMap) window.renderSkyMap(satellites);
    if (window.renderSatTable) window.renderSatTable(satellites);

    if (!hasFix) return;

    await ensureLeaflet();
    const mapEl = document.getElementById('gps-map');
    if (!gpsMap) {
      gpsMap = L.map(mapEl).setView([gps.lat, gps.lon], 15);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(gpsMap);
      gpsMarker = L.marker([gps.lat, gps.lon]).addTo(gpsMap);
    } else {
      gpsMap.setView([gps.lat, gps.lon]);
      gpsMarker.setLatLng([gps.lat, gps.lon]);
    }
  }

  function formatDuration(s) {
    if (s === null || s === undefined) return null;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  let surveyBusy = false;

  function updateSurveyPanel(survey) {
    const el = document.getElementById('survey-status');
    const startBtn = document.getElementById('survey-start');
    const stopBtn = document.getElementById('survey-stop');
    if (!el) return;
    if (!survey) {
      el.className = 'banner banner-idle';
      el.textContent = 'Checking receiver...';
      return;
    }
    if (survey.error) {
      el.className = 'banner banner-error';
      el.textContent = survey.error;
    } else if (survey.state === 'off') {
      el.className = 'banner banner-idle';
      el.textContent = 'Off - navigation mode (solving position + time)';
    } else if (survey.state === 'surveying') {
      el.className = 'banner banner-unsynced';
      const parts = ['Surveying'];
      const elapsed = formatDuration(survey.elapsed_s);
      const minDur = formatDuration(survey.min_duration_s);
      if (elapsed) parts.push(`${elapsed} elapsed` + (minDur ? ` of min ${minDur}` : ''));
      if (survey.accuracy_m !== null && survey.accuracy_m !== undefined) {
        parts.push(`accuracy ${survey.accuracy_m} m` + (survey.acc_limit_m ? ` (target ${survey.acc_limit_m} m)` : ''));
      }
      if (survey.observations) parts.push(`${survey.observations} obs`);
      el.textContent = parts.join(' - ');
    } else if (survey.state === 'fixed') {
      el.className = 'banner banner-gm';
      el.textContent = 'Fixed position - time-only solution (timing mode active)';
    } else {
      el.className = 'banner banner-idle';
      el.textContent = 'Survey state unknown';
    }
    if (!surveyBusy) {
      startBtn.disabled = survey.state === 'surveying';
      stopBtn.disabled = survey.state === 'off';
    }
  }

  async function sendSurvey(body) {
    const msg = document.getElementById('survey-msg');
    surveyBusy = true;
    document.getElementById('survey-start').disabled = true;
    document.getElementById('survey-stop').disabled = true;
    msg.textContent = 'Sending to receiver...';
    try {
      const { ok, data } = await fetchJSON('ajax.php?action=survey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ csrf: csrfToken }, body)),
      });
      msg.textContent = ok ? 'Done - saved to receiver.' : (data.error || 'Failed');
      if (ok && data.survey) updateSurveyPanel(data.survey);
    } catch (e) {
      msg.textContent = 'Request failed';
    } finally {
      surveyBusy = false;
    }
  }

  document.getElementById('survey-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const minHours = parseFloat(form.min_hours.value);
    const accM = parseFloat(form.acc_m.value);
    if (!(minHours >= 1 && minHours <= 168) || !(accM >= 0.5 && accM <= 50)) {
      document.getElementById('survey-msg').textContent = 'Duration 1-168 h, accuracy 0.5-50 m.';
      return;
    }
    if (!confirm(`Start survey-in (min ${minHours} h, target ${accM} m)? This restarts any existing survey.`)) return;
    sendSurvey({ action: 'start', min_hours: minHours, acc_m: accM });
  });

  document.getElementById('survey-stop').addEventListener('click', () => {
    if (!confirm('Return the receiver to navigation mode? The surveyed position is discarded.')) return;
    sendSurvey({ action: 'stop' });
  });

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
        clockSource: form.querySelector('[name="clockSource"]').value,
        interfaces: {},
      };
    });

    document.querySelectorAll('#interfaces .iface-card').forEach((card) => {
      const name = card.dataset.iface;
      const profile = card.querySelector('select[data-field="profile"]').value;
      if (!profile || !(profile in profiles)) return;
      const enabled = card.querySelector('input[data-field="enabled"]').checked;
      const roleInput = card.querySelector('input[data-field="role"]:checked');
      profiles[profile].interfaces[name] = {
        enabled,
        role: roleInput ? roleInput.value : 'downstream',
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
    const { ok, data } = await fetchJSON('ajax.php?action=status&_t=' + Date.now());
    if (!ok) return;

    if (forceRender || !rendered) {
      renderVlans(data);
      renderInterfaces(data);
      renderProfiles(data);
      updatePhc2sysInfo(data);
      renderGpsPanel(data);
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
      renderGpsPanel(data);
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
        clockSource: 'uplink',
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
