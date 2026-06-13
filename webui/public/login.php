<?php
$config = require __DIR__ . '/../includes/config.php';
require_once __DIR__ . '/../includes/auth.php';
auth_start_session();

if (auth_check()) {
    header('Location: /index.php');
    exit;
}

$error = '';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!csrf_verify($_POST['csrf'] ?? null)) {
        $error = 'Invalid request, please try again.';
    } elseif (auth_attempt($config, $_POST['password'] ?? '')) {
        header('Location: /index.php');
        exit;
    } else {
        $error = 'Incorrect password.';
    }
}

$csrf = csrf_token();
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PTP Control - Login</title>
  <link rel="stylesheet" href="assets/css/style.css">
</head>
<body class="login-body">
  <form class="login-form" method="post">
    <h1>PTP Control</h1>
    <?php if ($error !== ''): ?>
      <p class="error"><?= htmlspecialchars($error) ?></p>
    <?php endif; ?>
    <input type="hidden" name="csrf" value="<?= htmlspecialchars($csrf) ?>">
    <label>
      Password
      <input type="password" name="password" autofocus required>
    </label>
    <button type="submit">Log in</button>
  </form>
</body>
</html>
