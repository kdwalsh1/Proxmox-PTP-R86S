<?php
/**
 * Session-based login guard for the single local admin account.
 * Mirrors the session/CSRF handling used by radius-inventory's Auth class,
 * minus the LDAP dependency - the password hash comes from .env.
 */

function auth_start_session(): void
{
    if (session_status() === PHP_SESSION_NONE) {
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => '/',
            'secure' => !empty($_SERVER['HTTPS']),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        session_start();
    }
}

function auth_check(): bool
{
    return !empty($_SESSION['authenticated']);
}

function auth_require_login(): void
{
    if (!auth_check()) {
        header('Location: /login.php');
        exit;
    }
}

function auth_attempt(array $config, string $password): bool
{
    $hash = $config['auth']['password_hash'];
    if ($hash === '' || !password_verify($password, $hash)) {
        return false;
    }

    session_regenerate_id(true);
    $_SESSION['authenticated'] = true;

    return true;
}

function auth_logout(): void
{
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie('PHPSESSID', '', time() - 42000, $params['path'], $params['domain'], $params['secure'], $params['httponly']);
    }
    session_destroy();
}

function csrf_token(): string
{
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }

    return $_SESSION['csrf'];
}

function csrf_verify(?string $token): bool
{
    return is_string($token) && is_string($_SESSION['csrf'] ?? null) && hash_equals($_SESSION['csrf'], $token);
}
