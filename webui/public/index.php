<?php
require_once __DIR__ . '/../includes/auth.php';
auth_start_session();
auth_require_login();
$csrf = csrf_token();
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf" content="<?= htmlspecialchars($csrf) ?>">
  <title>PTP Control</title>
  <link rel="stylesheet" href="assets/css/style.css?v=1794060000">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
</head>
<body>
  <header class="topbar">
    <h1>PTP Control</h1>
    <a href="logout.php">Log out</a>
  </header>

  <main>
    <section id="gps-panel" style="display:none">
  <h2>GPS Grandmaster & Satellite Telemetry</h2>
  <div id="gps-summary" class="gps-summary"></div>

  <div class="gps-visual-card survey-card">
    <h3>Survey-in (timing mode)</h3>
    <p class="survey-note">When the antenna is permanently fixed and the position plot has settled,
      survey-in gives better timing: the receiver averages its position, then holds it fixed and
      solves for time only, giving a steadier PPS through satellite handovers.
      Re-run it after moving the antenna.</p>
    <div id="survey-status" class="banner banner-idle">Checking receiver...</div>
    <form id="survey-form" class="survey-form">
      <label>Minimum duration (hours)
        <input type="number" name="min_hours" min="1" max="168" step="1" value="24">
      </label>
      <label>Accuracy target (m)
        <input type="number" name="acc_m" min="0.5" max="50" step="0.5" value="5">
      </label>
      <div class="settings-actions">
        <button type="submit" id="survey-start">Start survey-in</button>
        <button type="button" id="survey-stop">Stop (navigation mode)</button>
        <span id="survey-msg"></span>
      </div>
    </form>
  </div>

  <div class="gps-visual-card survey-card">
    <h3>Constellations</h3>
    <p class="survey-note">More satellites help when the sky view is restricted. The receiver tracks GPS
      plus up to two of GLONASS, Galileo and BeiDou. Applying a change restarts tracking: expect the
      fix and PPS to drop for up to a minute (the grandmaster advertises clockClass 248 until it
      relocks), and changing Galileo also resets the receiver.</p>
    <div id="gnss-status" class="banner banner-idle">Checking receiver...</div>
    <form id="gnss-form" class="survey-form">
      <label class="gnss-check"><input type="checkbox" name="GPS" checked disabled> GPS (always on)</label>
      <label class="gnss-check"><input type="checkbox" name="GLONASS" data-major="1"> GLONASS</label>
      <label class="gnss-check"><input type="checkbox" name="GALILEO" data-major="1"> Galileo</label>
      <label class="gnss-check"><input type="checkbox" name="BEIDOU" data-major="1"> BeiDou</label>
      <label class="gnss-check"><input type="checkbox" name="SBAS"> SBAS</label>
      <div class="settings-actions">
        <button type="submit" id="gnss-apply">Apply constellations</button>
        <span id="gnss-msg"></span>
      </div>
    </form>
  </div>
  
  <style>
    .sat-table th, .sat-table td { padding: 6px 12px; border-bottom: 1px solid #334155; }
    .gps-visuals-grid { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .gps-visual-card { flex: 1; min-width: 320px; background: var(--card-bg, #1e293b); padding: 1rem; border-radius: 8px; }
    /* Force all non-skymap charts (like PTP graphs) to be taller */
     
  </style>
  
  <div class="gps-visuals-grid">
    <!-- Enlarged Sky Map -->
    <div class="gps-visual-card" style="flex: 0 1 auto; display: flex; flex-direction: column; align-items: center;">
      <h3>Sky View (Azimuth / Elevation)</h3>
      <canvas id="gps-skymap" width="320" height="320"></canvas>
      <div id="gps-skymap-legend" class="skymap-legend" style="margin-top: 15px;">
        <span><span class="dot dot-used" style="color: #4ade80;">●</span> Used in fix</span>
        &nbsp;&nbsp;
        <span><span class="dot dot-visible" style="color: #94a3b8;">●</span> Visible / Masked</span>
      </div>
    </div>
    
    <!-- New Satellite List -->
    <div class="gps-visual-card">
      <h3>Satellite Details</h3>
      <div style="max-height: 420px; overflow-y: auto;">
        <table class="sat-table" id="sat-table" style="width: 100%; text-align: left; border-collapse: collapse;">
          <thead style="position: sticky; top: 0; background: #1e293b; z-index: 2;">
            <tr><th>PRN</th><th>System</th><th>Az</th><th>El</th><th>SNR</th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  </div>
  
  <!-- Full Width Map View -->
  <div class="gps-visual-card" style="width: 100%; margin-top: 1rem;">
    <h3>Position Drift / Multipath Wander</h3>
    <div id="gps-map" class="gps-map" style="height: 450px; border-radius: 8px;"></div>
  </div>
</section>

    <section>
      <h2>VLANs</h2>
      <div id="vlans" class="vlan-list"></div>
      <form id="vlan-form" class="vlan-form">
        <label>Parent interface
          <select name="parent" required></select>
        </label>
        <label>VLAN ID
          <input type="number" name="vlan_id" min="1" max="4094" required>
        </label>
        <div class="settings-actions">
          <button type="submit">Add VLAN</button>
          <span id="vlan-status"></span>
        </div>
      </form>
    </section>

    <section>
      <h2>Interfaces</h2>
      <div id="interfaces" class="iface-grid"></div>
    </section>

    <section>
      <h2>PTP profiles</h2>
      <div id="profiles"></div>
      <div class="settings-actions">
        <button id="add-profile" type="button">Add profile</button>
      </div>
    </section>

    <section>
      <h2>Clock synchronization</h2>
      <div id="phc2sys-info" class="phc2sys-info"></div>
    </section>

    <section class="save-bar">
      <div class="settings-actions">
        <button id="save-all" type="button">Save changes</button>
        <span id="save-status"></span>
      </div>
    </section>
  </main>

  <script src="assets/js/app.js?v=1794060000"></script>
</body>
</html>
