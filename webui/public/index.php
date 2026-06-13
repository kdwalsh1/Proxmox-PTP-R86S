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
    <div id="banner" class="banner">Loading status...</div>

    <section>
      <h2>Interfaces</h2>
      <div id="interfaces" class="iface-grid"></div>
    </section>

    <section>
      <h2>Global PTP settings</h2>
      <form id="settings-form" class="settings-form">
        <label>Domain number
          <input type="number" name="domainNumber" min="0" max="127" required>
        </label>
        <label>Priority 1
          <input type="number" name="priority1" min="0" max="255" required>
        </label>
        <label>Priority 2
          <input type="number" name="priority2" min="0" max="255" required>
        </label>
        <label>Announce interval
          <select name="logAnnounceInterval"></select>
        </label>
        <label>Sync interval
          <select name="logSyncInterval"></select>
        </label>
        <label>Min delay request interval
          <select name="logMinDelayReqInterval"></select>
        </label>
        <div class="settings-actions">
          <button type="submit">Save</button>
          <span id="save-status"></span>
        </div>
      </form>
    </section>

    <section>
      <h2>Offset from grandmaster</h2>
      <canvas id="offset-chart" height="100"></canvas>
    </section>
  </main>

  <script src="assets/js/app.js"></script>
</body>
</html>
