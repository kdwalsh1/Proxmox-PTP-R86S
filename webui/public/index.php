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
  <link rel="stylesheet" href="assets/css/style.css">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
</head>
<body>
  <header class="topbar">
    <h1>PTP Control</h1>
    <a href="logout.php">Log out</a>
  </header>

  <main>
    <section id="gps-panel" style="display:none">
      <h2>GPS grandmaster source</h2>
      <div id="gps-summary" class="gps-summary"></div>
      <div id="gps-map" class="gps-map"></div>
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

  <script src="assets/js/app.js"></script>
</body>
</html>
