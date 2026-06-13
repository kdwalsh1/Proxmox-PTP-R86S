<?php
/**
 * Thin client for the host-side ptp-agent HTTP API. Keeps the bearer
 * token server-side - the browser only ever talks to ajax.php.
 */

function agent_request(array $config, string $method, string $path, ?array $body = null): array
{
    $url = $config['agent']['url'] . $path;
    $header = 'Authorization: Bearer ' . $config['agent']['token'];

    $opts = [
        'http' => [
            'method' => $method,
            'header' => $header,
            'timeout' => 5,
            'ignore_errors' => true,
        ],
    ];

    if ($body !== null) {
        $opts['http']['header'] .= "\r\nContent-Type: application/json";
        $opts['http']['content'] = json_encode($body);
    }

    $context = stream_context_create($opts);
    $result = @file_get_contents($url, false, $context);

    $status = 0;
    if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', $http_response_header[0], $m)) {
        $status = (int) $m[1];
    }

    if ($result === false) {
        return [0, ['error' => 'agent unreachable']];
    }

    $data = json_decode($result, true);
    if (!is_array($data)) {
        $data = ['error' => 'invalid response from agent'];
    }

    return [$status, $data];
}

function agent_get(array $config, string $path): array
{
    return agent_request($config, 'GET', $path);
}

function agent_post(array $config, string $path, array $body): array
{
    return agent_request($config, 'POST', $path, $body);
}
