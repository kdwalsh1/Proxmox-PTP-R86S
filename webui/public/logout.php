<?php
require_once __DIR__ . '/../includes/auth.php';
auth_start_session();
auth_logout();
header('Location: /login.php');
