<?php
/**
 * Single JSON endpoint proxying the host ptp-agent API.
 * ?action=status|history|config (config also accepts POST)
 */

$config = require __DIR__ . '/../includes/config.php';
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/agent_client.php';

auth_start_session();
header('Content-Type: application/json');

if (!auth_check()) {
    http_response_code(401);
    echo json_encode(['error' => 'unauthorized']);
    exit;
}

$action = $_GET['action'] ?? '';

switch ($action) {
    case 'status':
        [$status, $data] = agent_get($config, '/api/status');
        http_response_code($status ?: 502);
        echo json_encode($data);
        break;

    case 'history':
        $minutes = isset($_GET['minutes']) ? (int) $_GET['minutes'] : 60;
        $minutes = max(1, min($minutes, 48 * 60));
        $profile = $_GET['profile'] ?? '';
        $query = '/api/history?minutes=' . $minutes . '&profile=' . rawurlencode($profile);
        [$status, $data] = agent_get($config, $query);
        http_response_code($status ?: 502);
        echo json_encode($data);
        break;

    case 'config':
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $body = json_decode(file_get_contents('php://input'), true);
            if (!is_array($body) || !csrf_verify($body['csrf'] ?? null)) {
                http_response_code(400);
                echo json_encode(['error' => 'invalid request']);
                break;
            }
            unset($body['csrf']);
            [$status, $data] = agent_post($config, '/api/config', $body);
            http_response_code($status ?: 502);
            echo json_encode($data);
        } else {
            [$status, $data] = agent_get($config, '/api/config');
            http_response_code($status ?: 502);
            echo json_encode($data);
        }
        break;

    default:
        http_response_code(404);
        echo json_encode(['error' => 'unknown action']);
}
