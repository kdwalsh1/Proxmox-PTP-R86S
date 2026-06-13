<?php
/**
 * Loads .env (if present) and returns a config array.
 * No external dependencies - tiny parser, good enough for KEY=VALUE / KEY="VALUE" lines.
 */

function load_env(string $path): array
{
    $values = [];
    if (!is_file($path)) {
        return $values;
    }

    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
            continue;
        }
        [$key, $value] = explode('=', $line, 2);
        $key = trim($key);
        $value = trim($value);
        if (strlen($value) >= 2 && $value[0] === '"' && str_ends_with($value, '"')) {
            $value = substr($value, 1, -1);
        }
        $values[$key] = $value;
    }

    return $values;
}

$env = load_env(__DIR__ . '/../.env');

function env(array $env, string $key, mixed $default = null): mixed
{
    return $env[$key] ?? $default;
}

return [
    'agent' => [
        'url' => rtrim(env($env, 'AGENT_URL', 'http://127.0.0.1:8081'), '/'),
        'token' => env($env, 'AGENT_TOKEN', ''),
    ],
    'auth' => [
        'password_hash' => env($env, 'ADMIN_PASSWORD_HASH', ''),
    ],
];
